import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Workspace from '../models/Workspace.js';
import AuditTrail from '../models/AuditTrail.js';
import { info, error } from '../utils/logger.js';
import { getWorkspace, getBoard } from '../services/isoplus.js';
import DynamicLinkingService from '../services/dynamicLinking.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  const response = await getWorkspace(req.session.Authorization, req.user.email);

  if (response.status === 200 && Array.isArray(response.workspace)) {
    const sortedWorkspace = [...response.workspace].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    res.status(200).json({ workspace: sortedWorkspace });
  } else {
    res.status(500).json({ message: response.message || 'Failed to fetch workspaces' });
  }
});

router.get('/boards', authenticateToken, async (req, res) => {
  const response = await getBoard(req.session.Authorization, req.query.workspaceId);

  if (response.status === 200 && Array.isArray(response.board)) {
    const sortedBoard = [...response.board].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    res.status(200).json({ board: sortedBoard });
  } else {
    res.status(500).json({ message: response.message || 'Failed to fetch boards' });
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
    const workspaceId = workspace._id?.toString();
    AuditTrail.insertOne({ workspaceId, action: 'Created new Workspace', detail: `New Workspace created: ${workspaceId}`, userEmail: req.user.email, userIp: req.ip?.split(':').pop() });
    res.status(201).json(workspace);
  } catch (err) {
    error('Workspace-Service', 'Server error', { message: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

// Dynamic Linking routes
router.post('/:workspaceId/check-links', authenticateToken, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const host = 'https://app.isoplus.online';
    
    // Check if user has permission (owner or support_admin)
    if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
      return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
    }

    const dynamicLinkingService = new DynamicLinkingService(req.session.Authorization, host);
    console.log("Checking links");
    const results = await dynamicLinkingService.main(workspaceId, false);

    info('Workspace-Service', 'Links checked', { workspaceId, results }, req);
    res.status(200).json(results);
  } catch (err) {
    error('Workspace-Service', 'Failed to check links', { workspaceId: req.params.workspaceId, error: err.message }, req);
    res.status(500).json({ message: 'Failed to check links', error: err.message });
  }
});

router.post('/:workspaceId/create-links', authenticateToken, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const host = 'https://app.isoplus.online';
    
    // Check if user has permission (owner or support_admin)
    if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
      return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
    }

    const dynamicLinkingService = new DynamicLinkingService(req.session.Authorization, host);
    console.log("Creating links");
    const results = await dynamicLinkingService.main(workspaceId, true);

    info('Workspace-Service', 'Links created', { workspaceId, results }, req);
    res.status(200).json(results);
  } catch (err) {
    error('Workspace-Service', 'Failed to create links', { workspaceId: req.params.workspaceId, error: err.message }, req);
    res.status(500).json({ message: 'Failed to create links', error: err.message });
  }
});

export default router;