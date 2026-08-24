/**
 * What a generated document is missing from the business profile.
 *
 * A workspace that has never set a logo or bank details still generates
 * invoices perfectly happily — they just come out with a blank corner and no
 * way to pay them. Nothing anywhere said so, and the only signal was a human
 * noticing the blank space after the document had already reached a client.
 *
 * This is the check that turns "the PDF looks wrong" into a log line naming
 * the field. It does not block generation: refusing to invoice because a logo
 * is missing would be worse than the missing logo, and the same document is
 * often correct in every other respect.
 *
 * Bank details are the serious half — an invoice with no account number cannot
 * be paid at all — so callers can weigh them differently from the logo.
 */

const BANK_FIELDS = ['accountName', 'bankName', 'bsb', 'accountNumber'];

/** Present means a non-empty string once trimmed. A tabbed-through field is not set. */
const isSet = (value) => Boolean(String(value ?? '').trim());

/**
 * The dotted names of the branding fields this business has not set, in the
 * order they appear on the document.
 *
 * @param {object|null|undefined} business
 * @returns {string[]} empty when the profile is complete
 */
export function missingDocumentBranding(business) {
  const missing = [];
  if (!isSet(business?.defaultLogo)) missing.push('defaultLogo');
  for (const field of BANK_FIELDS) {
    if (!isSet(business?.bankDetails?.[field])) missing.push(`bankDetails.${field}`);
  }
  return missing;
}

/** True when anything a client needs in order to pay is missing. */
export function isMissingPaymentDetails(business) {
  return missingDocumentBranding(business).some((field) => field.startsWith('bankDetails.'));
}
