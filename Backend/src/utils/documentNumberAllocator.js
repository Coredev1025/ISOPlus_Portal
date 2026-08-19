// Claiming the next number for a generated document, atomically.
//
// One implementation, because there were three and one of them was wrong. The
// NDIS invoice generator and the statement generator each claim inside a single
// findOneAndUpdate; the Age Care participant tax invoice read the counter,
// rendered a PDF, uploaded it, wrote back to ISO+, and only then incremented
// and saved. Two generations overlapping anywhere across those awaits both read
// the same number and both put it on an invoice — and unlike a gap in the
// sequence, a duplicate invoice number is a billing bug a client sees.
//
// A run that claims and then fails leaves a gap. That is the deliberate trade:
// a gap is cosmetic, a duplicate is not.

import Business from '../models/Business.js';
import { mongoEq } from './securityHelpers.js';

/** A schema default, read from the model so a counter has one definition. */
export function documentNumberingDefault(docType, field) {
  return Business.schema.path(`documentNumbering.${docType}.${field}`)?.defaultValue;
}

/**
 * Claim the next number for `docType` ('invoice', 'statement', 'quote', …) and
 * return it formatted with the workspace's prefix.
 *
 * The increment is an aggregation pipeline rather than a bare `$inc` because a
 * schema default does not backfill stored documents: `$inc` on a counter a
 * Business was saved without would create it at 1 and mint 'STM-0'. `$ifNull`
 * starts such a workspace at the declared default instead.
 *
 * `new: true` returns the counter AFTER the increment, so the number this
 * caller owns is one below it.
 *
 * Returns null when the workspace has no Business — the caller decides whether
 * that is an error (an invoice cannot be numbered) or an empty string (a
 * statement number is optional).
 */
export async function claimDocumentNumber(workspaceId, docType) {
  const start = documentNumberingDefault(docType, 'nextNumber');
  const claimed = await Business.findOneAndUpdate(
    { workspaceId: mongoEq(String(workspaceId)) },
    [{
      $set: {
        [`documentNumbering.${docType}.nextNumber`]: {
          $add: [{ $ifNull: [`$documentNumbering.${docType}.nextNumber`, start] }, 1],
        },
      },
    }],
    { new: true },
  ).lean();

  if (!claimed) return null;
  const numbering = claimed.documentNumbering?.[docType] ?? {};
  const prefix = numbering.prefix ?? documentNumberingDefault(docType, 'prefix');
  return `${prefix}${numbering.nextNumber - 1}`;
}
