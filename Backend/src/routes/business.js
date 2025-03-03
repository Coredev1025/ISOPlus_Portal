import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import Business from '../models/Business.js';
import { info, error, warn } from '../utils/logger.js';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const business = await Business.findOne({ userId: req.user.userId });
    if (!business) {
      warn('Business-Service', 'Business profile not found', { }, req);
      return res.status(404).json({ message: 'Business profile not found' });
    }
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
      const { name, address, phone, email } = req.body;
      let business = await Business.findOne({ userId: req.user.userId });

      const updateData = {
        name,
        address,
        phone,
        email,
        ...(req.file && { logo: req.file.path })
      };

      if (business) {
        business = await Business.findByIdAndUpdate(
          business._id,
          updateData,
          { new: true }
        );
        info('Business-Service', 'Business profile updated', { businessId: business._id }, req);
      } else {
        business = new Business({
          userId: req.user.userId,
          ...updateData
        });
        await business.save();
        info('Business-Service', 'New business profile created', { businessId: business._id }, req);
      }

      res.json(business);
    } catch (err) {
      error('Business-Service', 'Server error', { message: err.message }, req);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

export default router;