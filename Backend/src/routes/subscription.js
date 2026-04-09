import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { authenticateToken } from '../middleware/auth.js';
import Subscription from '../models/Subscription.js';
import { info, error as logError } from '../utils/logger.js';
import sanitizeHtml from 'sanitize-html';

const router = express.Router();

// ─── Public: Get Xero OAuth URL for sign-up ───────────────────────────────────
router.get('/xero-auth-url', (req, res) => {
  try {
    const clientId = process.env.XERO_CLIENT_ID;
    const redirectUri = process.env.XERO_SIGNUP_REDIRECT_URL;

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

// ─── Public: Handle Xero OAuth callback ────────────────────────────────────────
router.post('/xero-callback', async (req, res) => {
  try {
    const { code, state } = req.body;

    if (!code || !state) {
      return res.status(400).json({ message: 'Missing code or state parameter' });
    }

    // Validate state to prevent CSRF
    if (state !== req.session.xeroSignupState) {
      logError('Subscription', 'Invalid state parameter in Xero callback', {}, req);
      return res.status(400).json({ message: 'Invalid state parameter' });
    }

    // Clear the state after validation
    delete req.session.xeroSignupState;

    const clientId = process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_CLIENT_SECRET;
    const redirectUri = process.env.XERO_SIGNUP_REDIRECT_URL;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).json({ message: 'Xero sign-up is not configured' });
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
      return res.status(400).json({ message: 'Failed to retrieve identity information from Xero' });
    }

    // Decode the ID token (JWT) to extract user info
    // Note: For production hardening, verify against Xero's JWKS endpoint
    const decoded = jwt.decode(id_token);

    if (!decoded || !decoded.sub || !decoded.email) {
      logError('Subscription', 'Invalid ID token payload', { decoded }, req);
      return res.status(400).json({ message: 'Invalid identity information from Xero' });
    }

    const { given_name, family_name, email, sub: xeroUserId } = decoded;

    // Check for existing subscription with this Xero user
    const existing = await Subscription.findOne({ xeroUserId });
    if (existing) {
      info('Subscription', 'Duplicate sign-up attempt', { xeroUserId, email }, req);
      return res.json({
        success: true,
        message: 'You have already signed up. We will be in touch shortly.',
        duplicate: true
      });
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

    res.json({
      success: true,
      message: 'Sign-up request received! We will be in touch shortly.'
    });
  } catch (err) {
    logError('Subscription', 'Error processing Xero callback', {
      message: err.message,
      stack: err.stack
    }, req);
    res.status(500).json({ message: 'Failed to process sign-up request' });
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

    const total = await Subscription.countDocuments(filter);
    const subscriptions = await Subscription.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

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
