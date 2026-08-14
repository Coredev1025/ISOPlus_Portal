// Epic 5 part 3, first slice: the scheduled generation engine.
//
// The fan-out gives the worker one job per board per slot; this module turns
// that into real NDIS invoice PDFs. It reuses the exact template-input shape
// the webhook invoice path renders (webhookNdisPdfHandlers), but sources its
// lines from the billable values already stored on board items rather than
// the live master-plan reference walk — the webhook path's line source needs
// live ISO+, and the ticket explicitly excludes the fields ("Invoice scope",
// "Eligible billing items") that would define scheduled line selection
// properly. That contract lives in ONE place, findBillableItems, so when
// those fields arrive there is exactly one function to change.
//
// Idempotency: the artifact key is (board, item, periodKey) — no invoice
// number in the key — and generation is skipped when a PDFLink for that key
// already exists. That makes an at-least-once redelivery re-bill nothing and,
// critically, consume no second invoice number. Numbers are taken atomically
// via $inc so two concurrent workers cannot mint the same one.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';

import Business from '../../models/Business.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import { automationPeriodKey } from '../../utils/automationPeriodKey.js';
import { buildNdisQuotePdfOrders } from '../../utils/ndisQuoteLineHelpers.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { uploadFileToS3, getS3FileUrl } from '../../utils/uploadS3.js';
import {
  enableRepeatHeadOnTables,
  formatValue,
  formatDateNumericAU,
} from '../../routes/webhook.js';
import { info, warn } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The v1 billable-item contract: any item whose stored data yields at least
 * one quote-shaped line (a quantity + unit-price pair the shared line builder
 * recognises). Deliberately the same builder the quote PDF and Xero paths
 * use, so "what is a line" has one definition across the three features.
 */
export async function findBillableItems(boardId) {
  const items = await Item.find({ boardId: mongoEq(String(boardId)) }).lean();
  return items.filter((item) => {
    const { ordersArr } = buildNdisQuotePdfOrders(item.data ?? {}, [], formatValue);
    return ordersArr.length > 0;
  });
}

function artifactKey(workspaceId, boardId, itemId, periodKey) {
  return `output/${workspaceId}/${boardId}/NDIS-invoices/auto/${itemId}-${periodKey}.pdf`;
}

/** Atomically claim the next invoice number; returns the formatted number. */
async function claimInvoiceNumber(workspaceId) {
  const before = await Business.findOneAndUpdate(
    { workspaceId: mongoEq(String(workspaceId)) },
    { $inc: { 'documentNumbering.invoice.nextNumber': 1 } },
    { new: false },
  ).lean();
  if (!before?.documentNumbering?.invoice) {
    throw new Error(`No invoice numbering configured for workspace ${workspaceId}`);
  }
  const { prefix, nextNumber } = before.documentNumbering.invoice;
  return `${prefix}${nextNumber}`;
}

async function renderInvoicePdf({ business, item, invoiceNumber, slot, timezone }) {
  const templatePath = path.join(__dirname, '..', '..', 'assets', 'NDISinvoice.json');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  enableRepeatHeadOnTables(template);

  const values = item.data ?? {};
  // The invoice table has one more column than the quote's: a leading service
  // Date. The shared builder emits quote-shaped rows; prepend the slot date.
  const serviceDate = formatDateNumericAU(slot.toISOString(), timezone);
  const { ordersArr: quoteRows, subTotal: subTotalRaw } = buildNdisQuotePdfOrders(values, [], formatValue);
  const ordersArr = quoteRows.map((row) => [serviceDate, ...row]);
  const subTotal = formatValue(subTotalRaw);
  // GST-free, like every NDIS line the webhook path renders. A GST'd
  // scheduled invoice needs the excluded ticket fields to say so per line.
  const gstTotal = formatValue(0);
  const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

  const pdfBytes = await generate({
    template,
    inputs: [{
      logo: '',
      subtotal: subTotal,
      totalGST: gstTotal,
      total,
      clientDetails: JSON.stringify({
        Client: values['Recipient of the Quote'] || values.Participant || ' ',
        Address: values['Recipient Address'] || ' ',
        Suburb: values.Suburb || ' ',
        State: values.State || ' ',
        Postcode: values.Postcode != null ? String(values.Postcode) : ' ',
      }),
      invoiceDetails: JSON.stringify({
        Date: formatDateNumericAU(slot.toISOString(), timezone),
        'Invoice Number': invoiceNumber,
      }),
      companyName: JSON.stringify({ 'Company Name': business.name }),
      companyDetails: JSON.stringify({
        ABN: business.abn,
        'Street Address': business.address?.street,
        Suburb: business.address?.suburb,
        State: business.address?.state,
        Postcode: business.address?.postcode,
        Country: business.address?.country,
      }),
      orders: JSON.stringify(ordersArr),
      dueDate: formatDateNumericAU(slot.toISOString(), timezone),
      'Bank Details': JSON.stringify({
        'Account Name': business.bankDetails?.accountName,
        'Bank Name': business.bankDetails?.bankName,
        BSB: business.bankDetails?.bsb,
        'Account Number': business.bankDetails?.accountNumber,
        'invoice Number': invoiceNumber,
      }),
    }],
    plugins: { text, image, line, table, multiVariableText },
  });

  return Buffer.from(pdfBytes);
}

/**
 * Generate one NDIS invoice per billable item on the board for the claimed
 * slot. Returns one {itemId, invoiceNumber, pdfUrl} per document generated;
 * items already generated for this slot are skipped silently — that is the
 * redelivery case working, not an error.
 */
export async function generateInvoicesForBoard({ workspaceId, boardId, slot, timezone, periodKey: periodKeyOverride }) {
  const business = await Business.findOne({ workspaceId: mongoEq(String(workspaceId)) }).lean();
  if (!business) {
    warn('Automation', 'No business for workspace; nothing generated', { workspaceId, boardId });
    return [];
  }

  // The worker passes the jobId's own periodKey so artifact keys can never
  // disagree with queue identity; direct callers let it derive from the slot.
  const periodKey = periodKeyOverride ?? automationPeriodKey({ slot, timezone });
  const items = await findBillableItems(boardId);
  const results = [];

  for (const item of items) {
    const key = artifactKey(workspaceId, boardId, item.itemId, periodKey);
    const already = await PDFLink.findOne({
      workspaceId: mongoEq(String(workspaceId)),
      itemId: mongoEq(String(item.itemId)),
      pdfLink: { $regex: `${item.itemId}-${periodKey}\\.pdf$` },
    }).lean();
    if (already) continue;

    const invoiceNumber = await claimInvoiceNumber(workspaceId);
    const pdf = await renderInvoicePdf({ business, item, invoiceNumber, slot, timezone });

    const uploadResult = await uploadFileToS3(pdf, key, true);
    if (uploadResult['$metadata'].httpStatusCode !== 200) {
      throw new Error(`Upload of scheduled invoice failed for item ${item.itemId}`);
    }
    const pdfUrl = await getS3FileUrl(key, 3600, true);

    await PDFLink.insertOne({
      workspaceId, itemId: item.itemId, type: 'NDIS Invoice',
      pdfLink: pdfUrl, createdBy: '', isDeleted: false, SignatureStatus: 'Unsigned',
    });

    info('Automation', 'Scheduled invoice generated', {
      workspaceId, boardId, itemId: item.itemId, invoiceNumber, periodKey,
    });
    results.push({ itemId: item.itemId, invoiceNumber, pdfUrl });
  }

  return results;
}
