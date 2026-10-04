/**
 * The backfill report (design 6.4): counts and lists, built as the rules run. Pure
 * apart from the object it fills.
 */

export function newReport() {
  return {
    counts: {
      created: {}, itemsLinked: 0, alreadyRecorded: 0, revisitedLogRows: 0,
    },
    lists: {
      unplaceable: [],
      unplaceableLedgerRows: [],
      deletedItems: [],
      deletedDocuments: [],
      staleLegacy: [],
      pendingTokens: [],
      markerNotOnInvoice: [],
      markerMissing: [],
      duplicateNumbers: [],
      regeneratedDocuments: [],
      doubleBilled: [],
      xeroSpansInvoices: [],
      xeroConflicts: [],
      suppressedMarkers: [],
      amountsUnknown: [],
      existingMissingItems: [],
    },
  };
}

export const note = (report, list, entry) => report.lists[list].push(entry);
