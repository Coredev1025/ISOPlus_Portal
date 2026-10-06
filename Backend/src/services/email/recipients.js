// Turns a participant's ISO+ profile into a real mailbox, by reading the
// participant-profile Item in the Intake Register.
//
// KAN-272: mailbox selection used to follow a per-workspace "Recipient"
// setting (billing_contact | client_participant) passed in as `recipientType`
// — which is how a profile with a Billing Email on file could still have
// every invoice mailed to the participant, because the setting said
// Client/Participant. That setting is gone. Mailbox selection is now Case
// A/AA/B, driven purely by Billing Email presence — the same rule
// invoiceRecipientHelpers.js applies to PDF content, so a document and its
// envelope can never disagree about who they are addressed to.
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
import { resolveInvoiceRecipient, readProfileRecipientAttributes } from '../../utils/invoiceRecipientHelpers.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { warn } from '../../utils/logger.js';

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

/**
 * The participant's profile Item, or null.
 *
 * Exported because the statement of account addresses the same person this
 * module emails, and resolving the name twice by two different rules is how a
 * document and its envelope end up disagreeing about who they are for.
 */
export async function findParticipantProfile(workspaceId, boardId, name) {
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
 * Case A/AA/B (KAN-272), for mailbox selection only:
 *
 * A Billing Email on the profile is always the mailbox (Case A/AA — printed
 * name/address may fall back to the participant's own, but the address this
 * module resolves is the Billing Email either way). When there is no Billing
 * Email (Case B) we fall back to the participant's own Email — unconditionally,
 * even when a Billing Contact is named without an address of their own: that
 * named-but-addressless case used to refuse, back when a manual "Recipient"
 * setting could deliberately choose "Billing Contact" and a fallback to the
 * participant would have delivered to a person the configuration did not
 * choose. There is no such choice any more, so the fallback always applies —
 * `billingContactNamed` only changes the *source* label (and so whether the
 * caller logs it at warn), not the outcome, so an incomplete billing setup
 * stays visible without changing where the mail goes.
 *
 * Pure: profile item in, outcome out. No I/O, no logging — which is what
 * makes every branch testable on its own.
 */
export function selectProfileAddress(profileItem) {
  const recipient = resolveInvoiceRecipient(readProfileRecipientAttributes(profileItem, readValue, ''));
  if (recipient.billingEmail) {
    return classifyAddress(recipient.billingEmail, 'profile_billing_email', 'no_address_on_profile');
  }
  const billingContactNamed = Boolean(readValue(profileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_CONTACT));
  return classifyAddress(
    readValue(profileItem, REF_ATTRIBUTE_NAMES.PROFILE_EMAIL),
    billingContactNamed ? 'profile_email_billing_contact_unaddressed' : 'profile_email_billing_fallback',
    'no_address_on_profile',
  );
}

// The address itself is deliberately absent from the log line: nothing in
// utils/sanitizeLog.js redacts email addresses, and the profile itemId is
// enough to open the record and read the offending value.
function logOutcome(outcome, context) {
  if (outcome.source === 'profile_email_billing_fallback') {
    warn('Email-Recipients', 'No Billing Email and no named Billing Contact — using the participant Email', context);
    return;
  }
  if (outcome.source === 'profile_email_billing_contact_unaddressed') {
    // KAN-272: this used to refuse outright (billing_contact_has_no_address),
    // back when a manual "Recipient" setting could deliberately choose
    // Billing Contact and a fallback would have delivered to a person the
    // configuration did not choose. There is no such choice any more, so this
    // now sends — but a Billing Contact named without an address is still an
    // incomplete profile worth a run seeing.
    warn('Email-Recipients', 'Billing Contact named but no Billing Email — using the participant Email', context);
    return;
  }
  if (outcome.address === null) {
    warn('Email-Recipients', `Could not resolve a recipient address: ${outcome.reason}`, context);
  }
}

/**
 * The profile with this item id, in this workspace. KAN-293: a document knows
 * which Participant Profile it belongs to, and a profile has one address, so the
 * profile is found by its own id and not by a name that two clients can share.
 */
async function findProfileById(workspaceId, profileId) {
  return Item.findOne({
    workspaceId: mongoEq(workspaceId),
    itemId: mongoEq(String(profileId)),
  }).select('data boardId itemId').lean();
}

/**
 * @param {object} params
 * @param {string} params.workspaceId
 * @param {string} [params.boardId] tie-breaker only; the lookup is workspace-wide
 * @param {string|null} params.participant display name, null for an unattributable group
 * @param {string} [params.profileId] the Participant Profile's item id. When given
 *   the profile is found by it and the name is not used, so a missing profile is
 *   `profile_not_found` and never a guess at somebody with the same name.
 * @returns {Promise<{address: string, source: string} | {address: null, reason: string}>}
 *
 * `source` is one of `profile_billing_email`, `profile_email_billing_fallback`,
 * `profile_email_billing_contact_unaddressed`. `reason` is one of
 * `no_participant_name`, `profile_not_found`, `no_address_on_profile`,
 * `malformed_address`.
 */
export async function resolveRecipient({ workspaceId, boardId = null, participant, profileId = null }) {
  const context = { workspaceId, boardId };
  const name = normalizeName(participant);
  if (!name && !profileId) {
    const outcome = { address: null, reason: 'no_participant_name' };
    logOutcome(outcome, context);
    return outcome;
  }

  const profileItem = profileId
    ? await findProfileById(workspaceId, profileId)
    : await findParticipantProfile(workspaceId, boardId, name);
  if (!profileItem) {
    const outcome = { address: null, reason: 'profile_not_found' };
    logOutcome(outcome, { ...context, participant: name });
    return outcome;
  }

  const outcome = selectProfileAddress(profileItem);
  logOutcome(outcome, { ...context, participant: name, profileItemId: profileItem.itemId });
  return outcome;
}
