import express from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { authenticateToken, validateApiKey, requirePortalOwnerOrSupport } from '../middleware/auth.js';
import querystring from 'querystring';
import axios from 'axios';
import { error, info, warn, logLoginFailure, logLoginSuccess } from '../utils/logger.js';
import { getWorkspace, getMember, listWorkspacesForAuthorization } from '../services/isoplus.js';
import { getFrontendBaseUrl, signOAuthState, verifyOAuthState } from '../utils/helpers.js';
import OAuthTicket from '../models/OAuthTicket.js';
import { getSafeString, toRequiredQueryString } from '../utils/securityHelpers.js';

const router = express.Router();

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function memberEmailLower(m) {
  const raw = m?.email ?? m?.user?.email ?? m?.user_email ?? m?.profile?.email;
  return raw ? String(raw).toLowerCase().trim() : '';
}

function isoplusIdsFromWorkspaceMember(m) {
  const memberId =
    m?.id ?? m?.member_id ?? m?.workspace_member_id ?? m?.membership_id ?? m?.member?.id;
  const userId =
    m?.user?.id ?? m?.user_id ?? m?.userId ?? m?.user?.user_id ?? m?.profile?.id ?? m?.profile?.user_id;
  return {
    memberId: memberId != null && memberId !== '' ? String(memberId) : '',
    userId: userId != null && userId !== '' ? String(userId) : '',
  };
}

function pakAuthorization() {
  const pak = process.env.PERSONAL_ACCESS_TOKEN;
  if (!pak) return null;
  return `Bearer ${pak}`;
}

