import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Board from '../models/Board.js';
import mongoose from 'mongoose';
import { info, error, warn } from '../utils/logger.js';

const router = express.Router();

router.post('/', authenticateToken, async (req, res) => {
    try {
        const existingBoard = await Board.findOne({ boardID: req.body.id });
        if (existingBoard) {
            await Board.updateOne({ boardID: req.body.boardID }, { $addToSet: { userId: new mongoose.Types.ObjectId(req.body.userId) } });
            info('Board-Service', 'Existing board updated', { boardID: req.body.boardID, userId: req.body.userId });
            res.status(200).json({ board: existingBoard });
        } else {
            const newBoard = new Board({
                boardID: req.body.id || '',
                name: req.body.name || '',
                color: req.body.color || '',
                description: req.body.color || '',
                og_image: req.body.og_image || '',
                userId: req.body.userId ? [new mongoose.Types.ObjectId(req.body.userId)] : [],
            });
            await newBoard.save();
            info('Board-Service', 'New board created', { boardID: req.body.id, userId: req.body.userId });
            res.status(200).json({ board: newBoard });
        }
    } catch (err) {
        error('Board-Service', 'Server error', { message: err.message });
        res.status(500).json({ message: 'Server error' });
    }
});

router.put('/', authenticateToken, async (req, res) => {
    try {
        const result = await Board.updateOne({ boardID: req.body.id }, { $set: { label: req.body.label } });
        if (result.nModified === 0) {
            warn('Board-Service', 'Board not found', { boardID: req.body.id });
            res.status(404).json({ message: 'Board not found' });
        } else {
            const updatedBoard = await Board.findOne({ boardID: req.body.id });
            info('Board-Service', 'Board updated', { boardID: req.body.id, label: req.body.label });
            res.status(200).json({ board: updatedBoard });
        }
    } catch (err) {
        error('Board-Service', 'Server error', { message: err.message });
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;