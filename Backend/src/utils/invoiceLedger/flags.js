import {
  INVOICE_LEDGER_READ_ENV,
  INVOICE_LEDGER_WRITE_ENV,
  READ_MODE,
  WRITE_MODE,
} from '../../constants/invoiceLedger.js';

/**
 * The invoice ledger's two rollout flags (KAN-302). Read at call time, not import
 * time, so changing an Elastic Beanstalk property takes effect when the process
 * restarts and a test can set the environment it wants. Anything unexpected parses
 * to off: a typo must never switch the new record on.
 */

const normalise = (value) => String(value ?? '').trim().toLowerCase();

/** Whether issuing an invoice also writes the new record. */
export function invoiceLedgerWriteEnabled(env = process.env) {
  return normalise(env[INVOICE_LEDGER_WRITE_ENV]) === WRITE_MODE.ON;
}

/** `off`, `shadow` or `on`: which store the readers answer from. */
export function invoiceLedgerReadMode(env = process.env) {
  const mode = normalise(env[INVOICE_LEDGER_READ_ENV]);
  return Object.values(READ_MODE).includes(mode) ? mode : READ_MODE.OFF;
}
