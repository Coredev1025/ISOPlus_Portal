import { describe, it, expect } from 'vitest';

import { substituteEmailTemplate } from '../../../src/utils/emailTemplateHelpers.js';

// The automation email spec's dynamic fields: {{invoice_number}},
// {{client_name}}, {{business_name}} (invoices) and {{statement_number}},
// {{client_name}}, {{business_name}} (statements). The helper is generic —
// the worker decides which vars exist for a given run; the helper only
// substitutes what it is given and leaves everything else alone.

describe('substituteEmailTemplate', () => {
  it('substitutes {{key}} tokens from vars', () => {
    expect(substituteEmailTemplate(
      'Invoice {{invoice_number}} for {{client_name}}',
      { invoice_number: 'IN-900', client_name: 'Samuel Rivers' },
    )).toBe('Invoice IN-900 for Samuel Rivers');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(substituteEmailTemplate(
      'From {{ business_name }} — {{  client_name}}',
      { business_name: 'Acme Care', client_name: 'Alex' },
    )).toBe('From Acme Care — Alex');
  });

  it('leaves a token verbatim when its key is absent from vars', () => {
    expect(substituteEmailTemplate(
      'Statement {{statement_number}} for {{client_name}}',
      { client_name: 'Alex' },
    )).toBe('Statement {{statement_number}} for Alex');
  });

  it('never substitutes the string "undefined" or "" for a missing value', () => {
    expect(substituteEmailTemplate(
      '{{a}}/{{b}}',
      { a: undefined, b: null },
    )).toBe('{{a}}/{{b}}');
  });

  it('substitutes every occurrence of a repeated token', () => {
    expect(substituteEmailTemplate(
      '{{client_name}} and {{client_name}} again',
      { client_name: 'Alex' },
    )).toBe('Alex and Alex again');
  });

  it('returns "" for a non-string or empty template', () => {
    expect(substituteEmailTemplate('', { a: 'x' })).toBe('');
    expect(substituteEmailTemplate(undefined, { a: 'x' })).toBe('');
    expect(substituteEmailTemplate(null, { a: 'x' })).toBe('');
    expect(substituteEmailTemplate(42, { a: 'x' })).toBe('');
  });

  it('handles a missing vars argument by leaving all tokens intact', () => {
    expect(substituteEmailTemplate('Hi {{client_name}}')).toBe('Hi {{client_name}}');
  });

  it('leaves text with no tokens untouched', () => {
    expect(substituteEmailTemplate('No tokens here', { a: 'x' })).toBe('No tokens here');
  });
});

// emailMessage is rich-text HTML authored in the Finance Settings automation
// tab and emailed as HTML. Participant and client names come from ISO+ board
// data, so a name containing '<', '&' or a quote is interpolated straight into
// the markup unless the substituted *value* is escaped.
//
// Escaping is a parameter of this function rather than something the caller
// applies afterwards, for one reason: applied afterwards it would have to run
// over the whole composed string, which escapes the author's own markup too and
// mails a body full of visible '&lt;p&gt;'. Only the substituted value can be
// escaped correctly, and only substitution knows which span that is.
describe('substituteEmailTemplate — HTML escaping', () => {
  it('escapes a substituted value when the template is HTML', () => {
    expect(substituteEmailTemplate(
      '<p>Dear {{client_name}},</p>',
      { client_name: 'Tom & <b>Jerry</b>' },
      { escapeHtml: true },
    )).toBe('<p>Dear Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;,</p>');
  });

  it("leaves the author's own markup untouched, so nothing is double-escaped", () => {
    expect(substituteEmailTemplate(
      '<p style="color:red">Hi {{client_name}} &amp; co</p>',
      { client_name: 'Alex' },
      { escapeHtml: true },
    )).toBe('<p style="color:red">Hi Alex &amp; co</p>');
  });

  it('escapes quotes so a value cannot break out of an HTML attribute', () => {
    expect(substituteEmailTemplate(
      '<a title="{{client_name}}">x</a>',
      { client_name: 'A" onmouseover="alert(1)' },
      { escapeHtml: true },
    )).toBe('<a title="A&quot; onmouseover=&quot;alert(1)">x</a>');
  });

  it('does not escape by default, so the plain-text subject line is unchanged', () => {
    expect(substituteEmailTemplate(
      'Invoices for {{client_name}}',
      { client_name: 'Tom & Jerry' },
    )).toBe('Invoices for Tom & Jerry');
    expect(substituteEmailTemplate(
      'Invoices for {{client_name}}',
      { client_name: 'Tom & Jerry' },
      { escapeHtml: false },
    )).toBe('Invoices for Tom & Jerry');
  });

  it('leaves an unresolved token intact and unescaped even in HTML mode', () => {
    expect(substituteEmailTemplate(
      '<p>{{statement_number}}</p>',
      { client_name: 'Alex' },
      { escapeHtml: true },
    )).toBe('<p>{{statement_number}}</p>');
  });
});
