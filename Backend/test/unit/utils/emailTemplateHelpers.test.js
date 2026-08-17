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
