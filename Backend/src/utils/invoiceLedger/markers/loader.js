import { chunk } from 'lodash-es';

import InvoiceNumber from '../../../models/InvoiceNumber.js';
import Item from '../../../models/Item.js';
import { mongoEq } from '../../securityHelpers.js';

/** Reads what the marker backfill needs for one workspace: its log rows, and the state of the items they name. Read only. */

const CHUNK = 500;

export async function loadMarkerInputs(workspaceId) {
  const workspace = mongoEq(String(workspaceId));
  const logDocs = await InvoiceNumber.find({ workspaceId: workspace }).lean();
  const itemIds = [...new Set(logDocs.map((row) => row.itemId))];
  const items = [];
  for (const ids of chunk(itemIds, CHUNK)) {
    items.push(...await Item.find({ workspaceId: workspace, itemId: { $in: ids.map((id) => mongoEq(id)) } })
      .select({ itemId: 1, invoicedBy: 1 }).lean());
  }
  return {
    items: items.map((item) => ({ itemId: item.itemId, invoicedBy: item.invoicedBy })),
    logRows: logDocs.map((row) => ({
      itemId: row.itemId,
      invoiceNumber: row.invoiceNumber,
      type: row.type,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      idDate: row._id?.getTimestamp?.(),
    })),
  };
}

/** Every workspace that has a log row. */
export const workspacesWithLog = () => InvoiceNumber.distinct('workspaceId');
