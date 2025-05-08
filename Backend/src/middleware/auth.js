import jwt from 'jsonwebtoken';
import { warn } from '../utils/logger.js';

export const authenticateToken = (req, res, next) => {
  const token = req.session.token;
  const workspaceId = req.body.workspaceId || req.params.workspaceId || req.query.workspaceId || undefined;
  const boardId = req.body.boardId || req.params.boardId || req.query.boardId || undefined;

  if (!token) {
    warn('Authentication-Service', 'No token provided', {
      error: 'No token provided',
    }, req);
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);

    if (workspaceId) {
      if (!user.workspace || !user.workspace.find(id => id == workspaceId)) {
        warn('Authentication-Service', 'Workspace access denied', {
          error: 'Workspace access denied',
        }, req);
        return res.status(403).json({ message: 'Workspace access denied' });
      }
    }

    if (boardId) {
      if (!user.board || !user.board.find(id => id == boardId)) {
        warn('Authentication-Service', 'Board access denied', {
          error: 'Board access denied',
        }, req);
        return res.status(403).json({ message: 'Workspace access denied' });
      }
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