/**
 * Emits Backend/src/assets/statementOfAccount.json — the pdfme v5 template for
 * the statement of account.
 *
 * Written as a script rather than hand-authored JSON because the table styles
 * are repetitive and a hand-edited 700-line JSON drifts. Re-run it to change
 * the layout; commit the JSON it produces.
 */
import { writeFileSync } from 'node:fs';

const MARGIN = 20;
const CONTENT_W = 210 - MARGIN * 2; // 170mm
const RIGHT = MARGIN + CONTENT_W;

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const STRIP_BG = '#f9fafb';

const text = (name, opts) => ({
  type: 'text',
  name,
  content: opts.content ?? '',
  position: { x: opts.x, y: opts.y },
  width: opts.w,
  height: opts.h ?? 6,
  fontName: 'Roboto',
  fontSize: opts.size ?? 10,
  fontColor: opts.color ?? INK,
  alignment: opts.align ?? 'left',
  verticalAlignment: opts.valign ?? 'top',
  lineHeight: opts.lineHeight ?? 1.3,
  characterSpacing: opts.tracking ?? 0,
  readOnly: opts.readOnly ?? false,
});

const mvt = (name, opts) => ({
  ...text(name, opts),
  type: 'multiVariableText',
  text: opts.text,
  variables: opts.variables,
});

const line = (name, y) => ({
  type: 'line',
  name,
  position: { x: MARGIN, y },
  width: CONTENT_W,
  height: 0.4,
  color: RULE,
  readOnly: true,
});

const tableStyles = ({ headBg, headColor, bodySize, aligns, headAligns }) => ({
  tableStyles: { borderWidth: 0, borderColor: RULE },
  headStyles: {
    fontName: 'Roboto',
    fontSize: 8,
    characterSpacing: 0.4,
    alignment: 'left',
    verticalAlignment: 'middle',
    lineHeight: 1.2,
    fontColor: headColor ?? MUTED,
    borderColor: RULE,
    backgroundColor: headBg ?? '',
    borderWidth: { top: 0, right: 0, bottom: 0.4, left: 0 },
    padding: { top: 3, right: 2, bottom: 3, left: 2 },
  },
  bodyStyles: {
    fontName: 'Roboto',
    // 8.5pt with a 1.35 line height is what stops a long service description
    // clipping mid-word the way the sample does. pdfme grows the row to fit
    // wrapped text; it cannot grow text that has been given no room to wrap.
    fontSize: bodySize ?? 8.5,
    characterSpacing: 0,
    alignment: 'left',
    verticalAlignment: 'middle',
    lineHeight: 1.35,
    fontColor: INK,
    borderColor: RULE,
    backgroundColor: '',
    alternateBackgroundColor: '#fafafa',
    borderWidth: { top: 0, right: 0, bottom: 0.2, left: 0 },
    padding: { top: 2.6, right: 2, bottom: 2.6, left: 2 },
  },
  columnStyles: { alignment: aligns, ...(headAligns ? { headAlignment: headAligns } : {}) },
});

