/**
 * What a participant's billing contact receives when the workspace has not
 * written its own subject and message.
 *
 * The previous defaults were a subject of `invoice for board jpjztrn14pJ` and
 * an **empty body**. Both are what a developer needs, not what a client needs:
 * a raw board id names an internal record nobody outside the product has ever
 * seen, and an empty body sends a PDF with no statement of what it is or who
 * it came from.
 *
 * These use the business and board *names* instead, which is what the people
 * receiving them recognise.
 *
 * A workspace that fills in Email Subject or Email Message still overrides
 * these entirely — they are the floor, not a policy.
 */

import { KIND_INVOICE, KIND_STATEMENT } from '../constants/automation.js';

const HTML_ESCAPES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * Escape a value destined for the HTML body.
 *
 * Participant and business names are data, and reach this from ISO+ without
 * ever being sanitised for markup. A name containing a tag would otherwise be
 * injected into an email the product sends on the client's behalf.
 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * 'Invoice' / 'Statement', matching the wording a recipient expects.
 *
 * Matched explicitly in both directions rather than "statement, else invoice".
 * The kinds are `invoice_automation` and `statement_automation`, and an
 * else-branch would label anything unrecognised an Invoice — so a statement
 * arriving under a renamed or new kind would go to a client calling itself a
 * bill. An unknown kind gets the neutral noun instead, which is wrong-looking
 * rather than wrong.
 */
function documentNoun(kind, { plural = false } = {}) {
  let noun = 'Document';
  if (kind === KIND_STATEMENT) noun = 'Statement';
  else if (kind === KIND_INVOICE) noun = 'Invoice';
  return plural ? `${noun}s` : noun;
}

const cleaned = (value) => String(value ?? '').trim();

/**
 * The subject line.
 *
 * Shaped as "<Document> <number> from <business>", degrading a clause at a
 * time: several documents drop the number and pluralise, no number drops it
 * entirely, and an unknown business drops the "from" clause rather than
 * rendering "from undefined" on something a client reads.
 */
export function defaultEmailSubject(kind, { businessName, documentNumbers = [] } = {}) {
  const numbers = (documentNumbers || []).map(cleaned).filter(Boolean);
  const business = cleaned(businessName);

  const head = numbers.length === 1
    ? `${documentNoun(kind)} ${numbers[0]}`
    : documentNoun(kind, { plural: numbers.length > 1 });

  return business ? `${head} from ${business}` : head;
}

/**
 * The message body, as HTML.
 *
 * Every clause is optional and omitted when its value is missing, so a partly
 * configured workspace still sends something readable rather than a sentence
 * with a hole in it. A statement says outright that it raises no new charges —
 * without that, a statement of account reads as a second bill for money
 * already invoiced.
 */
export function defaultEmailBody(kind, {
  businessName, boardName, participant, documentNumbers = [],
} = {}) {
  const numbers = (documentNumbers || []).map(cleaned).filter(Boolean);
  const business = cleaned(businessName);
  const board = cleaned(boardName);
  const name = cleaned(participant);
  const isStatement = kind === KIND_STATEMENT;
  // Only a real invoice run gets payment-reference wording; an unknown kind
  // gets the neutral note rather than instructions for paying something that
  // may not be a bill.
  const isInvoice = kind === KIND_INVOICE;
  const noun = documentNoun(kind, { plural: numbers.length > 1 }).toLowerCase();

  const greeting = name ? `<p>Hello ${esc(name)},</p>` : '<p>Hello,</p>';

  const numberClause = numbers.length > 0
    ? ` (${numbers.map(esc).join(', ')})`
    : '';
  const boardClause = board ? ` for ${esc(board)}` : '';
  const senderClause = business ? ` from ${esc(business)}` : '';

  const lead = isStatement
    ? `<p>Your statement of account${numberClause}${senderClause} is attached${boardClause}.</p>`
    : `<p>Your ${noun}${numberClause}${senderClause} is attached${boardClause}.</p>`;

  let note = '';
  if (isStatement) {
    note = '<p>This statement summarises activity on your account. It is not a tax '
      + 'invoice and raises no new charges — every amount shown has already been '
      + 'invoiced to you.</p>';
  } else if (isInvoice) {
    note = '<p>Payment details are on the attached document. Please quote the '
      + 'invoice number as the reference when paying, so it is applied to the '
      + 'right account.</p>';
  }

  const closing = business
    ? `<p>If anything looks wrong, reply to this email and we will check it.</p>`
      + `<p>${esc(business)}</p>`
    : '<p>If anything looks wrong, reply to this email and we will check it.</p>';

  return `${greeting}${lead}${note}${closing}`;
}
