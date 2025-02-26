import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Board from '../models/Board.js';
import mongoose from 'mongoose';

const router = express.Router();

router.post('/', authenticateToken, async (req, res) => {
    try {
        const existingBoard = await Board.findOne({ boardID: req.body.id });
        if (existingBoard) {
            await Board.updateOne({ boardID: req.body.boardID }, { $addToSet: { userId: new mongoose.Types.ObjectId(req.body.userId) } });
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
            res.status(200).json({ board: newBoard });
        }
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

router.put('/', authenticateToken, async (req, res) => {
    try {
        const result = await Board.updateOne({ boardID: req.body.id }, { $set: { label: req.body.label } });
        if (result.nModified === 0) {
            res.status(404).json({ message: 'Board not found' });
        } else {
            const updatedBoard = await Board.findOne({ boardID: req.body.id });
            res.status(200).json({ board: updatedBoard });
        }
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;