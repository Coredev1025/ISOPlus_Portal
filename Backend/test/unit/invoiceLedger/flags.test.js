import { describe, it, expect } from 'vitest';

import {
  invoiceLedgerWriteEnabled,
  invoiceLedgerReadMode,
} from '../../../src/utils/invoiceLedger/flags.js';

/**
 * The two rollout flags (KAN-302). Both default to off, and anything unexpected
 * parses to off: a typo in an Elastic Beanstalk property must never switch the new
 * record on by accident.
 */

describe('INVOICE_LEDGER_WRITE', () => {
  it('is off when the variable is unset', () => {
    expect(invoiceLedgerWriteEnabled({})).toBe(false);
  });

  it('is on only for the exact value "on"', () => {
    expect(invoiceLedgerWriteEnabled({ INVOICE_LEDGER_WRITE: 'on' })).toBe(true);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(invoiceLedgerWriteEnabled({ INVOICE_LEDGER_WRITE: ' ON ' })).toBe(true);
  });

  it.each(['off', '', 'true', '1', 'yes', 'enabled', 'shadow', 'onn'])('is off for %j', (value) => {
    expect(invoiceLedgerWriteEnabled({ INVOICE_LEDGER_WRITE: value })).toBe(false);
  });
});

describe('INVOICE_LEDGER_READ', () => {
  it('is off when the variable is unset', () => {
    expect(invoiceLedgerReadMode({})).toBe('off');
  });

  it.each(['off', 'shadow', 'on'])('accepts %s', (mode) => {
    expect(invoiceLedgerReadMode({ INVOICE_LEDGER_READ: mode })).toBe(mode);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(invoiceLedgerReadMode({ INVOICE_LEDGER_READ: ' Shadow ' })).toBe('shadow');
  });

  it.each(['', 'true', '1', 'yes', 'both', 'shadow-on', 'ONN'])('falls back to off for %j', (value) => {
    expect(invoiceLedgerReadMode({ INVOICE_LEDGER_READ: value })).toBe('off');
  });
});
