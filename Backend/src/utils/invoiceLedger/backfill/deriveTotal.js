import Item from '../../../models/Item.js';
import { INVOICE_KIND } from '../../../constants/invoiceLedger.js';
import { ATTRIBUTE_NAMES } from '../../../constants/monthlyStatementAttributes.js';
import { NDIS_MASTERPLAN_ATTR, extractRefId } from '../../ndisServiceRecords.js';
import { getNdisInvoiceGeneratorContextFromMasterItems } from '../../ndisInvoiceGeneratorInvoicing.js';
import { collectNdisInvoiceRows } from '../../ndisInvoiceGeneratorPdfHelpers.js';
import { mongoEq } from '../../securityHelpers.js';
import { lineAmountsFrom } from '../lineAmounts.js';

/**
 * The total an invoice billed, and what each item contributed, worked out from its items
 * when no document total exists (KAN-311, design 6.2 rule 3). It uses the generators' own
 * functions so the figure is what the generator would have printed, not a plain sum:
 * NDIS rows come from the NDIS row builders, Age Care bills the participant contribution
 * and Low Cat bills the full service amount. A known (printed) total is kept as the total;
 * the amounts are still returned. When the items cannot be priced it returns `{ error }` with
 * the reason, so the report can say why.
 */

const cents = (n) => Math.round(n * 100) / 100;
const total = (perItem) => cents(Object.values(perItem).reduce((sum, amount) => sum + amount, 0));

/** The amount one Age Care item billed: the full amount on Low Cat, else the participant contribution. */
const ageCareAmount = (item, lowCat) => {
  const key = lowCat ? ATTRIBUTE_NAMES.TOTAL_AMOUNT : ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION;
  return Number(item?.data?.[key]) || 0;
};

async function ageCare({ workspaceId, boardId, lowCat, itemIds }) {
  const items = await Item.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    itemId: { $in: itemIds.map((id) => mongoEq(String(id))) },
  }).select('itemId data').lean();
  const wanted = new Set(itemIds).size;
  if (items.length !== wanted) return { error: `items not found: ${wanted - items.length} of ${wanted}` };
  return lineAmountsFrom(items.map((item) => ({ id: item.itemId, amount: ageCareAmount(item, lowCat) })), 'id', (row) => row.amount);
}

/** The master items split by the participant profile they reference: the context builder prices one participant at a time. */
async function byParticipantProfile({ workspaceId, boardId, itemIds }) {
  const masters = await Item.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    itemId: { $in: itemIds.map((id) => mongoEq(String(id))) },
  }).select({ itemId: 1, [`data.${NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE}`]: 1 }).lean();
  const groups = new Map();
  for (const master of masters) {
    const profile = extractRefId(master.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]) ?? '';
    groups.set(profile, [...(groups.get(profile) || []), master.itemId]);
  }
  return { groups, found: masters.length };
}

async function ndisOneParticipant({ workspaceId, boardId, itemIds, timezone }) {
  const context = await getNdisInvoiceGeneratorContextFromMasterItems({
    workspaceId, boardId, masterItemIds: itemIds, skipApprovalCheck: true,
  });
  const rows = await collectNdisInvoiceRows({
    masterItems: context.masterItems,
    refItemsMap: context.refItemsMap,
    participantName: '',
    profileItem: context.participantProfileItem,
    invoiceNumber: '',
    timezone,
    workspaceId,
    boardId,
  });
  return lineAmountsFrom(rows, 'sourceItemId', (row) => row.totalAmount);
}

/**
 * NDIS items are priced per participant profile and the amounts joined: an item's amount does
 * not depend on the others, and one logged number can cover several participants.
 */
async function ndis({ workspaceId, boardId, itemIds, timezone }) {
  const { groups, found } = await byParticipantProfile({ workspaceId, boardId, itemIds });
  const wanted = new Set(itemIds).size;
  if (found !== wanted) return { error: `items not found: ${wanted - found} of ${wanted}` };
  // The generators refuse an item with no participant profile, and the amount is not guessed.
  const unreferenced = groups.get('');
  if (unreferenced) return { error: `${unreferenced.length} item(s) have no participant profile reference, which the NDIS generator needs` };
  const perItem = {};
  for (const group of groups.values()) {
    Object.assign(perItem, await ndisOneParticipant({
      workspaceId, boardId, itemIds: group, timezone,
    }));
  }
  return Object.keys(perItem).length === 0 ? { error: 'the NDIS row builders returned no rows' } : perItem;
}

/** `deriveTotal({ boardId, kind, lowCat, itemIds, knownTotal })` for the planner. Never throws. */
export function makeDeriveTotal({ workspaceId, timezone }) {
  return async function deriveTotal({
    boardId, kind, lowCat, itemIds, knownTotal,
  }) {
    try {
      const perItem = kind === INVOICE_KIND.NDIS
        ? await ndis({ workspaceId, boardId, itemIds, timezone })
        : await ageCare({ workspaceId, boardId, lowCat, itemIds });
      if (perItem.error) return perItem;
      return { total: knownTotal ?? total(perItem), perItem };
    } catch (err) {
      return { error: err.message };
    }
  };
}
