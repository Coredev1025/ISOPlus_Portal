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

/** Every configured credential the presented key matches, narrowest first. */
function matchingScopes(scopes, presented) {
  return scopes
    .filter(({ envVar }) => process.env[envVar] && presented === process.env[envVar])
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
 * allowed to do. `requiredEnvVar` names the variable whose absence is a server
 * misconfiguration rather than a rejected request.
 *
 * The variables are read per request, not captured at module load, because the
 * process environment is mutated by tests and by dotenv ordering.
 */
const apiKeyValidator = ({
  scopes,
  requiredEnvVar,
  requiredMessage = `${requiredEnvVar} environment variable not set`,
  onMatch = null,
}) => (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    warn('Authentication-Service', 'No authorization header provided', {
      error: 'No authorization header provided',
    }, req);
    return res.status(401).json({ message: 'Authorization header required' });
  }

  if (!process.env[requiredEnvVar]) {
    warn('Authentication-Service', `${requiredEnvVar} not configured`, {
      error: requiredMessage,
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
  requiredEnvVar: 'Admin_API_Key',
});

/**
 * The scheduler tick's credentials, one per EventBridge rule. Separate from
 * Admin_API_Key deliberately: they live in EventBridge rules, rotate on their
 * own schedules, and leak a strictly smaller capability than the admin key.
 *
 * The presented key IS the scope: the master SCHEDULER_API_KEY (required
 * configuration — the boot warning in index.js keys on it) ticks every kind
 * and is what `npm run tick` sends; each per-kind key scopes its tick to its
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
  requiredEnvVar: 'SCHEDULER_API_KEY',
  // Named explicitly because the per-kind keys look like a substitute for it
  // and are not: an environment configured with only SCHEDULER_API_KEY_INVOICE
  // gets a 500 here, and "Server configuration error" alone sends the operator
  // looking at the wrong variable.
  requiredMessage:
    'SCHEDULER_API_KEY is required even when per-kind scheduler keys are configured',
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
