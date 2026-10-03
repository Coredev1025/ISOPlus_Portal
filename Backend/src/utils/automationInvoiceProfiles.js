import Item from '../models/Item.js';
import { extractRefId } from './ndisServiceRecords.js';
import { mongoEq } from './securityHelpers.js';
import { groupItemIdsByParticipantProfile } from './automationInvoiceGrouping.js';
import { UNPROFILED_ITEM_LOG_LIMIT } from '../constants/automation.js';
import { warn } from './logger.js';

const PARTICIPANT_PROFILE_ATTR = 'Participant Profile';

/** itemId -> Participant Profile reference, for the items that carry one. */
async function loadProfileIds(workspaceId, boardId, itemIds) {
  if (itemIds.length === 0) return new Map();
  const stored = await Item.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    itemId: { $in: itemIds.map((id) => mongoEq(String(id))) },
  }).select('itemId data').lean();
  const profileIds = new Map();
  for (const item of stored) {
    const profileId = extractRefId(item?.data?.[PARTICIPANT_PROFILE_ATTR]);
    if (profileId) profileIds.set(String(item.itemId), profileId);
  }
  return profileIds;
}

/**
 * Rows with the Participant Profile of their item added as `profileId`. For
 * documents read back from the ledger, which do not carry it: a retry of the
 * same slot then groups a client's earlier and new documents into one email.
 * A row that already has a `profileId`, or whose item has no profile, is left
 * as it is. Does not mutate its input.
 */
export async function attachProfileIds(workspaceId, boardId, rows) {
  const profileIds = await loadProfileIds(
    workspaceId, boardId, rows.filter((row) => !row.profileId && row.itemId).map((row) => row.itemId),
  );
  return rows.map((row) => {
    const profileId = row.profileId ? null : profileIds.get(String(row.itemId));
    return profileId ? { ...row, profileId } : row;
  });
}

/**
 * The billable rows grouped by Participant Profile (KAN-293). Items with no
 * profile are left out of every group and counted in the log, so a board full
 * of unlinked rows is visible rather than silently skipped.
 */
export async function groupBillableRowsByProfile({
  workspaceId, boardId, periodKey, rows, idKey, participantKey = 'participant',
}) {
  const profileIds = await loadProfileIds(workspaceId, boardId, rows.map((row) => row[idKey]).filter(Boolean));
  const { groups, unprofiled } = groupItemIdsByParticipantProfile(rows, {
    idKey,
    participantKey,
    profileIdOf: (itemId) => profileIds.get(String(itemId)),
  });
  if (unprofiled.length > 0) {
    // A warn with the item ids, not an info count: these items are never claimed
    // and fall outside the next period's window, so nothing later picks them up
    // and an operator needs to be able to find them.
    warn('Automation', 'Billable items left out: no Participant Profile to bill them to', {
      workspaceId,
      boardId,
      periodKey,
      count: unprofiled.length,
      itemIds: unprofiled.slice(0, UNPROFILED_ITEM_LOG_LIMIT),
    });
  }
  return groups;
}

/**
 * Run `generate(group)` for every group, in order, and keep going when one
 * fails. Each group is its own invoice: a participant whose profile cannot be
 * resolved must not stop the participants listed after them being billed.
 *
 * The run still fails afterwards, naming every failed participant, so it is
 * visible and retried. The retry is safe: groups already billed are found by
 * their ledger rows and claims, and are not billed twice.
 */
export async function generateGroupsIsolated(groups, generate) {
  const failures = [];
  for (const group of groups) {
    try {
      await generate(group);
    } catch (err) {
      failures.push(`${group.participant}: ${err?.message || err}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `automation: ${failures.length} of ${groups.length} participant invoice(s) failed; `
      + `the rest were generated. ${failures.join(' | ')}`,
    );
  }
}
