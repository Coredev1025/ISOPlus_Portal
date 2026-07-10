import jwt from 'jsonwebtoken';
import { warn, info } from '../utils/logger.js';
import dotenv from 'dotenv';
import {
  applyPrivilegedSessionAuth,
  authorizeIsoplusUser,
  getRequestScope,
} from './authHelpers.js';

dotenv.config();

export const validateApiKey = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    warn('Authentication-Service', 'No authorization header provided', {
      error: 'No authorization header provided',
    }, req);
    return res.status(401).json({ message: 'Authorization header required' });
  }


  if (!process.env.Admin_API_Key) {
    warn('Authentication-Service', 'Admin_API_Key not configured', {
      error: 'Admin_API_Key environment variable not set',
    }, req);
    return res.status(500).json({ message: 'Server configuration error' });
  }

  if (authHeader !== process.env.Admin_API_Key) {
    warn('Authentication-Service', 'Invalid API key provided', {
      error: 'Invalid API key',
      providedKey: authHeader.substring(0, 8) + '...', // Log only first 8 characters for security
    }, req);
    return res.status(401).json({ message: 'Invalid API key' });
  }

  info('Authentication-Service', 'API key validation successful', {}, req ?? null);
  next();
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
