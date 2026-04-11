import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { authenticateToken, requirePortalOwnerOrSupport } from '../middleware/auth.js';
import Subscription from '../models/Subscription.js';
import { info, error as logError } from '../utils/logger.js';
import sanitizeHtml from 'sanitize-html';

const router = express.Router();

const XERO_SIGNUP_STATE_PURPOSE = 'xero_signup_oauth';
const LEAD_EXTRA_FIELDS = ['companyName', 'phone', 'applicantMessage'];
const MAX_LEAD_FIELD_LEN = 240;

function sanitizeLeadExtras(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const key of LEAD_EXTRA_FIELDS) {
    const v = raw[key];
    if (typeof v !== 'string') continue;
    out[key] = sanitizeHtml(v, { allowedTags: [], allowedAttributes: {} }).trim().slice(0, MAX_LEAD_FIELD_LEN);
  }
  return out;
}

function signXeroSignupState(extras = {}) {
  const cleaned = sanitizeLeadExtras(extras);
  const payload = { purpose: XERO_SIGNUP_STATE_PURPOSE };
  if (Object.keys(cleaned).length) payload.extras = cleaned;
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
}

function parseXeroSignupState(state) {
  if (!state || typeof state !== 'string') return null;
  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded?.purpose !== XERO_SIGNUP_STATE_PURPOSE) return null;
    return { extras: sanitizeLeadExtras(decoded.extras || {}) };
  } catch {
    return null;
  }
}

function getSignupRedirectUri() {
  const xeroRedirectUrl = process.env.XERO_REDIRECT_URL;
  if (!xeroRedirectUrl) return null;
  const parsed = new URL(xeroRedirectUrl);
  return `${parsed.origin}/api/subscriptions/xero-callback`;
}

function handleXeroAuthUrl(req, res, extras = {}) {
  try {
    const clientId = process.env.XERO_CLIENT_ID;
    const redirectUri = getSignupRedirectUri();

    if (!clientId || !redirectUri) {
      logError('Subscription', 'Xero sign-up not configured', {
        hasClientId: !!clientId,
        hasRedirectUri: !!redirectUri
      }, req);
      return res.status(500).json({ message: 'Xero sign-up is not configured' });
    }

    const state = signXeroSignupState(extras);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state
    });

    const url = `https://login.xero.com/identity/connect/authorize?${params.toString()}`;

    info('Subscription', 'Xero sign-up auth URL generated', {}, req);
    res.json({ url });
  } catch (err) {
    logError('Subscription', 'Error generating Xero auth URL', { message: err.message }, req);
    res.status(500).json({ message: 'Failed to generate Xero auth URL' });
  }
}

router.get('/xero-auth-url', (req, res) => handleXeroAuthUrl(req, res, {}));

router.post('/xero-auth-url', (req, res) => handleXeroAuthUrl(req, res, req.body || {}));

