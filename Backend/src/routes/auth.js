import express from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { authenticateToken, validateApiKey, requirePortalOwnerOrSupport } from '../middleware/auth.js';
import querystring from 'querystring';
import axios from 'axios';
import { error, info, warn } from '../utils/logger.js';
import { authStep, authFailure, authSuccess } from '../utils/authSentry.js';
import { getMember, listWorkspacesForAuthorization } from '../services/isoplus.js';
import { getFrontendBaseUrl, signOAuthState, verifyOAuthState } from '../utils/helpers.js';
import OAuthTicket from '../models/OAuthTicket.js';
import { getSafeString, toRequiredQueryString } from '../utils/securityHelpers.js';

const router = express.Router();

const OAUTH_TICKET_CLAIM_MS = 45_000;

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

function memberName(m) {
  const raw = m?.name ?? m?.user?.name ?? m?.profile?.name;
  return raw != null ? String(raw).trim() : '';
}

function isoplusCreatedAtFromMember(m) {
  const createdAt =
    m?.created_at ?? m?.user?.created_at ?? m?.profile?.created_at ?? m?.createdAt;
  return createdAt != null && createdAt !== '' ? String(createdAt) : '';
}

function pakAuthorization() {
  const pak = process.env.PERSONAL_ACCESS_TOKEN;
  if (!pak) return null;
  return `Bearer ${pak}`;
}

