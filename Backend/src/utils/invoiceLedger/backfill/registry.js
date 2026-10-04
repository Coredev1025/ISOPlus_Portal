import {
  cleanName, earliest, numberKey, participantKey,
} from './context.js';

/**
 * The registry of drafts (KAN-310). Every source (ledger rows, markers, the log, Xero rows)
 * adds its items here, and an item joins the draft with the same board, source, number and
 * participant instead of starting a second one. That is what stops one invoice being split
 * into a fake duplicate when two stores each hold part of it, and what keeps two participants
 * who share a number apart. The drafts are local to one planning run.
 */

export const sameInvoice = (draft, spec) => draft.boardId === spec.boardId
  && numberKey(draft.source, draft.number) === numberKey(spec.source, spec.number)
  && draft.participantKey === participantKey(spec.participantName);

/** The draft for an invoice: among duplicates of one number, the one already listing the item, else the first. */
export const findDraft = (drafts, spec) => {
  const candidates = drafts.filter((draft) => sameInvoice(draft, spec));
  return candidates.find((draft) => spec.itemId && draft.itemIds.includes(spec.itemId)) ?? candidates[0];
};

/** The drafts, in order, that list this item. */
export const draftsListing = (drafts, itemId) => drafts.filter((draft) => draft.itemIds.includes(itemId));

/** A draft from one source's first sighting of an invoice. */
export function newDraft(spec) {
  return {
    boardId: spec.boardId,
    source: spec.source,
    number: spec.number,
    legacyNumbers: [...(spec.legacyNumbers || [])],
    participantName: cleanName(spec.participantName),
    participantKey: participantKey(spec.participantName),
    itemIds: [],
    dates: [],
    pdfLinks: [],
    ledgerRowIds: [],
    knownTotal: undefined,
    reason: spec.reason,
    revisited: false,
    xero: undefined,
    trigger: undefined,
  };
}

/** Add one sighting of an item to the draft for its invoice, creating the draft the first time. */
export function place(drafts, spec) {
  const draft = findDraft(drafts, spec) ?? (() => {
    const created = newDraft(spec);
    drafts.push(created);
    return created;
  })();
  if (spec.itemId && !draft.itemIds.includes(spec.itemId)) draft.itemIds.push(spec.itemId);
  for (const legacy of spec.legacyNumbers || []) if (!draft.legacyNumbers.includes(legacy)) draft.legacyNumbers.push(legacy);
  draft.dates.push(...(spec.dates || []));
  if (spec.pdfLink && !draft.pdfLinks.includes(spec.pdfLink)) draft.pdfLinks.push(spec.pdfLink);
  if (spec.revisited) draft.revisited = true;
  return draft;
}

/** The date an invoice was raised: what the ledger stated, else the earliest sighting. */
export const issuedAtOf = (draft) => draft.issuedAt ?? earliest(draft.dates);
