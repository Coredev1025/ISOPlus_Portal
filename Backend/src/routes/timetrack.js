import express from 'express';
import TimeTrack from '../models/TimeTrack.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
    try {
        const timetrack = TimeTrack.find({ 'boardId': req.query.boardId });
        res.json(timetrack);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

export default router;