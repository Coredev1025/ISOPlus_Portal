import { warn } from '../utils/logger.js';

export function getRequestScope(req) {
  return {
    workspaceId:
      req.body.workspaceId || req.params.workspaceId || req.query.workspaceId || undefined,
    boardId: req.body.boardId || req.params.boardId || req.query.boardId || undefined,
  };
}

function findWorkspace(user, workspaceId) {
  if (!user.workspace || !Array.isArray(user.workspace)) return undefined;
  return user.workspace.find((w) => (w.id || w) == workspaceId);
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

function denyBoardAccess(res, req, user, workspaceId, boardId) {
  warn(
    'Authentication-Service',
    'This User does not have permission to access Board.',
    {
      error: 'This User does not have permission to access Board.',
      userId: user.userId,
      role: user.role,
      workspaceId,
      boardId,
    },
    req
  );
  res.status(403).json({
    message: 'This User does not have permission to access Board.',
    error_type: 'board',
  });
}

function hasWorkspaceAdminRole(workspaceObj) {
  return workspaceObj.user_role === 'owner' || workspaceObj.user_role === 'admin';
}

function userHasBoardAccess(workspaceObj, boardId) {
  const boards = typeof workspaceObj === 'object' && workspaceObj.board ? workspaceObj.board : [];
  return boards.some((b) => (b.id || b) == boardId);
}

export function authorizeIsoplusUser(user, workspaceId, boardId, req, res) {
  if (!workspaceId) return true;

  const workspaceObj = findWorkspace(user, workspaceId);
  if (!workspaceObj || !hasWorkspaceAdminRole(workspaceObj)) {
    denyWorkspaceAccess(res, req, user, workspaceId);
    return false;
  }

  if (boardId && !userHasBoardAccess(workspaceObj, boardId)) {
    denyBoardAccess(res, req, user, workspaceId, boardId);
    return false;
  }

  return true;
}

export function applyPrivilegedSessionAuth(req, user) {
  if (user.role === 'support_admin' || user.role === 'owner') {
    req.session.Authorization = `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`;
  }
}
