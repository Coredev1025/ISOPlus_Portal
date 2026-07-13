import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import Business from '../models/Business.js';
import { info, error, warn } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  formatBusinessProfileResponse,
  isValidLogoField,
  loadBusinessLogoAsset,
  resolveQrLogoField,
  buildLogoUrls,
} from '../utils/businessLogo.js';
import { updateOrganizationInfo } from '../services/xero.js';
import { logAuditTrail } from '../utils/auditLogger.js';
import { collectBusinessProfileErrors } from '../validators/businessProfile.js';
import { toRequiredQueryString } from '../utils/securityHelpers.js';
import {
  applyBusinessLogoUpdates,
  buildBusinessUpdateData,
  parseLogoRemovals,
} from '../utils/businessProfileUpdate.js';

const validateBusinessProfile = (req, res, next) => {
  const errors = collectBusinessProfileErrors(req.body);
  if (errors.length > 0) {
    warn('Business-Service', 'Validation failed', { errors: errors }, req ?? null);
    return res.status(400).json({
      status: 'error',
      errors: errors
    });
  }
  next();
};

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const storage = multer.memoryStorage();

const LOGO_UPLOAD_MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const LOGO_UPLOAD_MAX_FILES = 3;
const LOGO_UPLOAD_MAX_FIELDS = 50;
const LOGO_UPLOAD_MAX_FIELD_NAME_SIZE = 100;
const LOGO_UPLOAD_MAX_FIELD_SIZE_BYTES = 1024 * 1024;

const upload = multer({
  storage,
  limits: {
    fileSize: LOGO_UPLOAD_MAX_FILE_SIZE_BYTES,
    files: LOGO_UPLOAD_MAX_FILES,
    fields: LOGO_UPLOAD_MAX_FIELDS,
    fieldNameSize: LOGO_UPLOAD_MAX_FIELD_NAME_SIZE,
    fieldSize: LOGO_UPLOAD_MAX_FIELD_SIZE_BYTES,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  }
});
const multiupload = upload.fields([
  { name: 'defaultLogo', maxCount: 1 },
  { name: 'squareLogo', maxCount: 1 },
  { name: 'wideLogo', maxCount: 1 },
]);