const schemas = [[
  // ── Header ────────────────────────────────────────────────────────────────
  text('title', {
    x: MARGIN, y: 22, w: 100, h: 10, size: 19, content: 'STATEMENT OF ACCOUNT', readOnly: true,
  }),
  mvt('provider', {
    x: RIGHT - 80, y: 21, w: 80, h: 26, size: 8.5, align: 'right', color: MUTED,
    text: '{providerName}\nABN {providerAbn}\n{providerAddress}',
    variables: ['providerName', 'providerAbn', 'providerAddress'],
  }),
  line('headerRule', 52),

  // ── Recipient and meta ────────────────────────────────────────────────────
  text('statementToLabel', {
    x: MARGIN, y: 58, w: 60, h: 4, size: 7, color: MUTED, tracking: 0.6,
    content: 'STATEMENT TO', readOnly: true,
  }),
  mvt('recipient', {
    x: MARGIN, y: 64, w: 85, h: 22, size: 10,
    text: '{recipientName}\n{recipientAddress}',
    variables: ['recipientName', 'recipientAddress'],
  }),
  text('metaLabels', {
    x: RIGHT - 90, y: 58, w: 45, h: 24, size: 8.5, align: 'right', color: MUTED,
    content: 'Statement number\nStatement date\nPeriod\nAccount number',
    readOnly: true,
  }),
  mvt('metaValues', {
    x: RIGHT - 44, y: 58, w: 44, h: 24, size: 8.5, align: 'right',
    text: '{statementNumber}\n{statementDate}\n{period}\n{accountNumber}',
    variables: ['statementNumber', 'statementDate', 'period', 'accountNumber'],
  }),

  // ── Summary strip ─────────────────────────────────────────────────────────
  {
    type: 'table',
    name: 'summary',
    position: { x: MARGIN, y: 92 },
    width: CONTENT_W,
    height: 20,
    content: '[["","","",""]]',
    showHead: true,
    head: ['OPENING BALANCE', 'CHARGES', 'PAYMENTS', 'CLOSING BALANCE'],
    headWidthPercentages: [25, 25, 25, 25],
    fontName: '',
    readOnly: false,
    ...tableStyles({ headBg: STRIP_BG, aligns: { 0: 'left', 1: 'left', 2: 'left', 3: 'left' } }),
  },

  // ── Transactions ──────────────────────────────────────────────────────────
  // The dynamic one. It grows with the data and pushes everything below it
  // down the page and on to page two.
  {
    type: 'table',
    name: 'transactions',
    position: { x: MARGIN, y: 122 },
    width: CONTENT_W,
    height: 40,
    content: '[["","","","","",""]]',
    showHead: true,
    head: ['Date', 'Reference', 'Description', 'Charges', 'Payments', 'Balance'],
    headWidthPercentages: [12, 14, 40, 11.5, 11.5, 11],
    fontName: '',
    readOnly: false,
    ...tableStyles({
      aligns: {
        0: 'left', 1: 'left', 2: 'left', 3: 'right', 4: 'right', 5: 'right',
      },
      headAligns: {
        0: 'left', 1: 'left', 2: 'left', 3: 'right', 4: 'right', 5: 'right',
      },
    }),
  },

  // ── Ageing ────────────────────────────────────────────────────────────────
  text('ageingLabel', {
    x: MARGIN, y: 172, w: 60, h: 4, size: 7, color: MUTED, tracking: 0.6,
    content: 'AGEING SUMMARY', readOnly: true,
  }),
  {
    type: 'table',
    name: 'ageing',
    position: { x: MARGIN, y: 178 },
    width: CONTENT_W,
    height: 18,
    content: '[["","","","",""]]',
    showHead: true,
    head: ['Current', '1-30 days', '31-60 days', '61-90 days', '90+ days'],
    headWidthPercentages: [20, 20, 20, 20, 20],
    fontName: '',
    readOnly: false,
    // Every bucket in the same ink. The sample renders 61-90 and 90+ in red
    // even when they are $0.00, which reads as a problem on an account that
    // has none.
    ...tableStyles({
      headBg: STRIP_BG,
      bodySize: 10,
      aligns: {
        0: 'center', 1: 'center', 2: 'center', 3: 'center', 4: 'center',
      },
      headAligns: {
        0: 'center', 1: 'center', 2: 'center', 3: 'center', 4: 'center',
      },
    }),
  },

  // ── Payment block ─────────────────────────────────────────────────────────
  line('payRule', 204),
  text('paymentLabel', {
    x: MARGIN, y: 209, w: 60, h: 4, size: 7, color: MUTED, tracking: 0.6,
    content: 'PAYMENT DETAILS', readOnly: true,
  }),
  text('paymentLabels', {
    x: MARGIN, y: 216, w: 30, h: 22, size: 8.5, color: MUTED,
    content: 'Account name\nBank\nBSB\nAccount number\nReference',
    readOnly: true,
  }),
  mvt('paymentValues', {
    x: MARGIN + 32, y: 216, w: 70, h: 22, size: 8.5,
    text: '{bankAccountName}\n{bankName}\n{bankBsb}\n{bankAccountNumber}\n{paymentReference}',
    variables: ['bankAccountName', 'bankName', 'bankBsb', 'bankAccountNumber', 'paymentReference'],
  }),
  text('totalDueLabel', {
    x: RIGHT - 70, y: 209, w: 70, h: 4, size: 7, color: MUTED, tracking: 0.6,
    align: 'right', content: 'TOTAL AMOUNT DUE', readOnly: true,
  }),
  mvt('totalDue', {
    x: RIGHT - 70, y: 215, w: 70, h: 11, size: 17, align: 'right',
    text: '{totalDue}', variables: ['totalDue'],
  }),

  // ── Notice ────────────────────────────────────────────────────────────────
  text('notice', {
    x: MARGIN, y: 244, w: CONTENT_W, h: 14, size: 7.5, color: MUTED, lineHeight: 1.4,
    readOnly: true,
    content: 'This statement summarises activity on your account for the period shown. '
      + 'It is not a tax invoice and raises no new charges. Every amount listed here appears on a '
      + 'tax invoice already issued to you. When making a payment, please quote the invoice number '
      + 'as the reference so it is applied correctly. If any entry looks wrong, contact us before '
      + 'paying and we will check it.',
  }),
]];

const template = {
  schemas,
  basePdf: {
    width: 210,
    height: 297,
    padding: [MARGIN, MARGIN, MARGIN, MARGIN],
    staticSchema: [{
      name: 'pageNumber',
      type: 'text',
      content: '{currentPage} / {totalPages}',
      position: { x: MARGIN, y: 283 },
      width: CONTENT_W,
      height: 5,
      fontName: 'Roboto',
      fontSize: 8,
      fontColor: MUTED,
      alignment: 'center',
      readOnly: true,
    }],
  },
  pdfmeVersion: '5.5.6',
};

const out = process.argv[2];
writeFileSync(out, `${JSON.stringify(template, null, 2)}\n`);
console.log(`wrote ${out}`);
