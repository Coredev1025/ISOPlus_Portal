import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Workspace from '../models/Workspace.js';
import AuditTrail from '../models/AuditTrail.js';
import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import { info, error } from '../utils/logger.js';
import { getMyWorkspace, getBoard } from '../services/isoplus.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  const response = await getMyWorkspace(req.session.Authorization);

  if (response.status === 200) {
    const userRole = response.workspace[0]?.user_role || "user";
    if (userRole === "owner" && req.user.role !== "owner") {
      const user = await User.findByIdAndUpdate({ _id: req.user.userId }, { $set: { role: "owner" } });
      const token = jwt.sign(
        { userId: user._id, email: user.email, role: user.role, avatar: user.avatar, workspace: response.workspace },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      req.session.token = token;
      res.status(200).json({ workspace: response.workspace, user, token });
    } else {
      const token = jwt.sign(
        { userId: req.user.userId, email: req.user.email, role: req.user.role, avatar: req.user.avatar,  workspace: response.workspace },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      req.session.token = token;
      res.status(200).json({ workspace: response.workspace });
    }
  } else {
    res.status(500).json({ message: response.message });
  }
});

router.get('/boards', authenticateToken, async (req, res) => {
  const response = await getBoard(req.session.Authorization, req.query.workspaceId);
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