const streamLogoResponse = async (req, res, business, logoKey) => {
  const asset = await loadBusinessLogoAsset(business, logoKey);
  if (!asset) {
    return res.status(404).json({ message: 'Logo file not found' });
  }

  info('Business-Service', 'Logo retrieved successfully', {
    workspaceId: business.workspaceId,
    logoKey,
    logoPath: asset.logoPath,
  }, req ?? null);

  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(asset.buffer);
};

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.query.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });
    const business = await Business.findOne({ workspaceId }).lean();
    if (!business) {
      warn('Business-Service', 'Business profile not found', {}, req ?? null);
      return res.status(404).json({ message: 'Business profile not found' });
    }

    const response = await formatBusinessProfileResponse(business);

    info('Business-Service', 'Fetching Business profile data successfully', { businessName: response.name }, req ?? null);
    res.json(response);
  } catch (err) {
    error('Business-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get a short-lived presigned URL when a direct S3 link is required.
router.get('/logo', authenticateToken, async (req, res) => {
  try {
    const { workspaceId: rawWorkspaceId, logoKey } = req.query;
    const workspaceId = toRequiredQueryString(rawWorkspaceId);
    const safeLogoKey = toRequiredQueryString(logoKey);

    if (!workspaceId || !safeLogoKey) {
      return res.status(400).json({ message: 'workspaceId and logoKey are required' });
    }

    if (!isValidLogoField(safeLogoKey)) {
      return res.status(400).json({ message: 'Invalid logoKey' });
    }

    const business = await Business.findOne({ workspaceId }).lean();
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    const logoPath = business[safeLogoKey];
    if (!logoPath) {
      return res.status(404).json({ message: 'Logo not found' });
    }

    const logoUrls = await buildLogoUrls({ [safeLogoKey]: logoPath });
    const logoUrlInfo = logoUrls[safeLogoKey];
    if (!logoUrlInfo?.url) {
      return res.status(404).json({ message: 'Logo file not found' });
    }

    info('Business-Service', 'Logo URL retrieved successfully', { 
      workspaceId, 
      logoKey: safeLogoKey,
      logoPath 
    }, req ?? null);

    res.json(logoUrlInfo);

  } catch (err) {
    error('Business-Service', 'Error retrieving logo URL', { 
      error: err.message,
      stack: err.stack,
      workspaceId: req.query.workspaceId,
      logoKey: req.query.logoKey
    }, req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/profile', authenticateToken, multiupload, validateBusinessProfile, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    let documentNumbering = {};
    if (req.body.documentNumbering) {
      documentNumbering = JSON.parse(req.body.documentNumbering);
    }

    let business = await Business.findOne({ workspaceId });
    const updateData = buildBusinessUpdateData({
      ...req.body,
      workspaceId,
      documentNumbering,
    });

    const logoUpdates = await applyBusinessLogoUpdates({
      workspaceId,
      business,
      files: req.files || {},
      removals: parseLogoRemovals(req.body),
      authorization: req.session.Authorization,
      req,
    });
    Object.assign(updateData, logoUpdates);

    if (business) {
      const before = business?.toObject ? business.toObject() : business;
      business = await Business.findByIdAndUpdate(
        business._id,
        updateData,
        { new: true }
      );
      info('Business-Service', 'Business profile updated', { businessName: business.name }, req ?? null);
      await logAuditTrail({
        workspaceId,
        action: 'Updated Business profile',
        detail: 'Business profile updated',
        req,
        category: 'Business',
        entityType: 'Business',
        entityId: business?._id?.toString(),
        before,
        after: updateData,
        success: true
      });
    } else {
      business = new Business(updateData);
      await business.save();
      info('Business-Service', 'New Business profile created', { businessName: business.name }, req ?? null);
      await logAuditTrail({
        workspaceId,
        action: 'Created new Business profile',
        detail: `Resource ID: ${business._id}`,
        req,
        category: 'Business',
        entityType: 'Business',
        entityId: business?._id?.toString(),
        success: true
      });
    }

    const response = await formatBusinessProfileResponse(business);
    res.status(200).json(response);
  } catch (err) {
    error('Business-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/logo-image', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.query.workspaceId);
    const logoKey = toRequiredQueryString(req.query.logoKey);

    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
    }

    const business = await Business.findOne({ workspaceId });
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    const resolvedLogoKey = logoKey || resolveQrLogoField(business);
    if (!resolvedLogoKey) {
      return res.status(404).json({ message: 'Logo not found' });
    }

    if (logoKey && !isValidLogoField(logoKey)) {
      return res.status(400).json({ message: 'Invalid logoKey' });
    }

    return streamLogoResponse(req, res, business, resolvedLogoKey);
  } catch (err) {
    error('Business-Service', 'Error retrieving logo', {
      error: err.message,
      stack: err.stack,
      workspaceId: req.query.workspaceId,
      logoKey: req.query.logoKey,
    }, req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/qr-logo', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.query.workspaceId);

    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
    }

    const business = await Business.findOne({ workspaceId });
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    const logoKey = resolveQrLogoField(business);
    if (!logoKey) {
      return res.status(404).json({ message: 'Logo not found' });
    }

    return streamLogoResponse(req, res, business, logoKey);
  } catch (err) {
    error('Business-Service', 'Error retrieving logo', { 
      error: err.message,
      stack: err.stack,
      workspaceId: req.query.workspaceId
    }, req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/xero/connect', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });
    const { tokens, organization } = req.body;

    let business = await Business.findOne({ workspaceId });
    if (!business) {
      const now = new Date();
      business = new Business({
        workspaceId,
        xeroIntegrated: true,
        xeroTokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_at,
          refreshTokenExpiresAt: now.getTime() + 60 * 24 * 60 * 60 * 1000
        },
        xeroOrganization: organization || null
      });
      await business.save();
    } else {
      const now = new Date();
      business.xeroIntegrated = true;
      business.xeroTokens = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_at,
        refreshTokenExpiresAt: now.getTime() + 60 * 24 * 60 * 60 * 1000
      };
      if (organization) {
        business.xeroOrganization = organization;
      }
      await business.save();
    }

    info('Business-Service', 'Xero integration connected', { businessId: business._id }, req ?? null);
    res.json({ success: true });
  } catch (err) {
    error('Business-Service', 'Server error during Xero connection', { message: err.message, stack: err.stack }, req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/xero/disconnect', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    const business = await Business.findOne({ workspaceId });
    if (!business) {
      warn('Business-Service', 'Business not found', { workspaceId }, req ?? null);
      return res.status(404).json({ message: 'Business not found' });
    }

    business.xeroIntegrated = false;
    business.xeroTokens = {
      accessToken: null,
      refreshToken: null,
      expiresAt: null
    };
    business.xeroOrganization = null;

    await business.save();
    info('Business-Service', 'Xero integration disconnected', { businessId: business._id }, req ?? null);
    res.json({ success: true });
  } catch (err) {
    error('Business-Service', 'Server error during Xero disconnection', { message: err.message, stack: err.stack }, req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/xero/update-organization', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    const business = await Business.findOne({ workspaceId });
    if (!business) {
      warn('Business-Service', 'Business not found', { workspaceId }, req ?? null);
      return res.status(404).json({ message: 'Business not found' });
    }

    if (!business.xeroIntegrated) {
      warn('Business-Service', 'Xero integration not found', { workspaceId }, req ?? null);
      return res.status(400).json({ message: 'Xero integration not found' });
    }

    const updatedOrganization = await updateOrganizationInfo(workspaceId);

    if (updatedOrganization) {
      business.xeroOrganization = updatedOrganization;
      await business.save();
      info('Business-Service', 'Xero organization info updated', { businessId: business._id }, req ?? null);
      await logAuditTrail({
        workspaceId,
        action: 'Updated Xero organization info',
        detail: 'Updated Xero organization info',
        req,
        category: 'Xero',
        entityType: 'Business',
        entityId: business?._id?.toString(),
        after: updatedOrganization,
        success: true
      });
      res.json({ success: true, organization: updatedOrganization });
    } else {
      error('Business-Service', 'Failed to update Xero organization info', { workspaceId }, req ?? null);
      res.status(500).json({ message: 'Failed to update Xero organization info' });
    }
  } catch (err) {
    error('Business-Service', 'Server error during Xero organization update', { message: err.message, stack: err.stack }, req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      warn('Business-Service', 'File upload failed', { message: 'File size too large. Maximum size is 8MB' }, req ?? null);
      return res.status(400).json({ status: 'error', message: 'File size too large. Maximum size is 8MB' });
    }
  }
  error('Business-Service', 'File upload failed', { message: err.message || 'An unknown error occurred', stack: err.stack }, req ?? null);
  res.status(500).json({ status: 'error', message: err.message || 'An unknown error occurred' });
});

export default router;