import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import Business from '../models/Business.js';
import { info, error, warn } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import AuditTrail from '../models/AuditTrail.js';
import { uploadFileToS3, getS3FileUrl, deleteFileFromS3 } from '../utils/uploadS3.js'; // Import S3 utility functions

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const storage = multer.memoryStorage(); // Use memory storage for multer
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit
});
const multiupload = upload.fields([
  { name: 'defaultLogo', maxCount: 1 },
  { name: 'squareLogo', maxCount: 1 },
  { name: 'wideLogo', maxCount: 1 },
]);

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const business = await Business.findOne({ workspaceId: req.query.workspaceId });
    if (!business) {
      warn('Business-Service', 'Business profile not found', {}, req);
      return res.status(404).json({ message: 'Business profile not found' });
    }
    info('Business-Service', 'Fetching Business profile data successfully', { businessName: business.name }, req);
    res.json(business);
  } catch (err) {
    error('Business-Service', 'Server error', { message: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/profile', authenticateToken, multiupload, async (req, res) => {
  try {
    const {
      name, phone, email, abn, acn, state, suburb, country,
      postcode, street, workspaceId, bankAccountName, bankName,
      bsb, accountNumber, paymentReference
    } = req.body;

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
        paymentReference
      },
      documentNumbering
    };

    // Handle file uploads to S3
    if (req.files['defaultLogo']) {
      if (business?.defaultLogo) {
        await deleteFileFromS3(business.defaultLogo);
      }
      await uploadFileToS3(
        req.files['defaultLogo'][0].buffer,
        `logos/${workspaceId}/default-logo${path.extname(req.files['defaultLogo'][0].originalname)}`
      );
      updateData.defaultLogo = await getS3FileUrl(`logos/${workspaceId}/default-logo${path.extname(req.files['defaultLogo'][0].originalname)}`);
    }

    if (req.files['squareLogo']) {
      if (business?.squareLogo) {
        await deleteFileFromS3(business.squareLogo);
      }
      await uploadFileToS3(
        req.files['squareLogo'][0].buffer,
        `logos/${workspaceId}/square-logo${path.extname(req.files['squareLogo'][0].originalname)}`
      );
      updateData.squareLogo = await getS3FileUrl(`logos/${workspaceId}/square-logo${path.extname(req.files['defaultLogo'][0].originalname)}`);
    }

    if (req.files['wideLogo']) {
      if (business?.wideLogo) {
        await deleteFileFromS3(business.wideLogo);
      }
      await uploadFileToS3(
        req.files['wideLogo'][0].buffer,
        `logos/${workspaceId}/wide-logo${path.extname(req.files['wideLogo'][0].originalname)}`
      );
      updateData.wideLogo = await getS3FileUrl(`logos/${workspaceId}/wide-logo${path.extname(req.files['defaultLogo'][0].originalname)}`);
    }

    if (business) {
      business = await Business.findByIdAndUpdate(
        business._id,
        updateData,
        { new: true }
      );
      info('Business-Service', 'Business profile updated', { businessName: business.name }, req);
      AuditTrail.insertOne({ workspaceId, action: 'Updated Business profile', detail: `Changed Business profile from "${JSON.stringify(business)}" to "${JSON.stringify(updateData)}"`, userEmail: req.user.email, userIp: req.ip?.split(':').pop() });
    } else {
      business = new Business(updateData);
      await business.save();
      info('Business-Service', 'New Business profile created', { businessName: business.name }, req);
      AuditTrail.insertOne({ workspaceId, action: 'Created new Business profile', detail: `Resourse ID: ${business._id}`, userEmail: req.user.email, userIp: req.ip?.split(':').pop() });
    }

    res.json(business);
  } catch (err) {
    error('Business-Service', 'Server error', { message: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/xero/connect', authenticateToken, async (req, res) => {
  try {
    const { workspaceId, clientId, clientSecret, tokens } = req.body;

    let business = await Business.findOne({ workspaceId });
    if (!business) {
      business = new Business({
        workspaceId,
        xeroIntegrated: true,
        xeroTokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_at
        }
      });
      await business.save();
    } else {
      business.xeroIntegrated = true;
      business.xeroTokens = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_at
      };

      await business.save();
    }

    info('Business-Service', 'Xero integration connected', { businessId: business._id }, req);
    res.json({ success: true });
  } catch (err) {
    error('Business-Service', 'Server error during Xero connection', { message: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/xero/disconnect', authenticateToken, async (req, res) => {
  try {
    const { workspaceId } = req.body;

    const business = await Business.findOne({ workspaceId });
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    business.xeroIntegrated = false;
    business.xeroTokens = {
      accessToken: null,
      refreshToken: null,
      expiresAt: null
    };

    await business.save();
    info('Business-Service', 'Xero integration disconnected', { businessId: business._id }, req);
    res.json({ success: true });
  } catch (err) {
    error('Business-Service', 'Server error during Xero disconnection', { message: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;