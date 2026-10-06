import { warn } from '../utils/logger.js';
import { ROLE_OWNER, ROLE_SUPPORT_ADMIN } from '../constants/roles.js';

export function getRequestScope(req) {
  return {
    workspaceId:
      req.body.workspaceId || req.params.workspaceId || req.query.workspaceId || undefined,
    boardId: req.body.boardId || req.params.boardId || req.query.boardId || undefined,
  };
}

function denyWorkspaceAccess(res, req, user, workspaceId) {
  warn(
    'Authentication-Service',
    'This User does not have permission to access Workspace.',
    {
      error: 'This User does not have permission to access Workspace.',
      userId: user.userId,
      role: user.role,
      workspaceId,
    },
    req
  );
  res.status(403).json({
    message: 'This User does not have permission to access Workspace.',
    error_type: 'workspace',
  });
}

export function authorizeIsoplusUser(user, workspaceId, _boardId, req, res) {
  if (!req.session?.Authorization) {
    denyWorkspaceAccess(res, req, user, workspaceId);
    return false;
  }
  return true;
}

/**
 * Attach the shared ISO+ PAT for portal staff (support_admin / owner).
 * Google support login uses this — there is no per-user ISO+ OAuth token.
 *
 * @returns {boolean} true when Authorization was set on the session
 */
export function applyPrivilegedSessionAuth(req, user) {
  if (user?.role !== ROLE_SUPPORT_ADMIN && user?.role !== ROLE_OWNER) {
    return false;
  }

  const pat = String(process.env.PERSONAL_ACCESS_TOKEN || '').trim();
  if (!pat) {
    warn('Authentication-Service', 'PERSONAL_ACCESS_TOKEN missing for privileged session', {
      role: user.role,
      userId: user.userId || null,
    });
    return false;
  }

  if (!req.session) return false;
  req.session.Authorization = `Bearer ${pat}`;
  return true;
}
