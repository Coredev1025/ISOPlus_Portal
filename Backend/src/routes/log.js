import express from 'express';
import mongoose from 'mongoose';

const router = express.Router();

// Define your Log schema
const logSchema = new mongoose.Schema({
    message: String,
    level: String,
    timestamp: Date,
    metadata: Object,
});

// Create a model from the schema
const Log = mongoose.model('Log', logSchema);

// Route to get logs
router.get('/', async (req, res) => {
    try {
        const logs = await Log.find();
        res.json(logs);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

export default router;