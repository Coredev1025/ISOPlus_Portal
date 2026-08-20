import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { warn, info } from '../utils/logger.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../constants/automation.js';
import dotenv from 'dotenv';
import {
  applyPrivilegedSessionAuth,
  authorizeIsoplusUser,
  getRequestScope,
} from './authHelpers.js';

dotenv.config();

/**
 * How much a credential can do, for ordering. A scope with no `kinds` list is
 * unrestricted, so it sorts last and can never win a tie against a narrower
 * one configured with the same value.
 */
const scopeWidth = ({ kinds }) => (Array.isArray(kinds) ? kinds.length : Infinity);

/**
 * Constant-time equality for credentials. Hashing both sides first is what
 * lets timingSafeEqual be used at all — it demands equal-length buffers, and
 * the lengths here are attacker-controlled. `===` short-circuits on the first
 * differing character, which is measurable over enough requests.
 */
function secretEquals(presented, configured) {
  const digest = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(digest(presented), digest(configured));
}

/** Every configured credential the presented key matches, narrowest first. */
function matchingScopes(scopes, presented) {
  return scopes
    .filter(({ envVar }) => process.env[envVar] && secretEquals(presented, process.env[envVar]))
    .sort((a, b) => scopeWidth(a) - scopeWidth(b));
}

/**
 * Both API-key gates run the same check against a different set of environment
 * variables: the raw `Authorization` header must equal one of them exactly.
 * One factory rather than two copies, so a change to the check — the
 * eight-character redaction in the log line, say — cannot land on one gate and
 * miss the other.
 *
 * `scopes` is the ordered list of credentials this gate accepts; the admin gate
 * has exactly one, the scheduler gate one per EventBridge rule. The matched
 * entry is handed to `onMatch` so a gate can record what the presented key is
 * allowed to do. A gate with none of its credentials configured is a server
 * misconfiguration rather than a rejected request; `requiredMessage` is what
 * the log line says when that happens.
 *
 * The variables are read per request, not captured at module load, because the
 * process environment is mutated by tests and by dotenv ordering.
 */
const apiKeyValidator = ({
  scopes,
  requiredMessage = null,
  onMatch = null,
}) => (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    warn('Authentication-Service', 'No authorization header provided', {
      error: 'No authorization header provided',
    }, req);
    return res.status(401).json({ message: 'Authorization header required' });
  }

  // Configured means "at least one credential this gate accepts is set", not
  // "one particular variable is set". The scheduler previously demanded the
  // master SCHEDULER_API_KEY even when the per-kind keys were present, so an
  // environment configured only for its EventBridge rules answered every tick
  // with a 500 — which is exactly how dev sat unable to run.
  //
  // Still fails closed, and still loudly: with nothing configured no scope can
  // match, so this is a 500 naming the accepted variables rather than a 401
  // that reads like a bad key and sends the operator hunting the wrong thing.
  const configured = scopes.filter(({ envVar }) => process.env[envVar]);
  if (configured.length === 0) {
    const names = scopes.map(({ envVar }) => envVar).join(', ');
    warn('Authentication-Service', 'No API key configured for this route', {
      error: requiredMessage ?? `None of these environment variables are set: ${names}`,
    }, req);
    return res.status(500).json({ message: 'Server configuration error' });
  }

  const matched = matchingScopes(scopes, authHeader);

  if (matched.length === 0) {
    warn('Authentication-Service', 'Invalid API key provided', {
      error: 'Invalid API key',
      providedKey: authHeader.substring(0, 8) + '...', // Log only first 8 characters for security
    }, req);
    return res.status(401).json({ message: 'Invalid API key' });
  }

  // Two variables configured with the same secret — the same value pasted into
  // both EventBridge connections. Without this the widest entry won by
  // declaration order, so a per-kind rule silently gained the master key's
  // reach. The narrowest wins instead, and the misconfiguration is logged
  // rather than left to be inferred from what did or did not fire.
  if (matched.length > 1) {
    warn('Authentication-Service', 'API key matches more than one configured credential; using the narrowest scope', {
      envVars: matched.map(({ envVar }) => envVar),
    }, req);
  }

  if (onMatch) onMatch(req, matched[0]);

  info('Authentication-Service', 'API key validation successful', {}, req ?? null);
  return next();
};

