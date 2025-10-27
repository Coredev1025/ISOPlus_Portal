import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import Business from '../models/Business.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import AuditTrail from '../models/AuditTrail.js';
import { uploadFileToS3, getS3FileUrl, deleteFileFromS3, getS3File, getContentType } from '../utils/uploadS3.js'; // Import S3 utility functions
import { setLogo } from '../services/isoplus.js';
import { updateOrganizationInfo } from '../services/xero.js';

const validateBusinessProfile = (req, res, next) => {
  const errors = [];
  if (!req.body.name || req.body.name.length > 100) {
    errors.push('Business name is required and must be less than 100 characters');
  }
  if (req.body.phone && !/^\+?[\d\s-]{8,20}$/.test(req.body.phone)) {
    errors.push('Invalid phone number format');
  }
  if (req.body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email)) {
    errors.push('Invalid email format');
  }
  if (req.body.street && req.body.street.length > 200) {
    errors.push('Street address must be less than 200 characters');
  }
  if (req.body.postcode && !/^\d{4,10}$/.test(req.body.postcode)) {
    errors.push('Invalid postcode format');
  }
  if (req.body.abn && !/^\d{11}$/.test(req.body.abn)) {
    errors.push('ABN must be exactly 11 digits');
  }
  if (req.body.acn && !/^\d{9}$/.test(req.body.acn)) {
    errors.push('ACN must be exactly 9 digits');
  }
  if (req.body.bsb && !/^\d{6}$/.test(req.body.bsb)) {
    errors.push('BSB must be exactly 6 digits');
  }
  if (req.body.accountNumber && !/^\d{6,10}$/.test(req.body.accountNumber)) {
    errors.push('Account number must be between 6 and 10 digits');
  }
  if (req.body.bankAccountName && req.body.bankAccountName.length > 100) {
    errors.push('Bank account name must be less than 100 characters');
  }
  if (req.body.documentNumbering) {
    try {
      const numbering = JSON.parse(req.body.documentNumbering);
      ['invoice', 'purchaseOrder', 'quote'].forEach(type => {
        if (numbering[type]) {
          if (typeof numbering[type].prefix !== 'string' || numbering[type].prefix.length > 10) {
            errors.push(`${type} prefix must be a string less than 10 characters`);
          }
          if (!Number.isInteger(numbering[type].nextNumber) || numbering[type].nextNumber < 1) {
            errors.push(`${type} number must be a positive integer`);
          }
        }
      });
    } catch (e) {
      errors.push('Invalid document numbering format');
    }
  }
  if (errors.length > 0) {
    warn('Business-Service', 'Validation failed', { errors: errors }, extractContextFromReq(req));
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
const storage = multer.memoryStorage(); // Use memory storage for multer
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit
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

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId?.toString();
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });
    const business = await Business.findOne({ workspaceId });
    if (!business) {
      warn('Business-Service', 'Business profile not found', {}, extractContextFromReq(req));
      return res.status(404).json({ message: 'Business profile not found' });
    }
    if (business.defaultLogo) {
      business.defaultLogo = await getS3FileUrl(business.defaultLogo, 3600, false);
    }
    if (business.squareLogo) {
      business.squareLogo = await getS3FileUrl(business.squareLogo, 3600, false);
    }
    if (business.wideLogo) {
      business.wideLogo = await getS3FileUrl(business.wideLogo, 3600, false);
    }

    info('Business-Service', 'Fetching Business profile data successfully', { businessName: business.name }, extractContextFromReq(req));
    res.json(business);
  } catch (err) {
    error('Business-Service', 'Server error', { message: err.message }, extractContextFromReq(req));
    res.status(500).json({ message: 'Server error' });
  }
});

