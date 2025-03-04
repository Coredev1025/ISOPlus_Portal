import jwt from 'jsonwebtoken';
import { warn } from '../utils/logger.js';

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['token'];
  const token = authHeader ? authHeader : null;

  if (!token) {
    warn('Authentication-Service', 'No token provided', {
      error: 'No token provided',
    }, req);
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);

    req.user = user;
    req.headers['X-API-Version'] = '2024-12-17.morava';
    next();
  } catch (err) {
    warn('Authentication-Service', 'Invalid or expired token', {
      error: 'Invalid or expired token',
    }, req);
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};