async function collectWorkspaceMemberRows(req = null) {
  const authorization = pakAuthorization();
  if (!authorization) {
    return { ok: false, workspaceRows: [], message: 'PERSONAL_ACCESS_TOKEN is not configured' };
  }

  const wsResult = await listWorkspacesForAuthorization(authorization);
  if (wsResult.status !== 200) {
    warn('User-Service', 'CSV export workspace list failed', {
      status: wsResult.status,
      message: wsResult.message,
    }, req ?? null);
    return { ok: false, workspaceRows: [], message: wsResult.message };
  }

  const portalUsers = await User.find({}).select('_id email').lean();
  const portalUserIdByEmail = new Map();
  for (const u of portalUsers) {
    if (!u?.email) continue;
    portalUserIdByEmail.set(String(u.email).toLowerCase().trim(), u._id.toString());
  }

  const workspaces = wsResult.workspaces || [];
  info('User-Service', 'CSV export starting workspace member scan', {
    workspaceCount: workspaces.length,
    portalUserCount: portalUserIdByEmail.size,
  }, req ?? null);

  const workspaceRows = [];
  let workspacesSkippedNoId = 0;
  let workspacesMemberFetchFailed = 0;
  let workspacesWithMembers = 0;
  let membersSeen = 0;
  let membersSkippedNoEmail = 0;
  let membersMappedFromPortalDb = 0;
  const memberFetchFailures = [];

  for (const w of workspaces) {
    const wid = w.id;
    if (wid == null) {
      workspacesSkippedNoId += 1;
      continue;
    }
    const wname = w.name || w.label || '';
    const mem = await getMember(authorization, wid);
    if (mem.status !== 200 || !Array.isArray(mem.members)) {
      workspacesMemberFetchFailed += 1;
      if (memberFetchFailures.length < 5) {
        memberFetchFailures.push({
          workspaceId: String(wid),
          workspaceName: String(wname),
          status: mem.status,
          message: mem.message || null,
        });
      }
      continue;
    }

    if (mem.members.length > 0) workspacesWithMembers += 1;
    membersSeen += mem.members.length;

    for (const m of mem.members) {
      const email = memberEmailLower(m);
      if (!email) {
        membersSkippedNoEmail += 1;
        continue;
      }

      const { memberId: isoplusMemberId, userId: apiIsoplusUserId } = isoplusIdsFromWorkspaceMember(m);
      const portalMongoId = portalUserIdByEmail.get(email) || '';
      if (portalMongoId) membersMappedFromPortalDb += 1;
      const isoplusUserId = portalMongoId || apiIsoplusUserId || '';

      workspaceRows.push({
        name: memberName(m),
        email,
        isoplusCreatedAt: isoplusCreatedAtFromMember(m),
        isoplusMemberId,
        isoplusUserId,
        workspaceId: String(wid),
        workspaceName: String(wname),
      });
    }
  }

  const summary = {
    workspaceCount: workspaces.length,
    workspacesSkippedNoId,
    workspacesMemberFetchFailed,
    workspacesWithMembers,
    membersSeen,
    membersSkippedNoEmail,
    membersMappedFromPortalDb,
    exportRowCount: workspaceRows.length,
    sampleMemberFetchFailures: memberFetchFailures,
  };

  if (workspaceRows.length === 0) {
    warn('User-Service', 'CSV export produced no member rows', summary, req ?? null);
  } else {
    info('User-Service', 'CSV export workspace member scan complete', summary, req ?? null);
  }

  return { ok: true, workspaceRows, summary };
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
    const authMethod = 'support-admin';
    authStep(req, { authMethod, stage: 'login_started', message: 'Support admin login started' });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      authFailure(req, {
        authMethod,
        stage: 'validation',
        message: 'Support admin login failed: validation error',
        reason: 'Request validation failed',
        httpStatus: 400,
        data: { errorCount: errors.array().length },
      });
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const email = getSafeString(req.body.email);
      const password = getSafeString(req.body.password);
      if (!email || !password) {
        authFailure(req, {
          authMethod,
          stage: 'invalid_input',
          message: 'Support admin login failed: invalid input',
          httpStatus: 400,
          email,
        });
        return res.status(400).json({ message: 'Invalid login input' });
      }

      authStep(req, { authMethod, stage: 'lookup_user', message: 'Looking up support admin user', email });
      const user = await User.findOne({ email });

      if (!user || !(await user.comparePassword(password))) {
        authFailure(req, {
          authMethod,
          stage: 'invalid_credentials',
          message: 'Support admin login failed: invalid credentials',
          reason: user ? 'Password mismatch' : 'No account for email',
          httpStatus: 401,
          email,
          data: { userExists: !!user },
        });
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      authStep(req, {
        authMethod,
        stage: 'credentials_ok',
        message: 'Support admin credentials validated',
        email,
        userId: user._id?.toString(),
      });

      if (user.disabled) {
        authFailure(req, {
          authMethod,
          stage: 'account_disabled',
          message: 'Support admin login failed: account disabled',
          httpStatus: 403,
          email,
          userId: user._id?.toString(),
        });
        return res.status(403).json({ message: 'Account is disabled' });
      }

      authStep(req, {
        authMethod,
        stage: 'issue_session',
        message: 'Issuing support admin session JWT',
        email,
        userId: user._id?.toString(),
      });

      const token = jwt.sign(
        { userId: user._id, email: user.email, name: user.name, role: 'support_admin', avatar: '' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      req.session.token = token;
      await req.session.save();

      authSuccess(req, {
        authMethod,
        message: 'Support admin login successful',
        email,
        userId: user._id?.toString(),
      });
      res.json({ user: { id: user._id, email, name: user.name, role: 'support_admin', avatar: '' } });
    } catch (err) {
      authFailure(req, {
        authMethod,
        stage: 'server_error',
        message: 'Support admin login failed: server error',
        reason: err?.message,
        httpStatus: 500,
        level: 'error',
        email: req.body?.email,
        error: err,
      });
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
  const authMethod = 'isoplus-oauth';
  authStep(req, { authMethod, stage: 'redirect_started', message: 'Building ISO+ OAuth redirect URI' });

  const state = signOAuthState({ flow: 'isoplus-login' });

  const query = querystring.stringify({
    client_id: process.env.CLIENT_ID,
    redirect_uri: `${process.env.CALLBACK_URL}`,
    response_type: "code",
    scope: "public-api internal-api",
    state: state,
  });

  authStep(req, {
    authMethod,
    stage: 'redirect_ready',
    message: 'ISO+ OAuth redirect URI ready',
    data: {
      hasClientId: !!process.env.CLIENT_ID,
      hasAuthorizationEndpoint: !!process.env.AUTHORIZATION_ENDPOINT,
      hasCallbackUrl: !!process.env.CALLBACK_URL,
    },
  });

  res.json({ redirect_uri: `${process.env.AUTHORIZATION_ENDPOINT}?${query}` });
});

router.get("/isoplus/callback", async (req, res) => {
  const authMethod = 'isoplus-oauth';
  const { code, state } = req.query;
  const frontendBase = getFrontendBaseUrl();
  const loginErrorRedirect = (reason) =>
    `${frontendBase}/?login=error${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`;

  authStep(req, {
    authMethod,
    stage: 'callback_received',
    message: 'ISO+ OAuth callback received',
    data: {
      hasCode: !!code,
      hasState: !!state,
      oauthError: req.query?.error,
      oauthErrorDescription: req.query?.error_description,
    },
  });

  if (!code) {
    authFailure(req, {
      authMethod,
      stage: 'callback_missing_code',
      message: 'ISO+ OAuth callback failed: authorization code missing',
      reason: 'No authorization code in callback query',
      data: {
        hasCode: false,
        hasState: !!state,
        oauthError: req.query?.error,
        oauthErrorDescription: req.query?.error_description,
      },
    });
    return res.redirect(loginErrorRedirect('missing_code'));
  }

  authStep(req, { authMethod, stage: 'verify_state', message: 'Verifying OAuth state parameter' });
  const stateResult = verifyOAuthState(typeof state === 'string' ? state : null);
  if (!stateResult.ok) {
    const reasonMap = {
      absent: 'State parameter absent',
      expired: 'OAuth state JWT expired (user took too long or replayed callback)',
      invalid_signature: 'OAuth state JWT signature invalid (wrong JWT_SECRET or tampered state)',
    };
    const clientReason =
      stateResult.reason === 'expired'
        ? 'state_expired'
        : stateResult.reason === 'absent'
          ? 'state_missing'
          : 'state_invalid';
    authFailure(req, {
      authMethod,
      stage: 'callback_invalid_state',
      message: 'ISO+ OAuth callback failed: invalid or missing state',
      reason: reasonMap[stateResult.reason] || 'State verification failed',
      data: {
        hasCode: true,
        hasState: !!state,
        stateReason: stateResult.reason,
        stateErrorName: stateResult.errorName,
      },
    });
    return res.redirect(loginErrorRedirect(clientReason));
  }

  authStep(req, { authMethod, stage: 'state_ok', message: 'OAuth state verified' });

  try {
    authStep(req, {
      authMethod,
      stage: 'token_exchange_start',
      message: 'Exchanging authorization code for access token',
      data: { tokenEndpoint: process.env.TOKEN_ENDPOINT },
    });

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
      authFailure(req, {
        authMethod,
        stage: 'token_exchange',
        message: 'ISO+ OAuth callback failed: token endpoint returned no access_token',
        reason: 'Token response missing access_token',
        upstreamStatus: tokenResponse.status,
        data: {
          upstreamError: tokenResponse.data,
          tokenEndpoint: process.env.TOKEN_ENDPOINT,
        },
      });
      return res.redirect(loginErrorRedirect('token_exchange'));
    }

    authStep(req, {
      authMethod,
      stage: 'token_exchange_ok',
      message: 'Access token received from token endpoint',
      data: { upstreamStatus: tokenResponse.status },
    });

    const accessToken = tokenResponse.data.access_token;

    authStep(req, {
      authMethod,
      stage: 'profile_fetch_start',
      message: 'Fetching ISO+ user profile',
      data: { profileEndpoint: process.env.USER_INFORMATION_ENDPOINT },
    });

    const userResponse = await axios.get(`${process.env.USER_INFORMATION_ENDPOINT}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-Version": "2025-02-26.morava",
      }
    });

    if (!userResponse.data) {
      authFailure(req, {
        authMethod,
        stage: 'profile_fetch',
        message: 'ISO+ OAuth callback failed: profile endpoint returned no data',
        reason: 'User information response was empty',
        upstreamStatus: userResponse.status,
        data: { profileEndpoint: process.env.USER_INFORMATION_ENDPOINT },
      });
      return res.redirect(loginErrorRedirect('profile_fetch'));
    }

    const safeUserData = {
      id: userResponse.data.id,
      email: userResponse.data.email,
      name: userResponse.data.name,
      photo_url: userResponse.data.photo_url
    };

    authStep(req, {
      authMethod,
      stage: 'profile_fetch_ok',
      message: 'ISO+ user profile fetched',
      email: safeUserData.email,
      userId: safeUserData.id,
      data: { upstreamStatus: userResponse.status },
    });

    authStep(req, {
      authMethod,
      stage: 'ticket_create',
      message: 'Creating one-time OAuth ticket',
      email: safeUserData.email,
      userId: safeUserData.id,
    });

    const { ticket } = await OAuthTicket.create({
      accessToken,
      oauthData: safeUserData,
    });

    authStep(req, {
      authMethod,
      stage: 'ticket_created',
      message: 'OAuth ticket created; redirecting to frontend',
      email: safeUserData.email,
      userId: safeUserData.id,
      data: { hasTicket: !!ticket },
    });

    return res.redirect(`${frontendBase}/?ticket=${ticket}`);
  } catch (err) {
    const failedUrl = err.config?.url;
    const stage = failedUrl === process.env.USER_INFORMATION_ENDPOINT ? 'profile_fetch' : 'token_exchange';
    authFailure(req, {
      authMethod,
      stage,
      message: `ISO+ OAuth callback failed: ${stage} request error`,
      reason: err.message,
      level: 'error',
      upstreamStatus: err.response?.status,
      error: err,
      data: {
        upstreamError: err.response?.data || err.message,
        failedUrl,
        errorCode: err.code,
        isTimeout: err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT',
      },
    });
    return res.redirect(loginErrorRedirect(stage));
  }
});

function normalizeOAuthEmail(raw) {
  const email = getSafeString(raw)?.toLowerCase();
  return email || null;
}

async function findOrCreateOAuthUser(req, { authMethod, email, oauthId, name, photo_url }) {
  authStep(req, {
    authMethod,
    stage: 'lookup_or_create_user',
    message: 'Looking up portal user by oauthId or email',
    email,
    userId: oauthId,
  });

  let user = await User.findOne({ oauthId });
  if (!user) {
    user = await User.findOne({ email });
  }

  if (!user) {
    authStep(req, {
      authMethod,
      stage: 'create_user',
      message: 'Creating new portal user from OAuth profile',
      email,
      userId: oauthId,
    });
    user = new User({
      email,
      name,
      password: '',
      oauthId,
      avatar: photo_url,
      role: 'isoplus_user',
    });
    await user.save();
    return user;
  }

  authStep(req, {
    authMethod,
    stage: 'update_user_profile',
    message: 'Updating existing portal user profile from OAuth',
    email,
    userId: user._id?.toString(),
  });
  user.avatar = photo_url;
  user.name = name;
  if (!user.oauthId) user.oauthId = oauthId;
  if (user.email !== email) user.email = email;
  await user.save();
  return user;
}

async function claimOAuthTicket(safeTicket) {
  const staleBefore = new Date(Date.now() - OAUTH_TICKET_CLAIM_MS);
  return OAuthTicket.findOneAndUpdate(
    {
      ticket: safeTicket,
      $or: [
        { claimedAt: null },
        { claimedAt: { $exists: false } },
        { claimedAt: { $lte: staleBefore } },
      ],
    },
    { $set: { claimedAt: new Date() } },
    { new: true }
  );
}

async function releaseOAuthTicketClaim(ticketId) {
  if (!ticketId) return;
  await OAuthTicket.updateOne({ _id: ticketId }, { $unset: { claimedAt: 1 } }).catch(() => {});
}

async function establishOAuthSession(req, { authorization, oauthData, method = 'oauth-exchange' }) {
  const authMethod = method;
  const email = normalizeOAuthEmail(oauthData?.email?.toString());
  const oauthId = getSafeString(oauthData?.id?.toString());
  const name = oauthData?.name?.toString();
  const photo_url = oauthData?.photo_url?.toString();

  authStep(req, {
    authMethod,
    stage: 'establish_session_start',
    message: 'Establishing OAuth session',
    email,
    userId: oauthId,
    data: { hasEmail: !!email, hasOauthId: !!oauthId, hasName: !!name },
  });

  if (!email || !oauthId) {
    authFailure(req, {
      authMethod,
      stage: 'invalid_profile',
      message: 'OAuth login failed: incomplete profile data',
      reason: 'OAuth profile is missing email or id',
      httpStatus: 400,
      email,
      data: { hasEmail: !!email, hasOauthId: !!oauthId },
    });
    return { status: 400, body: { message: 'Invalid OAuth profile data' } };
  }

  let user;
  try {
    user = await findOrCreateOAuthUser(req, { authMethod, email, oauthId, name, photo_url });
  } catch (err) {
    if (err?.code === 11000) {
      authFailure(req, {
        authMethod,
        stage: 'user_conflict',
        message: 'OAuth login failed: user record conflict',
        reason: err.message,
        httpStatus: 409,
        email,
        userId: oauthId,
        error: err,
      });
      return { status: 409, body: { message: 'Account conflict during OAuth login. Please try again.' } };
    }
    throw err;
  }

  if (user.disabled) {
    authFailure(req, {
      authMethod,
      stage: 'account_disabled',
      message: 'OAuth login failed: account disabled',
      httpStatus: 403,
      email,
      userId: user._id?.toString(),
    });
    return { status: 403, body: { message: 'Account is disabled' } };
  }

  req.session.Authorization = authorization;

  authStep(req, {
    authMethod,
    stage: 'issue_session',
    message: 'Issuing portal session JWT',
    email: user.email,
    userId: user._id?.toString(),
    data: { role: user.role },
  });

  const token = jwt.sign(
    {
      userId: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatar: user.avatar,
    },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  req.session.token = token;
  await req.session.save();

  authSuccess(req, {
    authMethod,
    message: 'OAuth login successful',
    email: user.email,
    userId: user._id?.toString(),
    data: { role: user.role },
  });

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
  const authMethod = 'oauth-exchange';
  authStep(req, { authMethod, stage: 'exchange_started', message: 'OAuth ticket exchange started' });

  let claimedTicketId = null;

  try {
    const { ticket } = req.body;
    const safeTicket = getSafeString(ticket);
    if (!safeTicket) {
      authFailure(req, {
        authMethod,
        stage: 'ticket_missing',
        message: 'OAuth exchange failed: ticket missing or malformed',
        httpStatus: 400,
        data: { ticketType: typeof ticket },
      });
      return res.status(400).json({ message: 'Ticket is required' });
    }

    authStep(req, {
      authMethod,
      stage: 'ticket_redeem_start',
      message: 'Claiming OAuth ticket for session exchange',
    });

    const record = await claimOAuthTicket(safeTicket);
    if (!record) {
      const existing = await OAuthTicket.findOne({ ticket: safeTicket }).lean();
      if (existing) {
        authFailure(req, {
          authMethod,
          stage: 'ticket_claim_in_progress',
          message: 'OAuth exchange failed: ticket claim already in progress',
          reason: 'Another exchange is using this ticket (retry shortly)',
          httpStatus: 409,
        });
        return res.status(409).json({
          message: 'Login already in progress. Please wait a moment and try again.',
          retryable: true,
        });
      }
      authFailure(req, {
        authMethod,
        stage: 'ticket_redeem',
        message: 'OAuth exchange failed: ticket invalid, expired, or already used',
        reason: 'No matching ticket (single-use, 300s TTL — already redeemed or expired)',
        httpStatus: 401,
      });
      return res.status(401).json({ message: 'Invalid or expired login ticket' });
    }

    claimedTicketId = record._id;

    authStep(req, {
      authMethod,
      stage: 'ticket_redeem_ok',
      message: 'OAuth ticket claimed',
      email: record.oauthData?.email,
      userId: record.oauthData?.id,
    });

    const result = await establishOAuthSession(req, {
      authorization: `Bearer ${record.accessToken}`,
      oauthData: record.oauthData,
      method: 'oauth-exchange',
    });

    if (result.status === 200) {
      await OAuthTicket.deleteOne({ _id: record._id });
      claimedTicketId = null;
    } else {
      await releaseOAuthTicketClaim(record._id);
      claimedTicketId = null;
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    await releaseOAuthTicketClaim(claimedTicketId);
    authFailure(req, {
      authMethod,
      stage: 'server_error',
      message: 'OAuth exchange failed: server error',
      reason: err?.message,
      httpStatus: 500,
      level: 'error',
      error: err,
    });
    res.status(500).json({ message: 'Server error during OAuth exchange' });
  }
});

router.post('/oauth-login', async (req, res) => {
  const authMethod = 'oauth-login';
  authStep(req, { authMethod, stage: 'legacy_oauth_login_started', message: 'Legacy OAuth login started' });

  try {
    const { oauthData } = req.body;
    const result = await establishOAuthSession(req, {
      authorization: req.headers['authorization'],
      oauthData,
      method: 'oauth-login',
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    authFailure(req, {
      authMethod,
      stage: 'server_error',
      message: 'Legacy OAuth login failed: server error',
      reason: err?.message,
      httpStatus: 500,
      level: 'error',
      email: req.body?.oauthData?.email,
      error: err,
    });
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

      const collected = await collectWorkspaceMemberRows(req);
      if (!collected.ok) {
        return res.status(502).json({
          message: collected.message || 'Failed to list workspaces from ISO+',
        });
      }

      // Dedupe per (email, workspace) in case a member is returned more than once.
      const seenPair = new Set();
      const finalRows = [];
      for (const r of collected.workspaceRows) {
        const key = `${String(r.email).toLowerCase()}:${r.workspaceId}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        finalRows.push(r);
      }

      finalRows.sort((a, b) => {
        const byE = a.email.localeCompare(b.email);
        if (byE !== 0) return byE;
        return (a.workspaceName || '').localeCompare(b.workspaceName || '');
      });

      const header = [
        'name', 'email', 'created_at',
        'isoplus_member_id', 'isoplus_user_id',
        'workspace_id', 'workspace_name',
      ];
      const lines = [
        header.join(','),
        ...finalRows.map((r) =>
          [
            csvEscape(r.name),
            csvEscape(r.email),
            csvEscape(r.isoplusCreatedAt),
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

      info('User-Service', 'ISO+ workspace members CSV exported', {
        rowCount: finalRows.length,
        ...(collected.summary ? { scan: collected.summary } : {}),
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