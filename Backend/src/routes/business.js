import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import Business from '../models/Business.js';
import { info, error, warn } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import AuditTrail from '../models/AuditTrail.js';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}.${file.originalname.split('.').pop()}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit
});
const multiupload = upload.fields([
  { name: 'defaultLogo', maxCount: 1 },
  { name: 'squareLogo', maxCount: 1 },
  { name: 'wideLogo', maxCount: 1 },
]);

// Serve static files from the uploads directory
router.use('/uploads', express.static(path.join(__dirname, '../../uploads')));

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
      },
      ...(req.files['defaultLogo'] && { defaultLogo: `/uploads/${req.files['defaultLogo'][0].filename}` }),
      ...(req.files['squareLogo'] && { squareLogo: `/uploads/${req.files['squareLogo'][0].filename}` }),
      ...(req.files['wideLogo'] && { wideLogo: `/uploads/${req.files['wideLogo'][0].filename}` })
    };

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