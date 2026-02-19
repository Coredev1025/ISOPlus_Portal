import express from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { authenticateToken, validateApiKey } from '../middleware/auth.js';
import querystring from 'querystring';
import axios from 'axios';
import { error, info, warn } from '../utils/logger.js';
import { getBoard, getWorkspace } from '../services/isoplus.js';

const router = express.Router();

router.post('/register',
  [
    body('email').isEmail(),
    body('password').isLength({ min: 6 }),
    body('name').notEmpty()
  ],
  validateApiKey,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      warn('User-Service', 'Validation failed during registration', { errors: errors.array() }, req ?? null);
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const email = req.body.email?.toString();
      const password = req.body.password?.toString();
      const name = req.body.name?.toString();

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        warn('User-Service', 'User already exists', { email }, req ?? null);
        return res.status(400).json({ message: 'User already exists' });
      }

      const user = new User({ email, password, name, role: 'support_admin' });
      await user.save();

      const token = jwt.sign(
        { userId: user._id, email: user.email, name: user.name, role: 'support_admin', avatar: '' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      req.session.token = token;
      await req.session.save();

      info('User-Service', 'User registered successfully', { email }, req ?? null);
      res.status(201).json({ user: { id: user._id, email, name, role: 'support_admin', avatar: '' } });
    } catch (err) {
      error('User-Service', 'Server error during registration', { err, email: req.body?.email }, req);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.post('/login',
  [
    body('email').isEmail(),
    body('password').exists()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      warn('User-Service', 'Validation failed during login', { errors: errors.array() }, req ?? null);
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const email = req.body.email?.toString();
      const password = req.body.password?.toString();
      const user = await User.findOne({ email });

      if (!user || !(await user.comparePassword(password))) {
        warn('User-Service', 'Invalid credentials', { email }, req ?? null);
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      if (user.disabled) {
        warn('User-Service', 'Login attempt for disabled user', { email }, req ?? null);
        return res.status(403).json({ message: 'Account is disabled' });
      }

      const token = jwt.sign(
        { userId: user._id, email: user.email, name: user.name, role: 'support_admin', avatar: '' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      req.session.token = token;
      await req.session.save();

      info('User-Service', 'User logged in successfully', { email }, req ?? null);
      res.json({ user: { id: user._id, email, name: user.name, role: 'support_admin', avatar: '' } });
    } catch (err) {
      error('User-Service', 'Server error during login', { err, email: req.body?.email }, req);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      error('Auth-Service', 'Error during logout', { err }, req);
      return res.status(500).json({ message: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logout successful' });
  });
});

router.get('/verify', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) {
      warn('User-Service', 'User not found during verification', {}, req ?? null);
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.disabled) {
      warn('User-Service', 'Token verification for disabled user', { userId: req.user.userId }, req ?? null);
      return res.status(403).json({ message: 'Account is disabled' });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, name: user.name, role: user.role, avatar: user.avatar, workspace: req.user.workspace, board: req.user.board },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    req.session.token = token;
    await req.session.save();

    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (err) {
    error('User-Service', 'Server error during verification', { err, userId: req.user?.userId }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get("/isoplus/redirect", (req, res) => {
  const state = Math.random().toString(36).substring(2);

  const query = querystring.stringify({
    client_id: process.env.CLIENT_ID,
    redirect_uri: `${process.env.CALLBACK_URL}`,
    response_type: "code",
    scope: "public-api internal-api",
    state: state,
  });

  res.json({ redirect_uri: `${process.env.AUTHORIZATION_ENDPOINT}?${query}` });
});

router.get("/isoplus/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    warn('User-Service', 'Authorization code is missing', { state }, req ?? null);
    return res.status(400).json({ error: "Authorization code is missing" });
  }

  try {
    const tokenResponse = await axios.post(`${process.env.TOKEN_ENDPOINT}`, {
      grant_type: "authorization_code",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      redirect_uri: `${process.env.CALLBACK_URL}`,
      code: code
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!tokenResponse.data || !tokenResponse.data.access_token) {
      warn('User-Service', 'Invalid token response',  {
        url: process.env.TOKEN_ENDPOINT,
        method: "POST",
        data: {
          grant_type: "authorization_code",
          client_id: process.env.CLIENT_ID,
          redirect_uri: `${process.env.CALLBACK_URL}`,
          code: code
        },
        response: tokenResponse.data
      }, req ?? null);
      return res.status(400).json({ error: "Invalid token response" });
    }

    const accessToken = tokenResponse.data.access_token;

    const userResponse = await axios.get(`${process.env.USER_INFORMATION_ENDPOINT}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-Version": "2025-02-26.morava",
      }
    });

    if (!userResponse.data) {
      warn('User-Service', 'Invalid user response', {
        url: process.env.USER_INFORMATION_ENDPOINT,
        method: "GET",
        data: {},
        response: userResponse.data
      }, req ?? null);
      return res.status(400).json({ error: "Invalid user response" });
    }

    info('User-Service', 'OAuth callback successful', { state, user: userResponse.data }, req ?? null);

    const safeUserData = {
      id: userResponse.data.id,
      email: userResponse.data.email,
      name: userResponse.data.name,
      photo_url: userResponse.data.photo_url
    };
    
    const messageData = JSON.stringify({
      type: 'AUTH_SUCCESS',
      data: safeUserData,
      accessToken: `Bearer ${accessToken}`
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'); // Escape HTML tags in JSON
    
    res.send(`
      <html>
        <body>
          <script>
            window.opener.postMessage(${messageData}, '*');
            window.close();
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    error('User-Service', 'Token exchange error', {
      url: process.env.TOKEN_ENDPOINT,
      method: "POST",
      data: {
        grant_type: "authorization_code",
        client_id: process.env.CLIENT_ID,
        redirect_uri: `${process.env.CALLBACK_URL}`,
        code: code ? '[REDACTED]' : undefined
      },
      error: err.response?.data || err.message,
      status: err.response?.status
    }, req);
    const rawErrorMessage = err.response?.data?.error || err.message || 'Failed to authenticate';
    const safeErrorMessage = String(rawErrorMessage).substring(0, 500);
    
    const errorData = JSON.stringify({
      type: 'AUTH_ERROR',
      error: safeErrorMessage
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'); // Escape HTML tags in JSON
    
    res.send(`
      <html>
        <body>
          <script>
            window.opener.postMessage(${errorData}, '*');
            window.close();
          </script>
        </body>
      </html>
    `);
  }
});

router.post('/oauth-login', async (req, res) => {
  try {
    const { oauthData } = req.body;

    const email = oauthData.email?.toString();
    const oauthId = oauthData.id?.toString();
    const name = oauthData.name?.toString();
    const photo_url = oauthData.photo_url?.toString();

    let user = await User.findOne({ email, oauthId });
    let role = 'isoplus_user';
    if (!user) {
      user = new User({
        email: email,
        name: name,
        password: "",
        oauthId: oauthId,
        avatar: photo_url,
        role: role
      });
      await user.save();
    } else {
      await User.findOneAndUpdate({ email: email, oauthId: oauthId }, { $set: { avatar: photo_url, name: name } });
    }

    if (user.disabled) {
      warn('User-Service', 'OAuth login attempt for disabled user', { email }, req ?? null);
      return res.status(403).json({ message: 'Account is disabled' });
    }

    req.session.Authorization = req.headers['authorization'];
    const workspaceResponse = await getWorkspace(req.session.Authorization, user.email);

    if (workspaceResponse.status === 200) {
      role = workspaceResponse.workspace[0]?.user_role || "isoplus_user";
      if (role === "owner" && user.role !== "owner") {
        await User.findByIdAndUpdate({ _id: user._id }, { $set: { role: "owner" } });
      }

      const workspace = workspaceResponse.workspace.map(w => {
        const board = w.board.map(b => {
          return b.id
        });
        return {
          id: w.id,
          board: board,
          user_role: w.user_role
        }
      });

      const token = jwt.sign(
        { userId: user._id, email: user.email, name: user.name, role: user.role, avatar: user.avatar, workspace: workspace },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      req.session.token = token;
      await req.session.save();      
      info('User-Service', 'OAuth login successful', { email: user.email }, req ?? null);
      res.json({
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          role: user.role
        }
      });
    } else {
      warn('User-Service', 'Failed to fetch workspaces during OAuth login', { 
        status: workspaceResponse.status, 
        email: user.email 
      }, req ?? null);
      res.status(workspaceResponse.status || 500).json({ 
        message: workspaceResponse.message || 'Failed to fetch workspace data' 
      });
    }
  } catch (err) {
    error('User-Service', 'Server error during OAuth login', { err, email: req.body?.oauthData?.email }, req);
    res.status(500).json({ message: 'Server error during OAuth login' });
  }
});

router.get('/users', validateApiKey, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    info('User-Service', 'Users list retrieved successfully', { count: users.length }, req ?? null);
    res.json({ users });
  } catch (err) {
    error('User-Service', 'Server error while retrieving users', { err }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/users/:userId/disable', validateApiKey, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId);
    if (!user) {
      warn('User-Service', 'User not found for disable operation', { userId }, req ?? null);
      return res.status(404).json({ message: 'User not found' });
    }

    user.disabled = true;
    await user.save();

    info('User-Service', 'User disabled successfully', { userId, email: user.email }, req ?? null);
    res.json({ 
      message: 'User disabled successfully',
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        disabled: user.disabled
      }
    });
  } catch (err) {
    error('User-Service', 'Server error while disabling user', { err, userId: req.params?.userId }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/users/:userId/enable', validateApiKey, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId);
    if (!user) {
      warn('User-Service', 'User not found for enable operation', { userId }, req ?? null);
      return res.status(404).json({ message: 'User not found' });
    }

    user.disabled = false;
    await user.save();

    info('User-Service', 'User enabled successfully', { userId, email: user.email }, req ?? null);
    res.json({ 
      message: 'User enabled successfully',
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        disabled: user.disabled
      }
    });
  } catch (err) {
    error('User-Service', 'Server error while enabling user', { err, userId: req.params?.userId }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;