// Get logo URL for QR code generation
router.get('/logo', authenticateToken, async (req, res) => {
  try {
    const { workspaceId, logoKey } = req.query;
    
    if (!workspaceId || !logoKey) {
      return res.status(400).json({ message: 'workspaceId and logoKey are required' });
    }

    const business = await Business.findOne({ workspaceId: workspaceId.toString() });
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    const logoPath = business[logoKey];
    if (!logoPath) {
      return res.status(404).json({ message: 'Logo not found' });
    }

    const logoUrl = await getS3FileUrl(logoPath, 3600, false);
    if (!logoUrl) {
      return res.status(404).json({ message: 'Logo file not found' });
    }

    info('Business-Service', 'Logo URL retrieved successfully', { 
      workspaceId, 
      logoKey, 
      logoPath 
    }, extractContextFromReq(req));

    res.json({ logoUrl });

  } catch (err) {
    error('Business-Service', 'Error retrieving logo URL', { 
      error: err.message,
      workspaceId: req.query.workspaceId,
      logoKey: req.query.logoKey
    }, extractContextFromReq(req));
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/profile', authenticateToken, multiupload, validateBusinessProfile, async (req, res) => {
  try {
    const workspaceId = req.body.workspaceId?.toString();
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });
    const { name, phone, email, abn, acn, state, suburb, country, postcode, street, bankAccountName, bankName, bsb, accountNumber, paymentReference, accountsReceivableTerms, accountsPayableTerms } = req.body;
    const { defaultLogoRemoved, squareLogoRemoved, wideLogoRemoved } = req.body;

    let documentNumbering = {};
    if (req.body.documentNumbering) {
      documentNumbering = JSON.parse(req.body.documentNumbering);
    }

    let business = await Business.findOne({ workspaceId });

    const updateData = {
      name,
      address: {
        street,
        country,
        suburb,
        state,
        postcode
      },
      phone,
      email,
      abn,
      acn,
      workspaceId,
      bankDetails: {
        accountName: bankAccountName,
        bankName,
        bsb,
        accountNumber,
        paymentReference,
        accountsReceivableTerms,
        accountsPayableTerms
      },
      documentNumbering
    };

    // Handle file uploads to S3
    if (req.files['defaultLogo']) {
      if (business?.defaultLogo) {
        await deleteFileFromS3(business.defaultLogo, false);
      }
      const defaultLogoPath = `logos/${workspaceId}/default-logo${path.extname(req.files['defaultLogo'][0].originalname)}`;
      await uploadFileToS3(req.files['defaultLogo'][0].buffer, defaultLogoPath, false);
      updateData.defaultLogo = defaultLogoPath;
    }

    if (req.files['squareLogo']) {
      if (business?.squareLogo) {
        await deleteFileFromS3(business.squareLogo, false);
      }
      const squareLogoPath = `logos/${workspaceId}/square-logo${path.extname(req.files['squareLogo'][0].originalname)}`;
      await uploadFileToS3(req.files['squareLogo'][0].buffer, squareLogoPath, false);
      setLogo(req.session.Authorization, workspaceId, req.files['squareLogo'][0], "form", req);
      updateData.squareLogo = squareLogoPath;
    }

    if (req.files['wideLogo']) {
      if (business?.wideLogo) {
        await deleteFileFromS3(business.wideLogo, false);
      }
      const wideLogoPath = `logos/${workspaceId}/wide-logo${path.extname(req.files['wideLogo'][0].originalname)}`;
      await uploadFileToS3(req.files['wideLogo'][0].buffer, wideLogoPath, false);
      setLogo(req.session.Authorization, workspaceId, req.files['wideLogo'][0], "document", req);
      updateData.wideLogo = wideLogoPath;
    }

    if (defaultLogoRemoved) {
      if (business?.defaultLogo) {
        await deleteFileFromS3(business.defaultLogo, false);
      }
      updateData.defaultLogo = null;
    }
    if (squareLogoRemoved) {
      if (business?.squareLogo) {
        await deleteFileFromS3(business.squareLogo, false);
      }
      updateData.squareLogo = null;
    }
    if (wideLogoRemoved) {
      if (business?.wideLogo) {
        await deleteFileFromS3(business.wideLogo, false);
      }
      updateData.wideLogo = null;
    }

    if (business) {
      business = await Business.findByIdAndUpdate(
        business._id,
        updateData,
        { new: true }
      );
      info('Business-Service', 'Business profile updated', { businessName: business.name }, extractContextFromReq(req));
      AuditTrail.insertOne({ workspaceId, action: 'Updated Business profile', detail: `Changed Business profile from "${JSON.stringify(business)}" to "${JSON.stringify(updateData)}"`, userEmail: req.user.email, userIp: req.ip?.split(':').pop() });
    } else {
      business = new Business(updateData);
      await business.save();
      info('Business-Service', 'New Business profile created', { businessName: business.name }, extractContextFromReq(req));
      AuditTrail.insertOne({ workspaceId, action: 'Created new Business profile', detail: `Resourse ID: ${business._id}`, userEmail: req.user.email, userIp: req.ip?.split(':').pop() });
    }

    res.status(200).json(business);
  } catch (err) {
    error('Business-Service', 'Server error', { message: err.message }, extractContextFromReq(req));
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/qr-logo', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    
    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
    }

    const business = await Business.findOne({ workspaceId: workspaceId.toString() });

    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    const logoPath = business.squareLogo || business.defaultLogo;
    if (!logoPath) {
      return res.status(404).json({ message: 'Logo not found' });
    }

    // Get the logo file from S3
    const logoBuffer = await getS3File(logoPath);
    if (!logoBuffer) {
      return res.status(404).json({ message: 'Logo file not found' });
    }

    info('Business-Service', 'Logo retrieved successfully', { 
      workspaceId, 
      logoPath 
    }, extractContextFromReq(req));

    // Set appropriate headers for image response
    const fileExtension = logoPath.split('.').pop().toLowerCase();
    const contentType = getContentType(fileExtension);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(logoBuffer);

  } catch (err) {
    error('Business-Service', 'Error retrieving logo', { 
      error: err.message,
      workspaceId: req.query.workspaceId
    }, extractContextFromReq(req));
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/xero/connect', authenticateToken, async (req, res) => {
  try {
    const workspaceId = req.body.workspaceId?.toString();
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

    info('Business-Service', 'Xero integration connected', { businessId: business._id }, extractContextFromReq(req));
    res.json({ success: true });
  } catch (err) {
    error('Business-Service', 'Server error during Xero connection', { message: err.message }, extractContextFromReq(req));
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/xero/disconnect', authenticateToken, async (req, res) => {
  try {
    const workspaceId = req.body.workspaceId?.toString();
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    const business = await Business.findOne({ workspaceId });
    if (!business) {
      warn('Business-Service', 'Business not found', { workspaceId }, extractContextFromReq(req));
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
    info('Business-Service', 'Xero integration disconnected', { businessId: business._id }, extractContextFromReq(req));
    res.json({ success: true });
  } catch (err) {
    error('Business-Service', 'Server error during Xero disconnection', { message: err.message }, extractContextFromReq(req));
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/xero/update-organization', authenticateToken, async (req, res) => {
  try {
    const workspaceId = req.body.workspaceId?.toString();
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    const business = await Business.findOne({ workspaceId });
    if (!business) {
      warn('Business-Service', 'Business not found', { workspaceId }, extractContextFromReq(req));
      return res.status(404).json({ message: 'Business not found' });
    }

    if (!business.xeroIntegrated) {
      warn('Business-Service', 'Xero integration not found', { workspaceId }, extractContextFromReq(req));
      return res.status(400).json({ message: 'Xero integration not found' });
    }

    const updatedOrganization = await updateOrganizationInfo(workspaceId);

    if (updatedOrganization) {
      business.xeroOrganization = updatedOrganization;
      await business.save();
      info('Business-Service', 'Xero organization info updated', { businessId: business._id }, extractContextFromReq(req));
      AuditTrail.insertOne({ workspaceId, action: 'Updated Xero organization info', detail: `Updated Xero organization info to "${JSON.stringify(updatedOrganization)}"`, userEmail: req.user.email, userIp: req.ip?.split(':').pop() });
      res.json({ success: true, organization: updatedOrganization });
    } else {
      error('Business-Service', 'Failed to update Xero organization info', { workspaceId }, extractContextFromReq(req));
      res.status(500).json({ message: 'Failed to update Xero organization info' });
    }
  } catch (err) {
    error('Business-Service', 'Server error during Xero organization update', { message: err.message }, extractContextFromReq(req));
    res.status(500).json({ message: 'Server error' });
  }
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      warn('Business-Service', 'File upload failed', { message: 'File size too large. Maximum size is 10MB' }, extractContextFromReq(req));
      return res.status(400).json({ status: 'error', message: 'File size too large. Maximum size is 10MB' });
    }
  }
  error('Business-Service', 'File upload failed', { message: err.message || 'An unknown error occurred' }, extractContextFromReq(req));
  res.status(500).json({ status: 'error', message: err.message || 'An unknown error occurred' });
});

export default router;