/** Admin and webhook routes. */
export const validateApiKey = apiKeyValidator({
  scopes: [{ envVar: 'Admin_API_Key', kinds: null }],
});

/**
 * The scheduler tick's credentials, one per EventBridge rule. Separate from
 * Admin_API_Key deliberately: they live in EventBridge rules, rotate on their
 * own schedules, and leak a strictly smaller capability than the admin key.
 *
 * The presented key IS the scope: the master SCHEDULER_API_KEY ticks every
 * kind and is what `npm run tick` sends; each per-kind key scopes its tick to its
 * own kind, so the invoice rule cannot fire statement schedules by
 * misconfiguration. An unset or blank per-kind variable simply makes that key
 * unavailable — the non-empty check in matchingScopes is what stops a blank
 * env var matching anything.
 */
const SCHEDULER_KEY_SCOPES = [
  { envVar: 'SCHEDULER_API_KEY', kinds: null },
  { envVar: 'SCHEDULER_API_KEY_INVOICE', kinds: [KIND_INVOICE] },
  { envVar: 'SCHEDULER_API_KEY_STATEMENT', kinds: [KIND_STATEMENT] },
];

export const validateSchedulerApiKey = apiKeyValidator({
  scopes: SCHEDULER_KEY_SCOPES,
  // Any one of the three is enough. SCHEDULER_API_KEY is no longer required
  // alongside the per-kind keys: an environment wired only for its invoice and
  // statement EventBridge rules is a legitimate deployment, and demanding the
  // master key there turned every tick into a 500.
  requiredMessage:
    'Set SCHEDULER_API_KEY for a gate over every kind, or SCHEDULER_API_KEY_INVOICE / '
    + 'SCHEDULER_API_KEY_STATEMENT to scope a tick to one kind',
  onMatch: (req, scope) => {
    req.schedulerKinds = scope.kinds;
  },
});

export const authenticateToken = (req, res, next) => {
  const token = req.session.token;
  const { workspaceId, boardId } = getRequestScope(req);

  if (!token) {
    warn('Authentication-Service', 'No token provided', {
      error: 'No token provided',
    }, req);
    return res.status(401).json({ message: 'Authentication required' });
  }

  if (!process.env.JWT_SECRET) {
    warn('Authentication-Service', 'JWT_SECRET not configured', {
      error: 'JWT_SECRET environment variable not set',
    }, req);
    return res.status(500).json({ message: 'Server configuration error' });
  }

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    if (user && typeof user === 'object' && typeof user.flow === 'string') {
      warn('Authentication-Service', 'OAuth state token presented as session', {
        error: 'OAuth state token presented as session',
      }, req);
      return res.status(401).json({ message: 'Authentication required' });
    }

    applyPrivilegedSessionAuth(req, user);

    if (user.role === 'isoplus_user') {
      const allowed = authorizeIsoplusUser(user, workspaceId, boardId, req, res);
      if (!allowed) return;
    }

    req.user = user;
    req.headers['X-API-Version'] = '2025-02-26.morava';
    next();
  } catch (err) {
    warn('Authentication-Service', 'Invalid or expired token', {
      error: 'Invalid or expired token',
    }, req);
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

export const requirePortalOwnerOrSupport = (req, res, next) => {
  const role = req.user?.role;
  if (role !== 'owner' && role !== 'support_admin') {
    warn('Authentication-Service', 'Time tracking requires Owner or Support Admin', {
      role,
      userId: req.user?.userId,
    }, req);
    return res.status(403).json({
      message: 'Access denied. Owner or Support Admin permission required for time tracking.',
    });
  }
  next();
};
