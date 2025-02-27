import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { info, error } from '../utils/logger.js';

const router = express.Router();

router.get('/connect', authenticateToken, (req, res) => {
  const authUrl = `https://login.xero.com/identity/connect/authorize?
    response_type=code&
    client_id=${process.env.XERO_CLIENT_ID}&
    redirect_uri=${encodeURIComponent(process.env.XERO_REDIRECT_URI)}&
    scope=offline_access accounting.transactions`;

  info('Xero-Service', 'Successufully connect', { userId: req.user.userId });
  res.json({ authUrl });
});

router.get('/callback', authenticateToken, async (req, res) => {
  try {
    info('Xero-Service', 'GET /callback request received', { userId: req.user.userId, query: req.query });
    const { code } = req.query;
    res.redirect('/dashboard');
  } catch (err) {
    error('Xero-Service', 'Failed to connect with Xero', { message: err.message });
    res.status(500).json({ message: 'Failed to connect with Xero' });
  }
});

export default router;