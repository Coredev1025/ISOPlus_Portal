import { describe, it, expect, afterEach } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import { ensurePortalBoardSyncSchedule } from '../../../src/services/scheduler/portalSchedule.js';
import {
  BOARD_SYNC_CRON_DEFAULT,
  BOARD_SYNC_KIND,
  BOARD_SYNC_TARGET_ID,
} from '../../../src/constants/scheduler.js';

const NOW = new Date('2026-08-11T04:05:00Z');

describe('ensurePortalBoardSyncSchedule', () => {
  const original = process.env.BOARD_SYNC_CRON;
  afterEach(() => {
    if (original === undefined) delete process.env.BOARD_SYNC_CRON;
    else process.env.BOARD_SYNC_CRON = original;
  });

  it('upserts one enabled portal row with the default daily cron', async () => {
    delete process.env.BOARD_SYNC_CRON;
    const job = await ensurePortalBoardSyncSchedule({ now: NOW });

    expect(job.kind).toBe(BOARD_SYNC_KIND);
    expect(job.targetId).toBe(BOARD_SYNC_TARGET_ID);
    expect(job.cron).toBe(BOARD_SYNC_CRON_DEFAULT);
    expect(job.enabled).toBe(true);
    expect(await ScheduledJob.countDocuments({ kind: BOARD_SYNC_KIND })).toBe(1);
  });

  it('rewrites cron from BOARD_SYNC_CRON rather than inserting a second row', async () => {
    await ensurePortalBoardSyncSchedule({ now: NOW });
    process.env.BOARD_SYNC_CRON = '0 4 * * *';
    const updated = await ensurePortalBoardSyncSchedule({ now: NOW });

    expect(updated.cron).toBe('0 4 * * *');
    expect(await ScheduledJob.countDocuments({
      kind: BOARD_SYNC_KIND, targetId: BOARD_SYNC_TARGET_ID,
    })).toBe(1);
  });
});
