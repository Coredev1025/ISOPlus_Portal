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
 * Both API-key gates run the same check against a different environment
 * variable: the raw `Authorization` header must equal it exactly. One factory
 * rather than two copies, so a change to the check — the eight-character
 * redaction in the log line, say — cannot land on one gate and miss the other.
 *
 * The variable is read per request, not captured at module load, because the
 * process environment is mutated by tests and by dotenv ordering.
 */
const apiKeyValidator = (envVar) => (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    warn('Authentication-Service', 'No authorization header provided', {
      error: 'No authorization header provided',
    }, req);
    return res.status(401).json({ message: 'Authorization header required' });
  }

  if (!process.env[envVar]) {
    warn('Authentication-Service', `${envVar} not configured`, {
      error: `${envVar} environment variable not set`,
    }, req);
    return res.status(500).json({ message: 'Server configuration error' });
  }

  if (authHeader !== process.env[envVar]) {
    warn('Authentication-Service', 'Invalid API key provided', {
      error: 'Invalid API key',
      providedKey: authHeader.substring(0, 8) + '...', // Log only first 8 characters for security
    }, req);
    return res.status(401).json({ message: 'Invalid API key' });
  }

  info('Authentication-Service', 'API key validation successful', {}, req ?? null);
  next();
};

/** Admin and webhook routes. */
export const validateApiKey = apiKeyValidator('Admin_API_Key');

/**
 * The scheduler tick's credentials, one per EventBridge rule. Separate from
 * Admin_API_Key deliberately: they live in EventBridge rules, rotate on their
 * own schedules, and leak a strictly smaller capability than the admin key.
 *
 * The presented key IS the scope: the master SCHEDULER_API_KEY (required
 * configuration — the boot warning in index.js keys on it) ticks every kind
 * and is what `npm run tick` sends; each per-kind key scopes its tick to its
 * own kind, so the invoice rule cannot fire statement schedules by
 * misconfiguration. An unset per-kind variable simply makes that key
 * unavailable — the non-empty check below is what stops a blank env var
 * matching anything.
 */
const SCHEDULER_KEY_SCOPES = [
  { envVar: 'SCHEDULER_API_KEY', kinds: null },
  { envVar: 'SCHEDULER_API_KEY_INVOICE', kinds: [KIND_INVOICE] },
  { envVar: 'SCHEDULER_API_KEY_STATEMENT', kinds: [KIND_STATEMENT] },
];

export const validateSchedulerApiKey = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    warn('Authentication-Service', 'No authorization header provided', {
      error: 'No authorization header provided',
    }, req);
    return res.status(401).json({ message: 'Authorization header required' });
  }

  if (!process.env.SCHEDULER_API_KEY) {
    warn('Authentication-Service', 'SCHEDULER_API_KEY not configured', {
      error: 'SCHEDULER_API_KEY environment variable not set',
    }, req);
    return res.status(500).json({ message: 'Server configuration error' });
  }

  const scope = SCHEDULER_KEY_SCOPES.find(
    ({ envVar }) => process.env[envVar] && authHeader === process.env[envVar],
  );

  if (!scope) {
    warn('Authentication-Service', 'Invalid API key provided', {
      error: 'Invalid API key',
      providedKey: authHeader.substring(0, 8) + '...', // Log only first 8 characters for security
    }, req);
    return res.status(401).json({ message: 'Invalid API key' });
  }

  req.schedulerKinds = scope.kinds;
  return next();
};

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