router.get('/xero-callback', async (req, res) => {
  const sendCallbackPage = (success, message, duplicate = false) => {
    const dataObj = success
      ? { type: 'XERO_SIGNUP_SUCCESS', message, duplicate }
      : { type: 'XERO_SIGNUP_ERROR', error: message };

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html><head><title>Xero Sign Up</title></head>
<body>
<p>${success ? message.replace(/</g, '&lt;') : 'An error occurred. You can close this window.'}</p>
<script>
  if (window.opener) {
    window.opener.postMessage(${JSON.stringify(dataObj)}, '*');
  }
  setTimeout(function() { window.close(); }, 2000);
</script>
</body></html>`);
  };

  try {
    const codeParam = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
    const stateParam = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;

    if (!codeParam || !stateParam) {
      return sendCallbackPage(false, 'Missing code or state parameter');
    }

    const parsedState = parseXeroSignupState(stateParam);
    if (!parsedState) {
      logError('Subscription', 'Invalid state parameter in Xero callback', {}, req);
      return sendCallbackPage(false, 'Invalid state parameter');
    }
    const { extras: leadExtras } = parsedState;

    const clientId = process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_CLIENT_SECRET;
    const redirectUri = getSignupRedirectUri();

    if (!clientId || !clientSecret || !redirectUri) {
      return sendCallbackPage(false, 'Xero sign-up is not configured');
    }

    const tokenResponse = await axios.post(
      'https://identity.xero.com/connect/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: codeParam,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const { id_token } = tokenResponse.data;

    if (!id_token) {
      logError('Subscription', 'No id_token in Xero token response', {}, req);
      return sendCallbackPage(false, 'Failed to retrieve identity information from Xero');
    }

    const decoded = jwt.decode(id_token);

    if (!decoded || !decoded.sub || !decoded.email) {
      logError('Subscription', 'Invalid ID token payload', { decoded }, req);
      return sendCallbackPage(false, 'Invalid identity information from Xero');
    }

    const { given_name, family_name, email, sub: jwtSub } = decoded;
    const xeroUidClaim =
      typeof decoded.xero_userid === 'string' && decoded.xero_userid.trim()
        ? decoded.xero_userid.trim()
        : jwtSub;

    const givenName = sanitizeHtml(given_name || '', { allowedTags: [], allowedAttributes: {} }).trim() || '—';
    const familyName = sanitizeHtml(family_name || '', { allowedTags: [], allowedAttributes: {} }).trim() || '—';
    const emailClean = sanitizeHtml(email, { allowedTags: [], allowedAttributes: {} }).trim().toLowerCase();

    const existing = await Subscription.findOne({
      $or: [{ sub: jwtSub }, { xeroUserId: jwtSub }, { xeroUserId: xeroUidClaim }]
    });
    if (existing) {
      info('Subscription', 'Duplicate sign-up attempt', { jwtSub, xeroUidClaim, email }, req);
      return sendCallbackPage(true, 'You have already signed up. We will be in touch shortly.', true);
    }

    const subscription = new Subscription({
      givenName,
      familyName,
      email: emailClean,
      sub: jwtSub,
      xeroUserId: xeroUidClaim,
      status: 'request_received',
      companyName: leadExtras.companyName || '',
      phone: leadExtras.phone || '',
      applicantMessage: leadExtras.applicantMessage || ''
    });

    await subscription.save();

    info('Subscription', 'New subscription lead created', {
      subscriptionId: subscription._id,
      email,
      sub: jwtSub,
      xeroUserId: xeroUidClaim
    }, req);

    sendCallbackPage(true, 'Sign-up request received! We will be in touch shortly.');
  } catch (err) {
    logError('Subscription', 'Error processing Xero callback', {
      message: err.message,
      stack: err.stack
    }, req);
    sendCallbackPage(false, 'Failed to process sign-up request');
  }
});

router.get('/', authenticateToken, requirePortalOwnerOrSupport, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const search = req.query.search || '';

    const filter = {};
    if (search) {
      const sanitized = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { givenName: { $regex: sanitized, $options: 'i' } },
        { familyName: { $regex: sanitized, $options: 'i' } },
        { email: { $regex: sanitized, $options: 'i' } },
        { companyName: { $regex: sanitized, $options: 'i' } },
        { phone: { $regex: sanitized, $options: 'i' } },
        { applicantMessage: { $regex: sanitized, $options: 'i' } },
        { xeroUserId: { $regex: sanitized, $options: 'i' } },
        { sub: { $regex: sanitized, $options: 'i' } }
      ];
    }

    if (req.query.status && req.query.status !== 'all') {
      filter.status = req.query.status;
    }

    const skip = (page - 1) * limit;
    const [total, subscriptions] = await Promise.all([
      Subscription.countDocuments(filter),
      Subscription.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select({
          givenName: 1,
          familyName: 1,
          email: 1,
          sub: 1,
          xeroUserId: 1,
          status: 1,
          notes: 1,
          companyName: 1,
          phone: 1,
          applicantMessage: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .lean(),
    ]);

    res.json({
      subscriptions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    logError('Subscription', 'Error fetching subscriptions', { message: err.message }, req);
    res.status(500).json({ message: 'Failed to fetch subscriptions' });
  }
});

router.patch('/:id', authenticateToken, requirePortalOwnerOrSupport, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const updateFields = {};

    if (status !== undefined) {
      const validStatuses = ['request_received', 'account_created'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      }
      updateFields.status = status;
    }

    if (notes !== undefined) {
      updateFields.notes = sanitizeHtml(notes, { allowedTags: [], allowedAttributes: {} });
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    const subscription = await Subscription.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: true }
    );

    if (!subscription) {
      return res.status(404).json({ message: 'Subscription not found' });
    }

    info('Subscription', 'Subscription updated', {
      subscriptionId: id,
      updatedFields: Object.keys(updateFields),
      updatedBy: req.user.email || req.user.userId
    }, req);

    res.json({ success: true, subscription });
  } catch (err) {
    logError('Subscription', 'Error updating subscription', {
      message: err.message,
      id: req.params.id
    }, req);
    res.status(500).json({ message: 'Failed to update subscription' });
  }
});

export default router;
