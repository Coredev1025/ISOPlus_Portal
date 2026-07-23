import { warn } from '../utils/logger.js';

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

export function applyPrivilegedSessionAuth(req, user) {
  if (user.role === 'support_admin' || user.role === 'owner') {
    req.session.Authorization = `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`;
  }
}
