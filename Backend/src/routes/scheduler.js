import express from 'express';

import { validateSchedulerApiKey } from '../middleware/auth.js';
import { error as logError } from '../utils/logger.js';
import { runTick } from '../services/scheduler/tick.js';
import { LOG_SCOPE } from '../constants/scheduler.js';

const router = express.Router();

/**
 * Driven by an EventBridge rule in AWS and by `npm run tick` locally. Thin by
 * design: everything it does is in services/scheduler/tick.js.
 */
router.post('/tick', validateSchedulerApiKey, async (req, res) => {
  try {
    // schedulerKinds carries the presented credential's scope: null for the
    // master key, one kind for a per-kind EventBridge rule's key.
    const summary = await runTick({ now: new Date(), kinds: req.schedulerKinds ?? null });
    res.json(summary);
  } catch (err) {
    logError(
      LOG_SCOPE,
      'Tick failed',
      { message: err.message, stack: err.stack },
      req ?? null,
    );
    res.status(500).json({ error: 'Scheduler tick failed' });
  }
});

export default router;
