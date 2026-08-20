import { describe, it, expect } from 'vitest';

import { KIND_INVOICE, KIND_STATEMENT } from '../../../src/constants/automation.js';
import {
  defaultEmailBody,
  defaultEmailSubject,
} from '../../../src/utils/automationEmailDefaults.js';

/**
 * What a participant's billing contact receives when the workspace has not
 * written its own subject and message.
 *
 * The old defaults were a subject of `invoice for board jpjztrn14pJ` and an
 * empty body — a raw board id and no explanation of what the attachment is or
 * who sent it. These are what goes out instead.
 *
 * Every branch degrades to something a person can still read: an unknown
 * business name drops the "from" clause rather than rendering "from
 * undefined", and a missing document number drops the number rather than
 * leaving a dangling label.
 */

const ctx = (extra = {}) => ({
  businessName: 'ISO Consulting Services',
  boardName: 'Care Management',
  participant: 'Martin Space',
  documentNumbers: ['INV-1004 (ISO+™)'],
  ...extra,
});

describe('defaultEmailSubject', () => {
  it('names the document and the sender, not the board id', () => {
    expect(defaultEmailSubject(KIND_INVOICE, ctx()))
      .toBe('Invoice INV-1004 (ISO+™) from ISO Consulting Services');
  });

  it('uses the statement wording for a statement run', () => {
    const subject = defaultEmailSubject(KIND_STATEMENT, ctx({
      documentNumbers: ['STM-2026-08-0001'],
    }));
    expect(subject).toBe('Statement STM-2026-08-0001 from ISO Consulting Services');
  });

  it('pluralises when one email carries several documents', () => {
    const subject = defaultEmailSubject(KIND_INVOICE, ctx({
      documentNumbers: ['INV-1004 (ISO+™)', 'INV-1005 (ISO+™)'],
    }));
    expect(subject).toBe('Invoices from ISO Consulting Services');
  });

  it('drops the number when there is none, rather than leaving a dangling label', () => {
    expect(defaultEmailSubject(KIND_INVOICE, ctx({ documentNumbers: [] })))
      .toBe('Invoice from ISO Consulting Services');
  });

  it('drops the sender clause when the business name is unknown', () => {
    // "from undefined" on a document going to a client is worse than no clause.
    expect(defaultEmailSubject(KIND_INVOICE, ctx({ businessName: null, documentNumbers: [] })))
      .toBe('Invoice');
  });

  it('never contains a board id', () => {
    const subject = defaultEmailSubject(KIND_INVOICE, ctx({ boardName: null }));
    expect(subject).not.toMatch(/board/i);
  });
});

describe('defaultEmailBody', () => {
  it('addresses the participant and says what is attached', () => {
    const body = defaultEmailBody(KIND_INVOICE, ctx());
    expect(body).toContain('Martin Space');
    expect(body).toContain('INV-1004 (ISO+™)');
    expect(body).toContain('ISO Consulting Services');
    expect(body).toMatch(/attach/i);
  });

  it('uses the board name for context, never the board id', () => {
    const body = defaultEmailBody(KIND_INVOICE, ctx());
    expect(body).toContain('Care Management');
    expect(body).not.toMatch(/jpjztrn14pJ/);
  });

  it('says a statement raises no new charges, so it is not mistaken for a bill', () => {
    const body = defaultEmailBody(KIND_STATEMENT, ctx({ documentNumbers: ['STM-1'] }));
    expect(body).toMatch(/not a tax invoice|no new charges/i);
  });

  it('is HTML, so the composed email is not a wall of plain text', () => {
    expect(defaultEmailBody(KIND_INVOICE, ctx())).toMatch(/<p>/);
  });

  it('omits the greeting name when the participant is unknown', () => {
    const body = defaultEmailBody(KIND_INVOICE, ctx({ participant: null }));
    expect(body).toMatch(/<p>Hello,/);
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('null');
  });

  it('omits the board clause when the board name is unknown', () => {
    const body = defaultEmailBody(KIND_INVOICE, ctx({ boardName: null }));
    expect(body).not.toContain('undefined');
    expect(body).not.toMatch(/for the\s*\./);
  });

  it('escapes a participant name containing HTML, so a name cannot inject markup', () => {
    const body = defaultEmailBody(KIND_INVOICE, ctx({ participant: '<script>x</script>Bob' }));
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
  });
});

describe('an unrecognised kind', () => {
  // The kinds are `invoice_automation` and `statement_automation`. A
  // "statement, else invoice" branch would label anything else an Invoice, so
  // a statement under a renamed kind would reach a client calling itself a
  // bill. Neutral wording is wrong-looking rather than wrong.
  it('is not labelled an invoice', () => {
    expect(defaultEmailSubject('something_else', ctx({ documentNumbers: [] })))
      .toBe('Document from ISO Consulting Services');
  });

  it('carries no payment instructions', () => {
    const body = defaultEmailBody('something_else', ctx());
    expect(body).not.toMatch(/quote the invoice number/i);
    expect(body).toContain('Martin Space');
  });
});
