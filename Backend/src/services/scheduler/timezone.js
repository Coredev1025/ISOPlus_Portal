import Business from '../../models/Business.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { warn } from '../../utils/logger.js';
import { isValidSchedule } from './nextRun.js';
import { DEFAULT_TIMEZONE, PROBE_CRON, LOG_SCOPE } from '../../constants/scheduler.js';

/**
 * Business.headOfficeTimezone for a workspace, or null if there is no
 * workspaceId, no matching Business, or no value stored on it. Never throws:
 * a malformed workspaceId or a database hiccup here must not block schedule
 * creation, so both collapse to "no inherited value".
 */
async function lookupBusinessTimezone(workspaceId) {
  if (!workspaceId) return null;

  try {
    const business = await Business.findOne({ workspaceId: mongoEq(workspaceId) })
      .select('headOfficeTimezone')
      .lean();
    return business?.headOfficeTimezone || null;
  } catch {
    return null;
  }
}

/**
 * Resolution order: an explicit `timezone` argument always wins. Otherwise,
 * inherit `Business.headOfficeTimezone` for `workspaceId`. Otherwise fall
 * back to DEFAULT_TIMEZONE.
 *
 * An inherited value that is not a valid IANA zone is never returned or
 * stored — it is logged at warn (naming the workspace and the bad value) and
 * treated the same as no inherited value. A bad setting on one business must
 * not make schedules uncreatable.
 */
export async function resolveTimezone({ workspaceId, timezone }) {
  if (timezone !== undefined) return timezone;

  const inherited = await lookupBusinessTimezone(workspaceId);
  if (!inherited) return DEFAULT_TIMEZONE;
  if (isValidSchedule(PROBE_CRON, inherited)) return inherited;

  warn(LOG_SCOPE, 'Business headOfficeTimezone is not a valid IANA timezone; falling back', {
    workspaceId,
    timezone: inherited,
  });
  return DEFAULT_TIMEZONE;
}
