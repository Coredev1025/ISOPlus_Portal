import express from 'express';

import { validateApiKey } from '../middleware/auth.js';
import { error as logError } from '../utils/logger.js';
import { runTick } from '../services/scheduler/tick.js';

const router = express.Router();

/**
 * Driven by an EventBridge rule in AWS and by `npm run tick` locally. Thin by
 * design: everything it does is in services/scheduler/tick.js.
 */
router.post('/tick', validateApiKey, async (req, res) => {
  try {
    const summary = await runTick({ now: new Date() });
    res.json(summary);
  } catch (err) {
    logError(
      'Scheduler',
      'Tick failed',
      { message: err.message, stack: err.stack },
      req ?? null,
    );
    res.status(500).json({ error: 'Scheduler tick failed' });
  }
});

export default router;
