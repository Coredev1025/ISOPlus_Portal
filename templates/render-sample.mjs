#!/usr/bin/env node
/**
 * Render a sample statement of account from the LIVE template, so anyone
 * editing `Backend/src/assets/statementOfAccount.json` can eyeball the result
 * without wiring up a real participant and a real ledger first.
 *
 * There is no second template under templates/ — see templates/README.md for
 * why — so this script imports the same renderer the app uses in production,
 * `Backend/src/utils/statementOfAccountPdf.js`, by relative path. That file's
 * own imports (pdfme, the statement helpers) resolve against Backend's own
 * node_modules because Node resolves a module's bare imports relative to that
 * module's own location, not the location of whatever imported it — so this
 * script needs no dependencies of its own and Backend's `npm install` is the
 * only one that has to have been run.
 *
 * Run:
 *   node templates/render-sample.mjs
 * from the repo root (Backend/node_modules must exist — `npm ci` or
 * `npm install` inside Backend/ if it does not).
 *
 * Writes:
 *   templates/statement-sample.pdf
 * which is gitignored (templates/.gitignore) — see templates/README.md for
 * why a rendered PDF is never committed.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderStatementOfAccountPdf } from '../Backend/src/utils/statementOfAccountPdf.js';
import { buildRunningBalance, roundMoney } from '../Backend/src/utils/statementTransactions.js';
import { buildAgeingSummary } from '../Backend/src/utils/statementAgeing.js';
import { DEFAULT_TIMEZONE } from '../Backend/src/constants/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, 'statement-sample.pdf');

/**
 * Enough rows to outgrow one page without running to many: a probe run (see
 * templates/README.md) found 15-30 charge rows all land on exactly two pages
 * with this template, and two pages is what section 6 of the spec describes
 * the reference render as. 15 charge rows plus a payment and a refund sits
 * mid-range in that band.
 */
function sampleTransactions() {
  const months = ['2026-06', '2026-07', '2026-08'];
  const rows = [];
  let invoiceNumber = 1150;
  months.forEach((month, monthIndex) => {
    for (let week = 0; week < 5; week += 1) {
      const day = String(1 + week * 6).padStart(2, '0');
      rows.push({
        date: `${month}-${day}`,
        reference: `INV-${invoiceNumber}`,
        description: 'Care Management - NDIS - Certification - weekly services',
        charge: 149.5,
        payment: 0,
        sequence: monthIndex * 10 + week,
      });
      invoiceNumber += 1;
    }
  });
  // A payment and a refund, so the sample shows every column the template
  // renders rather than only charges.
  rows.push({
    date: '2026-08-10', reference: 'PMT-201', description: 'Payment received', charge: 0, payment: 750, sequence: 41,
  });
  rows.push({
    date: '2026-08-20', reference: 'CRN-14', description: 'Adjustment (Refund)', charge: -62.5, payment: 0, sequence: 42,
  });
  return rows;
}

function buildSampleStatement(timezone) {
  const transactions = sampleTransactions();
  const ledger = buildRunningBalance(0, transactions);
  const asAt = '2026-08-31T00:00:00.000+10:00';
  const outstanding = [
    { dueDate: '2026-07-15', amount: 149.5 },
    { dueDate: '2026-08-15', amount: 149.5 },
    { dueDate: '2026-09-14', amount: roundMoney(ledger.closingBalance - 2 * 149.5) },
  ];

  return {
    ledger,
    ageing: buildAgeingSummary(outstanding, asAt, timezone),
    provider: {
      name: 'Hillsgrade Care Services Pty Ltd',
      abn: '12 345 678 901',
      address: '4 Example Street, Sydney NSW 2000',
    },
    recipient: {
      name: 'Jane Sample',
      address: '10 Client Avenue, Parramatta NSW 2150',
    },
    meta: {
      statementNumber: 'STM-SAMPLE-1',
      statementDate: asAt,
      periodStart: '2026-01-01',
      periodEnd: '2026-08-31',
      accountNumber: 'ACC-SAMPLE-1',
    },
    bank: {
      accountName: 'Hillsgrade Care Services Pty Ltd',
      bankName: 'Example Bank',
      bsb: '000-000',
      accountNumber: '12345678',
      reference: 'ACC-SAMPLE-1',
    },
  };
}

async function main() {
  const statement = buildSampleStatement(DEFAULT_TIMEZONE);
  const pdfBytes = await renderStatementOfAccountPdf(statement, DEFAULT_TIMEZONE);
  await writeFile(OUTPUT_PATH, pdfBytes);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${pdfBytes.length} bytes to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to render sample statement:', err);
  process.exitCode = 1;
});
