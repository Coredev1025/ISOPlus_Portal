/**
 * Finding the claims that no run is still behind.
 *
 * `generateUnderClaim` (utils/automationInvoiceClaim.js) marks items with a
 * `pending:` token, generates, then either rewrites the token to the real
 * invoice number or releases it. A process that dies between the claim and the
 * release leaves the token in place, and nothing in the protocol clears it.
 *
 * The consequence is not a lost run — it is silent, permanent under-billing.
 * Selection skips any item carrying an `invoicedBy`, so those items drop out of
 * *every* future invoice. The participant is billed less than they were owed
 * and the only trace is a marker on a document nobody opens.
 *
 * Section 3.4 chose that failure direction on purpose, and it is the right one:
 * a double-billed participant is not recoverable, an unbilled item is. But
 * "recoverable" assumes someone finds out, and finding out was the missing
 * half. This is that half.
 *
 * ## Detection only, deliberately
 *
 * Nothing here clears a token. A claim that looks stale by the clock may belong
 * to a run that is merely slow, and releasing it would hand those items to the
 * next run while the first one is still going — the double bill the entire
 * claim protocol exists to prevent. Trading a recoverable failure for an
 * unrecoverable one to save an operator a command is a bad trade. The alarm
 * carries the item ids; clearing them stays a deliberate act.
 */

import Item from '../models/Item.js';
import {
  PROVISIONAL_CLAIM_PREFIX,
  STALE_CLAIM_ID_LOG_LIMIT,
  STALE_CLAIM_MAX_AGE_MS,
} from '../constants/invoiceSelection.js';
import { mongoEq } from './securityHelpers.js';
import { error } from './logger.js';

// Anchored at the start, so it matches the token prefix and not an invoice
// number that happens to contain the word. The prefix is a literal with no
// regex metacharacters, which is what makes building the pattern from it safe.
const PROVISIONAL_PATTERN = new RegExp(`^${PROVISIONAL_CLAIM_PREFIX}`);

/**
 * The Mongo filter for a provisional claim old enough that no run should still
 * be holding it. Pure, so the cutoff arithmetic can be read and tested without
 * a database.
 *
 * `invoicedAt: null` is included and matches an absent field as well as an
 * explicit null. A token with no timestamp cannot be vouched for by the clock,
 * and treating it as young would hide it forever — the one outcome this exists
 * to prevent.
 */
export function staleClaimQuery({
  workspaceId, boardId, now = new Date(), maxAgeMs = STALE_CLAIM_MAX_AGE_MS,
}) {
  const cutoff = new Date(now.getTime() - maxAgeMs);
  return {
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    invoicedBy: PROVISIONAL_PATTERN,
    $or: [{ invoicedAt: { $lt: cutoff } }, { invoicedAt: null }],
  };
}

/**
 * The items on one board held by a provisional claim past the cutoff.
 *
 * Board-scoped rather than global because the caller is a board's own run, and
 * because an unbounded scan of `items` is not something to put on a scheduled
 * path.
 */
export async function findStaleClaims({
  workspaceId, boardId, now = new Date(), maxAgeMs = STALE_CLAIM_MAX_AGE_MS,
}) {
  return Item.find(staleClaimQuery({ workspaceId, boardId, now, maxAgeMs }))
    .select('itemId invoicedBy invoicedAt invoicedPeriodKey')
    .lean();
}

/**
 * Raise the alarm, and return what it found so a caller can act on it.
 *
 * `error` rather than `warn`: this is money not being billed, and it stays
 * true until someone intervenes. It needs to reach whatever is watching the
 * error level, not sit in a stream that is only read after a complaint.
 *
 * The ids are capped. One crashed run can hold thousands of items, and the
 * logger's storage sanitizer drops metadata past a size limit — an alarm that
 * loses its own payload to truncation tells you less than one that says how
 * many it left out.
 */
export async function reportStaleClaims({
  workspaceId, boardId, now = new Date(), maxAgeMs = STALE_CLAIM_MAX_AGE_MS,
}) {
  const stale = await findStaleClaims({ workspaceId, boardId, now, maxAgeMs });
  if (stale.length === 0) return stale;

  const itemIds = stale.slice(0, STALE_CLAIM_ID_LOG_LIMIT).map((row) => row.itemId);
  error('Automation', 'Items are held by an invoice run that never completed; they will not be billed until the marker is cleared', {
    workspaceId,
    boardId,
    count: stale.length,
    itemIds,
    truncated: stale.length - itemIds.length,
    maxAgeMs,
  });
  return stale;
}
