import jwt from 'jsonwebtoken';
import { warn, info } from '../utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

export const validateApiKey = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    warn('API-Key-Service', 'No authorization header provided', {
      error: 'No authorization header provided',
    }, req);
    return res.status(401).json({ message: 'Authorization header required' });
  }


  if (!process.env.USER_SECRET_API_KEY) {
    warn('API-Key-Service', 'USER_SECRET_API_KEY not configured', {
      error: 'USER_SECRET_API_KEY environment variable not set',
    }, req);
    return res.status(500).json({ message: 'Server configuration error' });
  }

  if (authHeader !== process.env.USER_SECRET_API_KEY) {
    warn('API-Key-Service', 'Invalid API key provided', {
      error: 'Invalid API key',
      providedKey: authHeader.substring(0, 8) + '...', // Log only first 8 characters for security
    }, req);
    return res.status(401).json({ message: 'Invalid API key' });
  }

  info('API-Key-Service', 'API key validation successful', {}, req);
  next();
};

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

    if (user.role === 'support_admin' || user.role === 'owner') {
      req.session.Authorization = `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`;
    } else if(user.role === 'isoplus_user') {
      if (workspaceId) {
        const workspaceObj = user.workspace && Array.isArray(user.workspace)
          ? user.workspace.find(w => (w.id || w) == workspaceId)
          : undefined;
        if (!workspaceObj || (workspaceObj.user_role !== 'owner' && workspaceObj.user_role !== 'admin')) {
          warn('Authentication-Service', 'This User does not have permission to access Workspace.', {
            error: 'This User does not have permission to access Workspace.',
            userId: user.userId,
            role: user.role,
            workspaceId,
          }, req);
          return res.status(403).json({ message: 'This User does not have permission to access Workspace.', error_type: 'workspace' });
        }
        if (boardId) {
          const boards = (typeof workspaceObj === 'object' && workspaceObj.board) ? workspaceObj.board : [];
          if (!boards.find(b => (b.id || b) == boardId)) {
            warn('Authentication-Service', 'This User does not have permission to access Board.', {
              error: 'This User does not have permission to access Board.',
              userId: user.userId,
              role: user.role,
              workspaceId,
              boardId,
            }, req);
            return res.status(403).json({ message: 'This User does not have permission to access Board.', error_type: 'board' });
          }
        }
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