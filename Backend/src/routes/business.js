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
import {
  updateOrganizationInfo,
} from '../services/xero.js';
import { logAuditTrail } from '../utils/auditLogger.js';
import { logXeroAudit } from '../utils/xeroAuditHelpers.js';
import { collectBusinessProfileErrors } from '../validators/businessProfile.js';
import { toRequiredQueryString } from '../utils/securityHelpers.js';
import {
  applyBusinessLogoUpdates,
  buildBusinessUpdateData,
  documentNumberingForNewBusiness,
  documentNumberingSetPaths,
  parseLogoRemovals,
  updateExistingBusiness,
} from '../utils/businessProfileUpdate.js';
import {
  initialNumberSetPaths,
  initialNumberingForNewBusiness,
  isDocumentNumberingInitialized,
  wantsInitialNumbers,
} from '../utils/documentNumberingInitial.js';
import { repointWorkspaceSchedules } from '../services/scheduler/schedules.js';
import { sanitizeLogValue } from '../utils/sanitizeLog.js';
import { normalizeLineItemMapping, enrichMappingWithTaxRatePercents } from '../utils/xeroLineItemMapping.js';
import { loadXeroChartOptions } from '../utils/xeroAccountTaxHelpers.js';

function mapXeroAccountOptions(rawAccounts) {
  return (rawAccounts || [])
    .map((a) => ({
      code: a.Code ?? a.code ?? '',
      name: a.Name ?? a.name ?? '',
      type: a.Type ?? a.type ?? '',
      class: a.Class ?? a._class ?? a.class ?? '',
      status: a.Status ?? a.status ?? '',
    }))
    .filter((a) => a.code && a.status !== 'ARCHIVED');
}

function mapXeroTaxRateOptions(rawTaxRates) {
  return (rawTaxRates || [])
    .map((t) => ({
      taxType: t.TaxType ?? t.taxType ?? '',
      name: t.Name ?? t.name ?? '',
      status: t.Status ?? t.status ?? '',
      canApplyToRevenue: t.CanApplyToRevenue ?? t.canApplyToRevenue ?? false,
      canApplyToExpenses: t.CanApplyToExpenses ?? t.canApplyToExpenses ?? false,
      effectiveRate: Number(t.EffectiveRate ?? t.effectiveRate ?? t.DisplayTaxRate ?? t.displayTaxRate ?? NaN),
    }))
    .map((t) => ({
      ...t,
      effectiveRate: Number.isFinite(t.effectiveRate) ? t.effectiveRate : null,
    }))
    .filter((t) => t.taxType && t.status !== 'DELETED' && t.status !== 'ARCHIVED');
}

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

// SonarQube S5693: 8 MB max per file upload, 1 MB max per non-file field.
const MULTER_UPLOAD_LIMITS = Object.freeze({
  fileSize: 8 * 1024 * 1024,
  files: 3,
  fields: 50,
  fieldNameSize: 100,
  fieldSize: 1024 * 1024,
});

const upload = multer({
  storage,
  limits: MULTER_UPLOAD_LIMITS,
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
    const business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } }).lean();
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

    const business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } }).lean();
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
    error('Business-Service', 'Error retrieving logo URL', sanitizeLogValue({ 
      error: err.message,
      stack: err.stack,
      workspaceId: req.query.workspaceId,
      logoKey: req.query.logoKey
    }), req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/profile', authenticateToken, multiupload, validateBusinessProfile, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    let incomingNumbering = {};
    if (req.body.documentNumbering) {
      incomingNumbering = JSON.parse(req.body.documentNumbering);
    }

    let business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } });
    // KAN-290: the numbering sequence is read-only here. An existing business
    // takes only its series prefixes, each on its own path; the counters are
    // advanced by the generators that issue the numbers and are never taken from
    // the form. A brand-new business takes its prefixes and starts every counter
    // at 1 (below).
    const updateData = buildBusinessUpdateData({
      ...req.body,
      workspaceId,
      // The request carries the numbering as a JSON string; it is applied below.
      documentNumbering: undefined,
    });
    if (business) Object.assign(updateData, documentNumberingSetPaths(incomingNumbering));
    // KAN-292: the first Finance Settings save sets the first numbers, once.
    const settingInitialNumbers =
      wantsInitialNumbers(req.body) && !isDocumentNumberingInitialized(business);
    const initialPaths = settingInitialNumbers ? initialNumberSetPaths(incomingNumbering) : {};

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
      business = await updateExistingBusiness(business._id, updateData, initialPaths);
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
      const newNumbering = documentNumberingForNewBusiness(incomingNumbering);
      business = new Business({
        ...updateData,
        ...(settingInitialNumbers ? { documentNumberingInitialized: true } : {}),
        documentNumbering: settingInitialNumbers
          ? initialNumberingForNewBusiness(newNumbering, incomingNumbering)
          : newNumbering,
      });
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

    // KAN-262. A schedule's timezone is a snapshot taken from
    // headOfficeTimezone when the automation form was last saved, and nothing
    // re-took it when the business moved — so the run kept firing on the old
    // wall clock, and the "Next Run" caption kept naming a zone the client had
    // already changed. A no-op unless the zone actually moved.
    //
    // Failure here does not fail the request: the profile is already saved, and
    // a schedule row that no longer validates must not stop a client saving
    // their address. It is logged as the error it is, and the next save of the
    // automation form still corrects the schedule the way it always did.
    try {
      await repointWorkspaceSchedules({ workspaceId });
    } catch (err) {
      error('Business-Service', 'Could not re-point automation schedules after a timezone change', {
        workspaceId, message: err.message,
      }, req ?? null);
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

    const business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } });
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
    error('Business-Service', 'Error retrieving logo', sanitizeLogValue({
      error: err.message,
      stack: err.stack,
      workspaceId: req.query.workspaceId,
      logoKey: req.query.logoKey,
    }), req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/qr-logo', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.query.workspaceId);

    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
    }

    const business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } });
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    const logoKey = resolveQrLogoField(business);
    if (!logoKey) {
      return res.status(404).json({ message: 'Logo not found' });
    }

    return streamLogoResponse(req, res, business, logoKey);
  } catch (err) {
    error('Business-Service', 'Error retrieving logo', sanitizeLogValue({ 
      error: err.message,
      stack: err.stack,
      workspaceId: req.query.workspaceId
    }), req ?? null);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/xero/disconnect', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    const business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } });
    if (!business) {
      warn('Business-Service', 'Business not found', { workspaceId }, req ?? null);
      return res.status(404).json({ message: 'Business not found' });
    }

    business.xeroIntegrated = false;
    business.xeroTenantId = null;
    business.xeroTokens = {
      accessToken: null,
      refreshToken: null,
      expiresAt: null
    };
    business.xeroOrganization = null;
    business.xeroLineItemMapping = normalizeLineItemMapping();

    await business.save();
    info('Business-Service', 'Xero integration disconnected', { businessId: business._id }, req ?? null);
    await logXeroAudit({
      workspaceId,
      action: 'Disconnected Xero',
      detail: 'Xero integration disconnected',
      req,
      entityType: 'Business',
      entityId: business?._id?.toString(),
      success: true,
    });
    res.json({ success: true });
  } catch (err) {
    error('Business-Service', 'Server error during Xero disconnection', { message: err.message, stack: err.stack }, req ?? null);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

function isXeroReconnectError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('no xero organisation') ||
    text.includes('no xero organization') ||
    text.includes('reconnect') ||
    text.includes('expired') ||
    text.includes('not authenticated')
  );
}

