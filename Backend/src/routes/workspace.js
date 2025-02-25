import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Workspace from '../models/Workspace.js';
import axios from 'axios';

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
                console.error('Error fetching workspaces: ', err);
                res.status(500).json({ message: 'Error fetching workspaces' });
              });
            }

            get_workspace();
          }
        }
        res.json({ workspace });
      })
      .catch((err) => {
        console.error('Error fetching workspaces: ', err);
      });
  } catch (error) {
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
        res.json({ workspace });
      })
      .catch((err) => {
        console.error('Error fetching workspaces: ', err);
      });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/boards', authenticateToken, async (req, res) => {
  const url = `https://app.isoplus.online/api/v2/workspaces/${req.query.workspaceID}/boards`;

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
                console.error('Error fetching boards: ', err);
                res.status(500).json({ message: 'Error fetching boards' });
              });
          }

          get_board();
        }
      }
      res.json({ board });
    })
    .catch(err => {
      console.error('Error fetching boards: ', err);
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
    res.status(201).json(workspace);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;