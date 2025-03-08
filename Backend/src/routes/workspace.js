import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Workspace from '../models/Workspace.js';
import axios from 'axios';
import { info, error } from '../utils/logger.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const url = "https://app.isoplus.online/api/v2/workspaces";

    const params = {
      "limit": "100",
      "sort_by": "created_at",
      "sort_direction": "desc",
    };
    const headers = {
      Authorization: req.headers['authorization'],
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    let workspace = [];

    axios.get(url, { headers, params })
      .then(response => {
        if (response.status === 200) {
          workspace = workspace.concat(response.data.data);

          while (response.data.has_more) {
            const get_workspace = async () => {
              axios.get(url, { headers, params: { ...params, after: response.data.after } })
                .then(response => {
                  if (response.status === 200) {
                    workspace = workspace.concat(response.data.data);
                  }
                })
                .catch(err => {
                  error('Workspace-Service', 'Error fetching workspaces', { message: err.message }, req);
                  res.status(500).json({ message: 'Error fetching workspaces' });
                });
            }
            get_workspace();
          }
        }
        info('Workspace-Service', 'Successfully fetching workspace', { userId: req.user.userId }, req);
        res.json({ workspace });
      })
      .catch((err) => {
        error('Workspace-Service', 'Error fetching workspaces', { message: err.message }, req);
        res.status(500).json({ message: 'Error fetching workspaces' });
      });
  } catch (err) {
    error('Workspace-Service', 'Server error', { message: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const url = "https://app.isoplus.online/api/me/workspaces";

    const headers = {
      Authorization: req.headers['authorization'],
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    let workspace = [];

    axios.get(url, { headers })
      .then(response => {
        if (response.status === 200) {
          workspace = workspace.concat(response.data);
        }
        info('Workspace-Service', 'Successfully fetching workspace', { userId: req.user.userId }, req);
        res.json({ workspace });
      })
      .catch((err) => {
        error('Workspace-Service', 'Error fetching workspaces', { message: err.message }, req);
        res.status(500).json({ message: 'Error fetching workspaces' });
      });
  } catch (err) {
    error('Workspace-Service', 'Server error', { message: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/boards', authenticateToken, async (req, res) => {
  const url = `https://app.isoplus.online/api/v2/workspaces/${req.query.workspaceId}/boards`;

  const params = {
    "limit": "100",
    "sort_by": "created_at",
    "sort_direction": "desc",
  };

  const headers = {
    "Authorization": req.headers['authorization'],
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  let board = [];

  axios.get(url, { headers, params })
    .then(response => {
      if (response.status === 200) {
        board = board.concat(response.data.data);

        while (response.data.has_more) {
          const get_board = async () => {
            await axios.get(url, { headers, params: { ...params, after: response.data.after } })
              .then(response => {
                if (response.status === 200) {
                  board = board.concat(response.data.data);
                }
              })
              .catch(err => {
                error('Workspace-Service', 'Error fetching boards', { message: err.message }, req);
                res.status(500).json({ message: 'Error fetching boards' });
              });
          }
          get_board();
        }
      }
      info('Workspace-Service', 'Successfully fetching boards', { workspaceId: req.query.workspaceId }, req);
      res.json({ board });
    })
    .catch(err => {
      error('Workspace-Service', 'Error fetching boards', { message: err.message }, req);
      res.status(500).json({ message: 'Error fetching boards' });
    });
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
    info('Workspace-Service', 'New workspace created', { workspaceId: workspace._id }, req);
    res.status(201).json(workspace);
  } catch (err) {
    error('Workspace-Service', 'Server error', { message: err.message }, req);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
