import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { authenticateToken } from '../middleware/auth.js';
import Subscription from '../models/Subscription.js';
import { info, error as logError } from '../utils/logger.js';
import sanitizeHtml from 'sanitize-html';

const router = express.Router();

/**
 * Derives the signup callback URL from the existing XERO_REDIRECT_URL.
 * E.g. https://example.ngrok.app/api/xero/callback → https://example.ngrok.app/api/subscriptions/xero-callback
 */
function getSignupRedirectUri() {
  const xeroRedirectUrl = process.env.XERO_REDIRECT_URL;
  if (!xeroRedirectUrl) return null;
  const parsed = new URL(xeroRedirectUrl);
  return `${parsed.origin}/api/subscriptions/xero-callback`;
}

// ─── Public: Get Xero OAuth URL for sign-up ───────────────────────────────────
router.get('/xero-auth-url', (req, res) => {
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

    const state = Math.random().toString(36).substring(2, 15);
    req.session.xeroSignupState = state;

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
});

// ─── Public: Handle Xero OAuth callback (GET — Xero redirects here) ───────────
router.get('/xero-callback', async (req, res) => {
  const sendCallbackPage = (success, message, duplicate = false) => {
    // Return an HTML page that posts a message to the opener window and closes
    const type = success ? 'XERO_SIGNUP_SUCCESS' : 'XERO_SIGNUP_ERROR';
    const payload = success
      ? JSON.stringify({ type, message, duplicate })
      : JSON.stringify({ type, error: message });

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html><head><title>Xero Sign Up</title></head>
<body>
<p>${success ? message : 'An error occurred. You can close this window.'}</p>
<script>
  if (window.opener) {
    window.opener.postMessage(${payload}, '*');
  }
  setTimeout(function() { window.close(); }, 2000);
</script>
</body></html>`);
  };

  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return sendCallbackPage(false, 'Missing code or state parameter');
    }

    // Validate state to prevent CSRF
    if (state !== req.session.xeroSignupState) {
      logError('Subscription', 'Invalid state parameter in Xero callback', {}, req);
      return sendCallbackPage(false, 'Invalid state parameter');
    }

    // Clear the state after validation
    delete req.session.xeroSignupState;

    const clientId = process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_CLIENT_SECRET;
    const redirectUri = getSignupRedirectUri();

    if (!clientId || !clientSecret || !redirectUri) {
      return sendCallbackPage(false, 'Xero sign-up is not configured');
    }

    // Exchange authorization code for tokens
    const tokenResponse = await axios.post(
      'https://identity.xero.com/connect/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
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

    // Decode the ID token (JWT) to extract user info
    // Note: For production hardening, verify against Xero's JWKS endpoint
    const decoded = jwt.decode(id_token);

    if (!decoded || !decoded.sub || !decoded.email) {
      logError('Subscription', 'Invalid ID token payload', { decoded }, req);
      return sendCallbackPage(false, 'Invalid identity information from Xero');
    }

    const { given_name, family_name, email, sub: xeroUserId } = decoded;

    // Check for existing subscription with this Xero user
    const existing = await Subscription.findOne({ xeroUserId });
    if (existing) {
      info('Subscription', 'Duplicate sign-up attempt', { xeroUserId, email }, req);
      return sendCallbackPage(true, 'You have already signed up. We will be in touch shortly.', true);
    }

    // Create new subscription lead
    const subscription = new Subscription({
      givenName: sanitizeHtml(given_name || '', { allowedTags: [], allowedAttributes: {} }),
      familyName: sanitizeHtml(family_name || '', { allowedTags: [], allowedAttributes: {} }),
      email: sanitizeHtml(email, { allowedTags: [], allowedAttributes: {} }),
      xeroUserId,
      status: 'request_received'
    });

    await subscription.save();

    info('Subscription', 'New subscription lead created', {
      subscriptionId: subscription._id,
      email,
      xeroUserId
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

// ─── Protected: List subscriptions (owner / support_admin only) ────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

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
        { xeroUserId: { $regex: sanitized, $options: 'i' } }
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
          xeroUserId: 1,
          status: 1,
          notes: 1,
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

// ─── Protected: Update subscription (owner / support_admin only) ───────────────
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

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