router.post('/xero/update-organization', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    const business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } });
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
      if (updatedOrganization.organisationId) {
        business.xeroTenantId = updatedOrganization.organisationId;
      }
      await business.save();
      info('Business-Service', 'Xero organization info updated', { businessId: business._id }, req ?? null);
      await logXeroAudit({
        workspaceId,
        action: 'Updated Xero organization info',
        detail: 'Updated Xero organization info',
        req,
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
    const message = err.message || 'Server error';
    const status = isXeroReconnectError(message) ? 409 : 500;
    res.status(status).json({ message });
  }
});

router.get('/xero/account-tax-options', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.query.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    const business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } }).lean();
    if (!business) return res.status(404).json({ message: 'Business not found' });
    if (!business.xeroIntegrated) {
      return res.status(400).json({ message: 'Xero integration not found' });
    }

    const { accounts: rawAccounts, taxRates: rawTaxRates } =
      await loadXeroChartOptions(workspaceId);
    const accounts = mapXeroAccountOptions(rawAccounts);
    const taxRates = mapXeroTaxRateOptions(rawTaxRates);

    info('Business-Service', 'Fetched Xero account/tax options', {
      accounts: accounts.length,
      taxRates: taxRates.length,
    }, req ?? null);
    res.json({ accounts, taxRates });
  } catch (err) {
    error('Business-Service', 'Error fetching Xero account/tax options', {
      message: err.message,
      stack: err.stack,
    }, req ?? null);
    res.status(500).json({
      message: 'Failed to load Xero account and tax options',
    });
  }
});

router.put('/xero/line-item-mapping', authenticateToken, async (req, res) => {
  try {
    const workspaceId = toRequiredQueryString(req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    let mapping = normalizeLineItemMapping(req.body.mapping);
    try {
      const { taxRates: rawTaxRates } = await loadXeroChartOptions(workspaceId);
      mapping = enrichMappingWithTaxRatePercents(mapping, mapXeroTaxRateOptions(rawTaxRates));
    } catch {
      mapping = enrichMappingWithTaxRatePercents(mapping, []);
    }

    const business = await Business.findOneAndUpdate(
      { workspaceId: { $eq: String(workspaceId) } },
      { $set: { xeroLineItemMapping: mapping } },
      { new: true }
    ).lean();

    if (!business) return res.status(404).json({ message: 'Business not found' });

    info('Business-Service', 'Saved Xero line-item mapping', { workspaceId }, req ?? null);
    await logXeroAudit({
      workspaceId,
      action: 'Updated Xero line-item mapping',
      detail: 'Updated Xero account/tax line-item mapping',
      req,
      entityType: 'Business',
      entityId: business?._id?.toString(),
      after: mapping,
      success: true,
    });
    res.json({ success: true, xeroLineItemMapping: business.xeroLineItemMapping });
  } catch (err) {
    error('Business-Service', 'Error saving Xero line-item mapping', {
      message: err.message,
      stack: err.stack,
    }, req ?? null);
    res.status(500).json({ message: 'Failed to save Xero line-item mapping' });
  }
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      warn('Business-Service', 'File upload failed', { message: `File size too large. Maximum size is ${MULTER_UPLOAD_LIMITS.fileSize / (1024 * 1024)}MB` }, req ?? null);
      return res.status(400).json({ status: 'error', message: 'File size too large. Maximum size is 8MB' });
    }
  }
  error('Business-Service', 'File upload failed', { message: err.message || 'An unknown error occurred', stack: err.stack }, req ?? null);
  res.status(500).json({ status: 'error', message: err.message || 'An unknown error occurred' });
});

export default router;