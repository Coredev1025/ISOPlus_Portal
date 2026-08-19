import { upsertSchedule } from './schedules.js';
import { resolveBoardSyncCron } from '../../utils/boardSyncSweepHelpers.js';
import { BOARD_SYNC_KIND, BOARD_SYNC_TARGET_ID } from '../../constants/scheduler.js';

export async function ensurePortalBoardSyncSchedule({ now = new Date() } = {}) {
  return upsertSchedule({
    kind: BOARD_SYNC_KIND,
    targetId: BOARD_SYNC_TARGET_ID,
    workspaceId: null,
    cron: resolveBoardSyncCron(),
    now,
  });
}
