/**
 * Renders statement-sample.pdf from statement-pdfme-template.json.
 *
 *   npm install @pdfme/generator @pdfme/schemas
 *   node render-sample.mjs
 *
 * The transaction list is generated rather than hand written, so the running
 * balance, the column totals and the ageing buckets always agree. The two
 * reconciliation assertions from 04-invoice-statement-generator.md run before
 * anything is rendered, and throw rather than producing a wrong document.
 *
 * There are deliberately enough rows to spill onto a second page, which is
 * what proves the dynamic table pushes the ageing summary, payment block and
 * notice down instead of overlapping them.
 */

import { generate } from '@pdfme/generator';
import { text, image, line, rectangle, table, multiVariableText } from '@pdfme/schemas';
import fs from 'node:fs';

const money = n => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const neg = n => '-$' + Math.abs(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Build a year of activity: a monthly invoice, a payment the following month,
// and a few adjustments. The last two invoices are left unpaid so there is a
// closing balance to age.
// ---------------------------------------------------------------------------

const MONTHS = [
  ['09', '2025'], ['10', '2025'], ['11', '2025'], ['12', '2025'],
  ['01', '2026'], ['02', '2026'], ['03', '2026'], ['04', '2026'],
  ['05', '2026'], ['06', '2026'], ['07', '2026'], ['08', '2026'],
];

const SERVICES = [
  'Care Management - SaH',
  'Care Management - SaH - Low Cat',
  'Care Management - NDIS - Certification',
  'Care Management - NDIS - Verification',
];

const openingBalance = 284.20;
const events = [];

// The opening balance is settled by the first payment.
events.push({ date: `08/${MONTHS[0][0]}/${MONTHS[0][1]}`, ref: 'PMT-0401', desc: 'Payment received - direct deposit', payment: openingBalance });

MONTHS.forEach(([mm, yyyy], i) => {
  const amount = Math.round((820 + (i * 37.5) % 480) * 100) / 100;
  const service = SERVICES[i % SERVICES.length];
  events.push({
    date: `01/${mm}/${yyyy}`,
    ref: `INV-${1150 + i}`,
    desc: `${service} - ${['Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug'][i]} services`,
    charge: amount,
    invoice: true,
  });

  // A couple of adjustments part way through the year.
  if (i === 3) events.push({ date: `18/${mm}/${yyyy}`, ref: 'CRN-0021', desc: 'Adjustment (Refund) - service delivered with incorrect charge', charge: -62.50, settled: true });
  if (i === 7) events.push({ date: `21/${mm}/${yyyy}`, ref: 'ADJ-0009', desc: 'Adjustment (Charge) - reconciliation of April travel', charge: 48.00, settled: true });

  // Every invoice except the final two is paid the following month.
  if (i < MONTHS.length - 2) {
    const [pm, py] = MONTHS[i + 1];
    let settle = amount;
    if (i === 3) settle -= 62.50;
    if (i === 7) settle += 48.00;
    events.push({ date: `12/${pm}/${py}`, ref: `PMT-04${11 + i}`, desc: 'Payment received - direct deposit', payment: Math.round(settle * 100) / 100 });
  }
});

// ---------------------------------------------------------------------------
// Running balance and totals
// ---------------------------------------------------------------------------

let balance = openingBalance;
let totalCharges = 0;
let totalPayments = 0;

const rows = events.map(e => {
  const charge = e.charge ?? 0;
  const payment = e.payment ?? 0;
  totalCharges += charge;
  totalPayments += payment;
  balance = Math.round((balance + charge - payment) * 100) / 100;
  return [
    e.date,
    e.ref,
    e.desc,
    charge ? (charge < 0 ? neg(charge) : money(charge)) : '',
    payment ? money(payment) : '',
    money(balance),
  ];
});

totalCharges = Math.round(totalCharges * 100) / 100;
totalPayments = Math.round(totalPayments * 100) / 100;
const closingBalance = balance;

// The two unpaid invoices make up the closing balance. The most recent is not
// yet due, the one before it is inside the first ageing bucket.
const unpaid = events.filter(e => e.invoice).slice(-2).map(e => e.charge);
const ageing = {
  current: unpaid[1],
  days30: unpaid[0],
  days60: 0,
  days90: 0,
  days90plus: 0,
};

// ---------------------------------------------------------------------------
// Reconciliation, per section 5 of the spec. Fail rather than render.
// ---------------------------------------------------------------------------

const ageingSum = Math.round(Object.values(ageing).reduce((a, b) => a + b, 0) * 100) / 100;
const computed = Math.round((openingBalance + totalCharges - totalPayments) * 100) / 100;

console.log(`transactions            : ${rows.length}`);
console.log(`opening                 : ${money(openingBalance)}`);
console.log(`charges                 : ${money(totalCharges)}`);
console.log(`payments                : ${money(totalPayments)}`);
console.log(`closing (running)       : ${money(closingBalance)}`);
console.log(`opening + chg - pmt     : ${money(computed)}`);
console.log(`ageing buckets sum      : ${money(ageingSum)}`);

if (Math.abs(computed - closingBalance) > 0.005) throw new Error('Statement does not reconcile');
if (Math.abs(ageingSum - closingBalance) > 0.005) throw new Error('Ageing does not reconcile');
console.log('reconciliation OK\n');

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const template = JSON.parse(fs.readFileSync('statement-pdfme-template.json', 'utf8'));

const inputs = [{
  title: 'STATEMENT OF ACCOUNT',
  providerBlock: 'Sample Care Services Pty Ltd\nABN: 00 000 000 000\n12 Example Street\nSampleton\nVictoria 3000\nAustralia',
  statementToLabel: 'STATEMENT TO',
  participantBlock: 'SAMPLE PARTICIPANT\n34 Placeholder Road\nExampleville VIC 3001',
  metaLabels: 'Statement number\nStatement date\nPeriod\nAccount number',
  metaValues: `STM-2026-08-0001\n31/08/2026\n01/09/2025 to 31/08/2026\nACC-00000`,
  openingLabel: 'OPENING BALANCE',
  openingBalance: money(openingBalance),
  chargesLabel: 'CHARGES',
  totalCharges: money(totalCharges),
  paymentsLabel: 'PAYMENTS',
  totalPayments: money(totalPayments),
  closingLabel: 'CLOSING BALANCE',
  closingBalance: money(closingBalance),
  transactions: rows,
  ageingLabel: 'AGEING SUMMARY',
  ageingHeadCurrent: 'Current',
  ageingHead30: '1-30 days',
  ageingHead60: '31-60 days',
  ageingHead90: '61-90 days',
  ageingHead90plus: '90+ days',
  ageingCurrent: money(ageing.current),
  ageingDays30: money(ageing.days30),
  ageingDays60: money(ageing.days60),
  ageingDays90: money(ageing.days90),
  ageingDays90plus: money(ageing.days90plus),
  paymentLabel: 'PAYMENT DETAILS',
  paymentLabels: 'Account name\nBank\nBSB\nAccount number\nReference',
  paymentValues: 'Sample Care Services Pty Ltd\nExample Bank\n000-000\n00000000\nACC-00000',
  amountDueLabel: 'TOTAL AMOUNT DUE',
  amountDue: money(closingBalance),
  notice: 'This statement summarises activity on your account for the period shown. It is not a tax invoice and raises no new charges. Every amount listed here appears on a tax invoice already issued to you. When making a payment, please quote the invoice number as the reference so it is applied correctly. If any entry looks wrong, contact us before paying and we will check it.',
}];

const pdf = await generate({
  template,
  inputs,
  plugins: { text, image, line, rectangle, table, multiVariableText },
});

fs.writeFileSync('statement-sample.pdf', pdf);
console.log(`written statement-sample.pdf  ${pdf.length} bytes`);
