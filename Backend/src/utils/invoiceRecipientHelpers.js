// Backend/src/utils/invoiceRecipientHelpers.js
//
// KAN-272: the recipient/address resolution rule for invoices and statements,
// applying alike to NDIS Certification, NDIS Verification, SaH and
// SaH (Low-cat) boards. There is no manual choice any more — the "Recipient"
// dropdown this replaced (AutomationSettings.recipient) let a workspace pick
// Billing Contact or Client/Participant independently of whether a Billing
// Email was actually on the profile, which is how a profile with a Billing
// Email configured could still have every invoice mailed to the participant.
// This module is the single place that derives the recipient from the ISO+
// participant-profile data alone, so a PDF's printed name/address and the
// mailbox an email is sent to can never disagree again.
//
// Case A:  Billing Email, Billing Contact and Billing Address all present
//          -> recipient is the Billing Contact, printed as themselves.
// Case AA: Billing Email present, but Billing Contact or Billing Address is
//          blank -> still the Billing Contact as the recipient, but printed
//          under the participant's own name and address, because there is
//          nothing billing-shaped to print.
// Case B:  Billing Email blank -> recipient is the participant, printed
//          under their own name and address.
//
// Deliberately ignorant of email delivery beyond the Billing Email itself:
// the caller decides what a null billingEmail falls back to.
// services/email/recipients.js has its own existing fallback to the
// participant's own Email attribute for that case, which this ticket
// preserves rather than replaces.

import { REF_ATTRIBUTE_NAMES } from '../constants/monthlyStatementAttributes.js';

export const RECIPIENT_TYPE_BILLING_CONTACT = 'billing_contact';
export const RECIPIENT_TYPE_CLIENT_PARTICIPANT = 'client_participant';

const trim = (value) => (value === null || value === undefined ? '' : String(value).trim());

/** The participant's own address, as the printed lines Case AA and B share. */
function participantAddressLines({ address, suburb, state, postcode }) {
  const locality = [trim(state), trim(postcode)].filter(Boolean).join(' ');
  return [trim(address), trim(suburb), locality].filter(Boolean);
}

/**
 * The single Case A/AA/B switch. Pure: every value in, the resolved shape
 * out — no I/O, no default fetching, so every branch is testable without a
 * profile Item or a database.
 *
 * @param {object} [params]
 * @param {string} [params.billingEmail]
 * @param {string} [params.billingContact]
 * @param {string} [params.billingAddress]
 * @param {string} [params.fullName] the participant's own name (Full
 *   Name/Preferred Name). Callers already resolve this their own way —
 *   fallback chains differ per call site — so it is taken as-is rather than
 *   re-derived here.
 * @param {string} [params.address]
 * @param {string} [params.suburb]
 * @param {string} [params.state]
 * @param {string} [params.postcode]
 * @returns {{
 *   recipientType: 'billing_contact' | 'client_participant',
 *   recipientName: string,
 *   addressLines: string[],
 *   billingEmail: string | null,
 * }}
 */
export function resolveInvoiceRecipient({
  billingEmail,
  billingContact,
  billingAddress,
  fullName,
  address,
  suburb,
  state,
  postcode,
} = {}) {
  const email = trim(billingEmail);
  const contact = trim(billingContact);
  const billAddress = trim(billingAddress);
  const participantLines = participantAddressLines({ address, suburb, state, postcode });

  if (!email) {
    return {
      recipientType: RECIPIENT_TYPE_CLIENT_PARTICIPANT,
      recipientName: trim(fullName),
      addressLines: participantLines,
      billingEmail: null,
    };
  }

  if (contact && billAddress) {
    return {
      recipientType: RECIPIENT_TYPE_BILLING_CONTACT,
      recipientName: contact,
      addressLines: [billAddress],
      billingEmail: email,
    };
  }

  return {
    recipientType: RECIPIENT_TYPE_BILLING_CONTACT,
    recipientName: trim(fullName),
    addressLines: participantLines,
    billingEmail: email,
  };
}

/**
 * The seven profile attributes `resolveInvoiceRecipient` needs, read off an
 * already-fetched profile Item via whichever `getValueFromFlatData`-shaped
 * reader ((item, attributeName) => value) the call site already has.
 *
 * `fullName` is a parameter, not read here, for the same reason it is a
 * parameter of `resolveInvoiceRecipient` above: callers already resolve the
 * participant's display name their own way, and re-deriving it here would be
 * a second, possibly-disagreeing, source of the same value.
 */
export function readProfileRecipientAttributes(profileItem, getValueFromFlatData, fullName) {
  const read = (name) => trim(getValueFromFlatData(profileItem, name));
  return {
    billingEmail: read(REF_ATTRIBUTE_NAMES.PROFILE_BILLING_EMAIL),
    billingContact: read(REF_ATTRIBUTE_NAMES.PROFILE_BILLING_CONTACT),
    billingAddress: read(REF_ATTRIBUTE_NAMES.PROFILE_BILLING_ADDRESS),
    fullName: trim(fullName),
    address: read(REF_ATTRIBUTE_NAMES.PROFILE_ADDRESS),
    suburb: read(REF_ATTRIBUTE_NAMES.PROFILE_SUBURB),
    state: read(REF_ATTRIBUTE_NAMES.PROFILE_STATE),
    postcode: read(REF_ATTRIBUTE_NAMES.PROFILE_POSTCODE) || read(REF_ATTRIBUTE_NAMES.PROFILE_POST_CODE),
  };
}
