import { warn } from '../utils/logger.js';
import { PORTAL_STAFF_ROLES } from '../constants/roles.js';

/**
 * Admin-only gate for the System Health screens.
 *
 * Mounted after `authenticateToken`, which is what puts `req.user` there. The
 * roles mirror `Frontend/lib/access.ts`'s `isOwnerOrSupport`, so the button and
 * the endpoint agree about who may see every client's data.
 *
 * 403, not 404: the caller is authenticated and the route exists — hiding that
 * would only make a permissions problem look like a deploy problem.
 */
export function requireOwnerOrSupport(req, res, next) {
  const role = req.user?.role;

  if (PORTAL_STAFF_ROLES.has(role)) {
    next();
    return;
  }

  warn('SystemHealth', 'Refused a non-admin request', { role, path: req.path }, req);
  res.status(403).json({ message: 'Forbidden' });
}
