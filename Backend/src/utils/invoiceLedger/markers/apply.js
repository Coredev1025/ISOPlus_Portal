import Item from '../../../models/Item.js';
import { MARKER_BACKFILL_SENTINEL } from '../../../constants/invoiceLedger.js';
import { mongoEq } from '../../securityHelpers.js';

/**
 * Writes the markers, and undoes them (KAN-312). The write is conditional on the item still
 * having no marker, so it can never overwrite one a live claim set since the plan was read, and
 * it touches only `invoicedBy`, `invoicedAt` and `invoicedPeriodKey` (the sentinel). Idempotent.
 */

const unmarked = [{ invoicedBy: null }, { invoicedBy: '' }];

export async function applyMarkers(markers, workspaceId) {
  if (markers.length === 0) return { marked: 0 };
  const result = await Item.bulkWrite(markers.map((m) => ({
    updateOne: {
      filter: { workspaceId: mongoEq(String(workspaceId)), itemId: mongoEq(m.itemId), $or: unmarked },
      update: { $set: { invoicedBy: m.invoicedBy, invoicedAt: m.invoicedAt, invoicedPeriodKey: MARKER_BACKFILL_SENTINEL } },
    },
  })));
  return { marked: result.modifiedCount };
}

/**
 * Clear the markers this script set: the items still carrying the sentinel. A marker a live
 * claim has taken over (it overwrites the period key) is left alone. Without `apply` it counts.
 */
export async function undoMarkers(workspaceId, { apply = false } = {}) {
  const filter = { workspaceId: mongoEq(String(workspaceId)), invoicedPeriodKey: MARKER_BACKFILL_SENTINEL };
  if (!apply) return { items: await Item.countDocuments(filter), preview: true };
  const result = await Item.updateMany(filter, { $unset: { invoicedBy: '', invoicedAt: '', invoicedPeriodKey: '' } });
  return { items: result.modifiedCount, preview: false };
}
