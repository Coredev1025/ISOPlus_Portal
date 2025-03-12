import express from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { authenticateToken } from '../middleware/auth.js';
import querystring from 'querystring';
import axios from 'axios';
import { error, info, warn } from '../utils/logger.js';

const router = express.Router();
let is_working = false;

router.post('/register',
  [
    body('email').isEmail(),
    body('password').isLength({ min: 6 }),
    body('name').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      warn('User-Service', 'Validation failed during registration', { errors: errors.array() }, req);
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, password, name } = req.body;

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        warn('User-Service', 'User already exists', { email }, req);
        return res.status(400).json({ message: 'User already exists' });
      }

      const user = new User({ email, password, name, role: 'admin' });
      await user.save();

      const token = jwt.sign(
        { userId: user._id, email: user.email, role: 'admin' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      info('User-Service', 'User registered successfully', { email }, req);
      res.status(201).json({ token, user: { id: user._id, email, name } });
    } catch (err) {
      error('User-Service', 'Server error during registration', { error: err.message }, req);
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
      warn('User-Service', 'Validation failed during login', { errors: errors.array() }, req);
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, password } = req.body;
      const user = await User.findOne({ email });

      if (!user || !(await user.comparePassword(password))) {
        warn('User-Service', 'Invalid credentials', { email }, req);
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const token = jwt.sign(
        { userId: user._id, email: user.email, role: 'admin' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      info('User-Service', 'User logged in successfully', { email }, req);
      res.json({ token, user: { id: user._id, email, name: user.name, role: 'admin' } });
    } catch (err) {
      error('User-Service', 'Server error during login', { error: err.message }, req);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.get('/verify', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) {
      warn('User-Service', 'User not found during verification', {}, req);
      return res.status(404).json({ message: 'User not found' });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (err) {
    error('User-Service', 'Server error during verification', { error: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get("/isoplus/redirect", (req, res) => {
  const state = Math.random().toString(36).substring(2);

  const query = querystring.stringify({
    client_id: process.env.CLIENT_ID,
    redirect_uri: `http://localhost:3001${process.env.CALLBACK_URL}`,
    response_type: "code",
    scope: "public-api internal-api",
    state: state,
  });

  res.json({ redirect_uri: `${process.env.AUTHORIZATION_ENDPOINT}?${query}` });
});

router.get("/isoplus/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    warn('User-Service', 'Authorization code is missing', { state }, req);
    return res.status(400).json({ error: "Authorization code is missing" });
  }

  try {
    const tokenResponse = await axios.post(`${process.env.TOKEN_ENDPOINT}`, {
      grant_type: "authorization_code",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      redirect_uri: `http://localhost:3001${process.env.CALLBACK_URL}`,
      code: code
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Version': '2025-02-26.morava'
      }
    });

    const accessToken = tokenResponse.data.access_token;

    if (!accessToken) {
      warn('User-Service', 'Failed to retrieve access token', { state }, req);
      return res.status(400).json({ error: "Failed to retrieve access token" });
    }

    const userResponse = await axios.get(`${process.env.USER_INFORMATION_ENDPOINT}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      }
    });

    info('User-Service', 'OAuth callback successful', { state, user: userResponse.data }, req);
    res.send(`
      <html>
        <body>
          <script>
            window.opener.postMessage(${JSON.stringify({
      type: 'AUTH_SUCCESS',
      data: userResponse.data,
      accessToken: `Bearer ${accessToken}`
    })}, '*');
            window.close();
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    error('User-Service', 'Token exchange error', { error: err.message, state }, req);
    res.send(`
      <html>
        <body>
          <script>
            window.opener.postMessage({
              type: 'AUTH_ERROR',
              error: 'Failed to authenticate'
            }, '*');
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

    let user = await User.findOne({ email: oauthData.email, oauthId: oauthData.id });

    if (!user) {
      user = new User({
        email: oauthData.email,
        name: oauthData.name,
        password: "",
        oauthId: oauthData.id,
        avatar: oauthData.photo_url,
      });
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: 'user' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    if (!is_working)
      generateAutomationURL(token, req.headers['authorization']);

    info('User-Service', 'OAuth login successful', { email: user.email }, req);
    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        role: 'user'
      }
    });
  } catch (err) {
    error('User-Service', 'Server error during OAuth login', { error: err.message }, req);
    res.status(500).json({ message: 'Server error during OAuth login' });
  }
});

const generateAutomationURL = async (token, authorization) => {
  try{
    is_working = true;
    const workspaces = await axios.get(`http://localhost:3001/api/workspaces`, { headers: { token, authorization: authorization } })
  
    if (workspaces.status === 200) {
      workspaces.data.workspace.map(async (workspaceData) => {
        const response = await axios.get(`http://localhost:3001/api/workspaces/boards?workspaceId=${workspaceData.id}`, { headers: { token, authorization: authorization } });
        response.data.board.map(async (boardData) => {
          // const result = await axios.post(`https://app.isoplus.online/api/v2/workspaces/${workspaceData.id}/boards/${boardData.id}/hooks`, {
          //   "url": `${process.env.HTTPS_URL}/api/webhook/${workspaceData.id}/${boardData.id}/invoice`,
          //   "events": [
          //     {
          //       "event": "item.created"
          //     }
          //   ]
          // }, {
          //   headers: {
          //     "Authorization": authorization,
          //     "Content-Type": "application/json",
          //     "Accept": "application/json",
          //     "X-API-Version": "2025-02-26.morava",
          //   }
          // })
          const result = await axios.get(`https://app.isoplus.online/api/v2/workspaces/${workspaceData.id}/boards/${boardData.id}/hooks`, {
            headers: {
              "Authorization": authorization,
              "Content-Type": "application/json",
              "Accept": "application/json",
              "X-API-Version": "2025-02-26.morava",
            }, params: {
              "expand[0]": "logs",
            }
          });
          console.log(result.data.data);
        })
      })
    }
    is_working = false;
  } catch (err) {
    console.log(err);
  }  
}

export default router;