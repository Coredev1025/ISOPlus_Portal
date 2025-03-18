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
    const { name, phone, email, abn, acn, state, suburb, country, postcode, street, workspaceId, bankAccountName, bankName, bsb, accountNumber, paymentReference } = req.body;
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
      }
    };

    // Upload files to S3 and update the URLs in updateData
    if (req.files['defaultLogo']) {
      if (business && business.defaultLogo) {
        await deleteFileFromS3(business.defaultLogo);
      }
      const defaultLogoUrl = await uploadFileToS3(req.files['defaultLogo'][0].buffer, 'logo', `${name}/default-logo${path.extname(req.files['defaultLogo'][0].originalname)}`);
      updateData.defaultLogo = defaultLogoUrl;
    }
    if (req.files['squareLogo']) {
      if (business && business.squareLogo) {
        await deleteFileFromS3(business.squareLogo);
      }
      const squareLogoUrl = await uploadFileToS3(req.files['squareLogo'][0].buffer, 'logo', `${name}/square-logo${path.extname(req.files['squareLogo'][0].originalname)}`);
      updateData.squareLogo = squareLogoUrl;
    }
    if (req.files['wideLogo']) {
      if (business && business.wideLogo) {
        await deleteFileFromS3(business.wideLogo);
      }
      const wideLogoUrl = await uploadFileToS3(req.files['wideLogo'][0].buffer, 'logo', `${name}/wide-logo${path.extname(req.files['wideLogo'][0].originalname)}`);
      updateData.wideLogo = wideLogoUrl;
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
      business = new Business({
        ...updateData
      });
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

export default router;