async function collectPortalUserWorkspaceRows(byEmail) {
  const authorization = pakAuthorization();
  if (!authorization) {
    return { ok: false, workspaceRows: [], message: 'PERSONAL_ACCESS_TOKEN is not configured' };
  }

  const wsResult = await listWorkspacesForAuthorization(authorization);
  if (wsResult.status !== 200) {
    return { ok: false, workspaceRows: [], message: wsResult.message };
  }

  const workspaceRows = [];
  for (const w of wsResult.workspaces || []) {
    const wid = w.id;
    if (wid == null) continue;
    const wname = w.name || w.label || '';
    const mem = await getMember(authorization, wid);
    if (mem.status !== 200 || !Array.isArray(mem.members)) continue;

    for (const m of mem.members) {
      const email = memberEmailLower(m);
      if (!email) continue;
      const portalUser = byEmail.get(email);
      if (!portalUser) continue;

      const { memberId: isoplusMemberId, userId: isoplusUserId } = isoplusIdsFromWorkspaceMember(m);
      workspaceRows.push({
        userId: portalUser._id.toString(),
        name: portalUser.name || '',
        email: portalUser.email || '',
        isoplusMemberId,
        isoplusUserId,
        workspaceId: String(wid),
        workspaceName: String(wname),
      });
    }
  }
  return { ok: true, workspaceRows };
}

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
      const email = getSafeString(req.body.email);
      const password = getSafeString(req.body.password);
      const name = getSafeString(req.body.name);
      if (!email || !password || !name) {
        return res.status(400).json({ message: 'Invalid registration input' });
      }

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
      const email = getSafeString(req.body.email);
      const password = getSafeString(req.body.password);
      if (!email || !password) {
        return res.status(400).json({ message: 'Invalid login input' });
      }
      const user = await User.findOne({ email });

      if (!user || !(await user.comparePassword(password))) {
        logLoginFailure('Auth-Service', 'Support admin login failed: invalid credentials', {
          method: 'support-admin',
          stage: 'invalid_credentials',
          reason: user ? 'Password mismatch' : 'No account for email',
          httpStatus: 401,
          email,
          userExists: !!user,
        }, req ?? null);
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      if (user.disabled) {
        logLoginFailure('Auth-Service', 'Support admin login failed: account disabled', {
          method: 'support-admin',
          stage: 'account_disabled',
          httpStatus: 403,
          email,
          userId: user._id?.toString(),
        }, req ?? null);
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
      logLoginFailure('Auth-Service', 'Support admin login failed: server error', {
        method: 'support-admin',
        stage: 'server_error',
        reason: err?.message,
        httpStatus: 500,
        level: 'error',
        email: req.body?.email,
        err,
      }, req);
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

router.get('/verify', async (req, res) => {
  try {
    const sessionToken = req.session?.token;
    if (!sessionToken) {
      return res.status(200).json({ authenticated: false });
    }

    if (!process.env.JWT_SECRET) {
      warn('Authentication-Service', 'JWT_SECRET not configured', {
        error: 'JWT_SECRET environment variable not set',
      }, req);
      return res.status(500).json({ message: 'Server configuration error' });
    }

    let decoded;
    try {
      decoded = jwt.verify(sessionToken, process.env.JWT_SECRET);
    } catch {
      delete req.session.token;
      await req.session.save().catch(() => {});
      return res.status(200).json({ authenticated: false });
    }

    const user = await User.findById(decoded.userId).select('-password');
    if (!user) {
      warn('User-Service', 'User not found during verification', {}, req ?? null);
      delete req.session.token;
      await req.session.save().catch(() => {});
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.disabled) {
      warn('User-Service', 'Token verification for disabled user', { userId: decoded.userId }, req ?? null);
      return res.status(403).json({ message: 'Account is disabled' });
    }

    const token = jwt.sign(
      {
        userId: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatar: user.avatar,
        workspace: decoded.workspace,
        board: decoded.board
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    req.session.token = token;
    await req.session.save();

    res.json({
      authenticated: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (err) {
    error('User-Service', 'Server error during verification', { err }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get("/isoplus/redirect", (req, res) => {
  const state = signOAuthState({ flow: 'isoplus-login' });

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
  const frontendBase = getFrontendBaseUrl();
  const loginErrorRedirect = `${frontendBase}/?login=error`;

  if (!code) {
    logLoginFailure('Auth-Service', 'ISO+ OAuth callback failed: authorization code missing', {
      method: 'isoplus-oauth',
      stage: 'callback_missing_code',
      reason: 'No authorization code in callback query',
      hasCode: false,
      hasState: !!state,
      oauthError: req.query?.error,
      oauthErrorDescription: req.query?.error_description,
    }, req ?? null);
    return res.redirect(loginErrorRedirect);
  }

  if (!verifyOAuthState(state)) {
    logLoginFailure('Auth-Service', 'ISO+ OAuth callback failed: invalid or missing state', {
      method: 'isoplus-oauth',
      stage: 'callback_invalid_state',
      reason: state ? 'State signature invalid or expired (possible CSRF)' : 'State parameter absent',
      hasCode: true,
      hasState: !!state,
    }, req ?? null);
    return res.redirect(loginErrorRedirect);
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
      logLoginFailure('Auth-Service', 'ISO+ OAuth callback failed: token endpoint returned no access_token', {
        method: 'isoplus-oauth',
        stage: 'token_exchange',
        reason: 'Token response missing access_token',
        upstreamStatus: tokenResponse.status,
        upstreamError: tokenResponse.data,
        tokenEndpoint: process.env.TOKEN_ENDPOINT,
      }, req ?? null);
      return res.redirect(loginErrorRedirect);
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
      logLoginFailure('Auth-Service', 'ISO+ OAuth callback failed: profile endpoint returned no data', {
        method: 'isoplus-oauth',
        stage: 'profile_fetch',
        reason: 'User information response was empty',
        upstreamStatus: userResponse.status,
        profileEndpoint: process.env.USER_INFORMATION_ENDPOINT,
      }, req ?? null);
      return res.redirect(loginErrorRedirect);
    }

    info('User-Service', 'OAuth callback successful', { userId: userResponse.data?.id }, req ?? null);

    const safeUserData = {
      id: userResponse.data.id,
      email: userResponse.data.email,
      name: userResponse.data.name,
      photo_url: userResponse.data.photo_url
    };

    const { ticket } = await OAuthTicket.create({
      accessToken,
      oauthData: safeUserData,
    });

    return res.redirect(`${frontendBase}/?ticket=${ticket}`);
  } catch (err) {
    // Distinguish which upstream call threw, for faster triage.
    const failedUrl = err.config?.url;
    const stage = failedUrl === process.env.USER_INFORMATION_ENDPOINT ? 'profile_fetch' : 'token_exchange';
    logLoginFailure('Auth-Service', `ISO+ OAuth callback failed: ${stage} request error`, {
      method: 'isoplus-oauth',
      stage,
      reason: err.message,
      level: 'error',
      upstreamStatus: err.response?.status,
      upstreamError: err.response?.data || err.message,
      failedUrl,
      errorCode: err.code,
      isTimeout: err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT',
      err,
    }, req);
    return res.redirect(loginErrorRedirect);
  }
});

async function establishOAuthSession(req, { authorization, oauthData, method = 'oauth-exchange' }) {
  const email = oauthData?.email?.toString();
  const oauthId = oauthData?.id?.toString();
  const name = oauthData?.name?.toString();
  const photo_url = oauthData?.photo_url?.toString();

  let user = await User.findOne({ email, oauthId });
  const defaultRole = 'isoplus_user';
  if (!user) {
    user = new User({
      email: email,
      name: name,
      password: "",
      oauthId: oauthId,
      avatar: photo_url,
      role: defaultRole
    });
    await user.save();
  } else {
    await User.findOneAndUpdate({ email: email, oauthId: oauthId }, { $set: { avatar: photo_url, name: name } });
  }

  if (user.disabled) {
    logLoginFailure('Auth-Service', 'OAuth login failed: account disabled', {
      method,
      stage: 'account_disabled',
      httpStatus: 403,
      email,
      userId: user._id?.toString(),
    }, req ?? null);
    return { status: 403, body: { message: 'Account is disabled' } };
  }

  req.session.Authorization = authorization;
  const workspaceResponse = await getWorkspace(req.session.Authorization, user.email);

  if (workspaceResponse.status !== 200) {
    logLoginFailure('Auth-Service', 'OAuth login failed: could not fetch ISO+ workspaces', {
      method,
      stage: 'workspace_fetch',
      reason: workspaceResponse.message || 'Workspace lookup did not return 200',
      httpStatus: workspaceResponse.status || 500,
      upstreamStatus: workspaceResponse.upstreamStatus ?? workspaceResponse.status,
      errorCode: workspaceResponse.errorCode,
      isTimeout: workspaceResponse.errorCode === 'ECONNABORTED' || workspaceResponse.errorCode === 'ETIMEDOUT',
      level: (workspaceResponse.status || 500) >= 500 ? 'error' : 'warn',
      email: user.email,
      userId: user._id?.toString(),
    }, req ?? null);
    return {
      status: workspaceResponse.status || 500,
      body: { message: workspaceResponse.message || 'Failed to fetch workspace data' }
    };
  }

  const role = workspaceResponse.workspace[0]?.user_role || "isoplus_user";
  if (role === "owner" && user.role !== "owner") {
    await User.findByIdAndUpdate({ _id: user._id }, { $set: { role: "owner" } });
    user.role = "owner";
  }

  const workspace = workspaceResponse.workspace.map(w => {
    const board = w.board.map(b => b.id);
    return {
      id: w.id,
      board: board,
      user_role: w.user_role
    };
  });

  const token = jwt.sign(
    { userId: user._id, email: user.email, name: user.name, role: user.role, avatar: user.avatar, workspace: workspace },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  req.session.token = token;
  await req.session.save();
  logLoginSuccess('User-Service', 'OAuth login successful', { method: 'isoplus-oauth', email: user.email }, req ?? null);
  return {
    status: 200,
    body: {
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        role: user.role
      }
    }
  };
}

router.post('/oauth-exchange', async (req, res) => {
  try {
    const { ticket } = req.body;
    const safeTicket = getSafeString(ticket);
    if (!safeTicket) {
      logLoginFailure('Auth-Service', 'OAuth exchange failed: ticket missing or malformed', {
        method: 'oauth-exchange',
        stage: 'ticket_missing',
        httpStatus: 400,
        ticketType: typeof ticket,
      }, req ?? null);
      return res.status(400).json({ message: 'Ticket is required' });
    }

    const record = await OAuthTicket.findOneAndDelete({ ticket: safeTicket });
    if (!record) {
      logLoginFailure('Auth-Service', 'OAuth exchange failed: ticket invalid, expired, or already used', {
        method: 'oauth-exchange',
        stage: 'ticket_redeem',
        reason: 'No matching ticket (single-use, 120s TTL — likely already redeemed or expired)',
        httpStatus: 401,
      }, req ?? null);
      return res.status(401).json({ message: 'Invalid or expired login ticket' });
    }

    const result = await establishOAuthSession(req, {
      authorization: `Bearer ${record.accessToken}`,
      oauthData: record.oauthData,
      method: 'oauth-exchange',
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    logLoginFailure('Auth-Service', 'OAuth exchange failed: server error', {
      method: 'oauth-exchange',
      stage: 'server_error',
      reason: err?.message,
      httpStatus: 500,
      level: 'error',
      err,
    }, req);
    res.status(500).json({ message: 'Server error during OAuth exchange' });
  }
});

router.post('/oauth-login', async (req, res) => {
  try {
    const { oauthData } = req.body;
    const result = await establishOAuthSession(req, {
      authorization: req.headers['authorization'],
      oauthData,
      method: 'oauth-login',
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    logLoginFailure('Auth-Service', 'Legacy OAuth login failed: server error', {
      method: 'oauth-login',
      stage: 'server_error',
      reason: err?.message,
      httpStatus: 500,
      level: 'error',
      email: req.body?.oauthData?.email,
      err,
    }, req);
    res.status(500).json({ message: 'Server error during OAuth login' });
  }
});

router.get(
  '/users/export-csv',
  authenticateToken,
  requirePortalOwnerOrSupport,
  async (req, res) => {
    try {
      if (!process.env.PERSONAL_ACCESS_TOKEN) {
        warn('User-Service', 'CSV export missing PERSONAL_ACCESS_TOKEN', {}, req ?? null);
        return res.status(500).json({ message: 'Server configuration error: PERSONAL_ACCESS_TOKEN not set' });
      }

      const users = await User.find({}).select('-password').lean();
      const byEmail = new Map();
      for (const u of users) {
        byEmail.set(String(u.email).toLowerCase(), u);
      }

      const collected = await collectPortalUserWorkspaceRows(byEmail);
      if (!collected.ok) {
        return res.status(502).json({
          message: collected.message || 'Failed to list workspaces from ISO+',
        });
      }

      const seenPair = new Set();
      const finalRows = [];
      for (const r of collected.workspaceRows) {
        const key = `${r.userId}:${r.workspaceId}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        finalRows.push(r);
      }

      const userIdsWithWorkspace = new Set(finalRows.map((r) => r.userId));
      let orphanUserCount = 0;
      for (const u of users) {
        const uid = u._id.toString();
        if (!userIdsWithWorkspace.has(uid)) {
          orphanUserCount += 1;
          finalRows.push({
            userId: uid,
            name: u.name || '',
            email: u.email || '',
            isoplusMemberId: '',
            isoplusUserId: '',
            workspaceId: 'none',
            workspaceName: 'No ISO+ workspace membership',
          });
        }
      }

      finalRows.sort((a, b) => {
        const byE = a.email.localeCompare(b.email);
        if (byE !== 0) return byE;
        return (a.workspaceName || '').localeCompare(b.workspaceName || '');
      });

      const header = [
        'user_id', 'name', 'email',
        'isoplus_member_id', 'isoplus_user_id',
        'workspace_id', 'workspace_name',
      ];
      const lines = [
        header.join(','),
        ...finalRows.map((r) =>
          [
            csvEscape(r.userId),
            csvEscape(r.name),
            csvEscape(r.email),
            csvEscape(r.isoplusMemberId),
            csvEscape(r.isoplusUserId),
            csvEscape(r.workspaceId),
            csvEscape(r.workspaceName),
          ].join(','),
        ),
      ];

      const dateStamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="portal-users-${dateStamp}.csv"`);
      res.send(`\uFEFF${lines.join('\r\n')}`);

      info('User-Service', 'Portal users CSV exported', {
        rowCount: finalRows.length,
        orphanUsersNoIsoWorkspace: orphanUserCount,
      }, req ?? null);
    } catch (err) {
      error('User-Service', 'CSV export failed', { err }, req);
      res.status(500).json({ message: 'Failed to export users' });
    }
  },
);

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
    const userId = toRequiredQueryString(req.params.userId);
    if (!userId) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    
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
    const userId = toRequiredQueryString(req.params.userId);
    if (!userId) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    
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