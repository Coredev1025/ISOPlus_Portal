import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Workspace from '../models/Workspace.js';
import AuditTrail from '../models/AuditTrail.js';
import { info, error } from '../utils/logger.js';
import { getWorkspace, getBoard } from '../services/isoplusServices.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  const response = await getWorkspace(req.headers['authorization']);

  if (response.status === 200) {
    res.status(200).json({ workspace: response.workspace });
  } else {
    res.status(500).json({ message: response.message });
  }
});

router.get('/boards', authenticateToken, async (req, res) => {
  const response = await getBoard(req.headers['authorization'], req.query.workspaceId);
  if (response.status === 200) {
    res.status(200).json({ board: response.board });
  } else {
    res.status(500).json({ message: response.message });
  }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, businessId } = req.body;
    const workspace = new Workspace({
      name,
      businessId,
      userId: req.user.userId
    });
    await workspace.save();
    info('Workspace-Service', 'New Workspace created', { workspaceId: workspace._id }, req);
    AuditTrail.insertOne({ workspaceId: workspace._id, action: 'Created new Workspace', detail: `New Workspace created: ${workspace._id}`, userEmail: req.user.email, userIp: req.ip?.split(':').pop() });
    res.status(201).json(workspace);
  } catch (err) {
    error('Workspace-Service', 'Server error', { message: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;