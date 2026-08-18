// Turns the recipient *type* an AutomationSettings block stores
// (billing_contact | client_participant) into a real mailbox, by reading the
// participant-profile Item in the Intake Register.
//
// The worker knows a participant only as a display name, so every lookup here
// is a name match against the profile board. That makes the failure modes the
// interesting part: an automation that mails the wrong person is worse than one
// that mails nobody, so nothing below substitutes a different person's address
// and nothing throws for a missing one — the caller decides what a null means.

import Item from '../../models/Item.js';
import { REF_ATTRIBUTE_NAMES } from '../../constants/monthlyStatementAttributes.js';
import { EMAIL_PATTERN } from '../../constants/validation.js';
import { getValueFromFlatData } from '../../utils/automationInvoiceGeneratorDeps.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { warn } from '../../utils/logger.js';

const CLIENT_PARTICIPANT = 'client_participant';
const BILLING_CONTACT = 'billing_contact';

// How many same-named profiles we are willing to look at before giving up on
// disambiguating. Duplicates are a data-entry problem, not a query problem.
const PROFILE_MATCH_LIMIT = 10;

/**
 * A display name we are prepared to put into a query: a plain string, trimmed.
 * Anything else — an object, a number, null — is an unattributable group, not a
 * name, and is refused here rather than reaching mongoEq and throwing.
 */
function normalizeName(participant) {
  return typeof participant === 'string' ? participant.trim() : '';
}

/**
 * Attribute values arrive either as scalars or as ISO+ label objects; both
 * shapes reduce to the trimmed string, or '' when there is nothing there.
 */
function normalizeValue(raw) {
  if (raw === null || raw === undefined) return '';
  const scalar = typeof raw === 'object' ? (raw.name ?? raw.value ?? '') : raw;
  return String(scalar).trim();
}

function readValue(profileItem, attributeName) {
  return normalizeValue(getValueFromFlatData(profileItem, attributeName));
}

/**
 * The name variants the repo already tolerates for a participant profile.
 * Matching is exact (mongoEq only lets a literal through, which is the point —
 * a display name is user data and must never become a regex).
 */
export function participantNameClauses(name) {
  const clauses = [
    { [`data.${REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME}`]: mongoEq(name) },
    { [`data.${REF_ATTRIBUTE_NAMES.PROFILE_PREFERRED_NAME}`]: mongoEq(name) },
  ];
  const [first, ...rest] = name.split(/\s+/);
  if (rest.length > 0) {
    clauses.push({
      [`data.${REF_ATTRIBUTE_NAMES.PROFILE_FIRST_NAME}`]: mongoEq(first),
      [`data.${REF_ATTRIBUTE_NAMES.PROFILE_LAST_NAME}`]: mongoEq(rest.join(' ')),
    });
  }
  return clauses;
}

/**
 * Profiles live on the Intake Register, which is usually not the board being
 * invoiced, so the query is workspace-wide. `boardId` is only a tie-breaker for
 * the case where the same name exists on more than one board.
 */
export function pickProfileItem(items, boardId) {
  if (items.length <= 1) return items[0] ?? null;
  return items.find((item) => item.boardId === boardId) ?? items[0];
}

async function findParticipantProfile(workspaceId, boardId, name) {
  const items = await Item.find({
    workspaceId: mongoEq(workspaceId),
    $or: participantNameClauses(name),
  })
    .select('data boardId itemId')
    .limit(PROFILE_MATCH_LIMIT)
    .lean();
  return pickProfileItem(items, boardId);
}

/**
 * A stored value only counts as an address if it survives the shared
 * EMAIL_PATTERN — the same check the settings form and the business profile
 * apply. A malformed one is treated as no address at all; it is never repaired,
 * and it never triggers a fallback to somebody else.
 */
function classifyAddress(address, source, emptyReason) {
  if (!address) return { address: null, reason: emptyReason };
  if (!EMAIL_PATTERN.test(address)) return { address: null, reason: 'malformed_address' };
  return { address, source };
}

/**
 * Judgement call, stated once here:
 *
 * `billing_contact` means the Billing Email. When that is blank we fall back to
 * the participant's own Email *only if* no Billing Contact is named — that is
 * the self-managed participant, who is their own billing contact, and their own
 * invoice is already addressed to them. When a Billing Contact *is* named but
 * carries no address, we refuse: sending to the participant there would deliver
 * to a person the configuration deliberately did not choose. The fallback is
 * logged at warn by the caller so it is visible in a run, not silent.
 */
function selectBillingAddress(profileItem) {
  const billingEmail = readValue(profileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_EMAIL);
  if (billingEmail) {
    return classifyAddress(billingEmail, 'profile_billing_email', 'no_address_on_profile');
  }
  if (readValue(profileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_CONTACT)) {
    return { address: null, reason: 'billing_contact_has_no_address' };
  }
  return classifyAddress(
    readValue(profileItem, REF_ATTRIBUTE_NAMES.PROFILE_EMAIL),
    'profile_email_billing_fallback',
    'no_address_on_profile',
  );
}

/**
 * Pure: profile item plus recipient type in, outcome out. No I/O, no logging —
 * which is what makes every branch above testable on its own.
 */
export function selectProfileAddress(profileItem, recipientType) {
  if (recipientType === CLIENT_PARTICIPANT) {
    return classifyAddress(
      readValue(profileItem, REF_ATTRIBUTE_NAMES.PROFILE_EMAIL),
      'profile_email',
      'no_address_on_profile',
    );
  }
  if (recipientType === BILLING_CONTACT) return selectBillingAddress(profileItem);
  return { address: null, reason: 'unsupported_recipient_type' };
}

// The address itself is deliberately absent from the log line: nothing in
// utils/sanitizeLog.js redacts email addresses, and the profile itemId is
// enough to open the record and read the offending value.
function logOutcome(outcome, context) {
  if (outcome.source === 'profile_email_billing_fallback') {
    warn('Email-Recipients', 'No Billing Email and no named Billing Contact — using the participant Email', context);
    return;
  }
  if (outcome.address === null) {
    warn('Email-Recipients', `Could not resolve a recipient address: ${outcome.reason}`, context);
  }
}

/**
 * @param {object} params
 * @param {string} params.workspaceId
 * @param {string} [params.boardId] tie-breaker only; the lookup is workspace-wide
 * @param {string|null} params.participant display name, null for an unattributable group
 * @param {string} params.recipientType 'billing_contact' | 'client_participant'
 * @returns {Promise<{address: string, source: string} | {address: null, reason: string}>}
 *
 * `source` is one of `profile_email`, `profile_billing_email`,
 * `profile_email_billing_fallback`. `reason` is one of `no_participant_name`,
 * `unsupported_recipient_type`, `profile_not_found`, `no_address_on_profile`,
 * `billing_contact_has_no_address`, `malformed_address`.
 */
export async function resolveRecipient({ workspaceId, boardId = null, participant, recipientType }) {
  const context = { workspaceId, boardId, recipientType };
  const name = normalizeName(participant);
  if (!name) {
    const outcome = { address: null, reason: 'no_participant_name' };
    logOutcome(outcome, context);
    return outcome;
  }

  const profileItem = await findParticipantProfile(workspaceId, boardId, name);
  if (!profileItem) {
    const outcome = { address: null, reason: 'profile_not_found' };
    logOutcome(outcome, { ...context, participant: name });
    return outcome;
  }

  const outcome = selectProfileAddress(profileItem, recipientType);
  logOutcome(outcome, { ...context, participant: name, profileItemId: profileItem.itemId });
  return outcome;
}
