import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import Business from '../models/Business.js';
import { info, error, warn } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

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

router.put('/profile',
  authenticateToken,
  upload.single('logo'),
  async (req, res) => {
    try {
      const { name, phone, email, abn, acn, state, city, postcode, street1, street2, workspaceId } = req.body;
      let business = await Business.findOne({ workspaceId });

      const updateData = {
        name,
        address: {
          street1,
          street2,
          city,
          state,
          postcode
        },
        phone,
        email,
        abn,
        acn,
        workspaceId,
        ...(req.file && { logo: `/uploads/${req.file.filename}` })
      };

      if (business) {
        business = await Business.findByIdAndUpdate(
          business._id,
          updateData,
          { new: true }
        );
        info('Business-Service', 'Business profile updated', { businessName: business.name }, req);
      } else {
        business = new Business({
          ...updateData
        });
        await business.save();
        info('Business-Service', 'New business profile created', { businessName: business.name }, req);
      }

      res.json(business);
    } catch (err) {
      error('Business-Service', 'Server error', { message: err.message }, req);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

export default router;