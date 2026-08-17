import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';

import Business from '../../models/Business.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { formatLabelValue } from '../../utils/ndisServiceRecords.js';
import {
  getNdisInvoiceGeneratorContextFromMasterItems,
  prepareParticipantForInvoiceGenerator,
} from '../../utils/ndisInvoiceGeneratorInvoicing.js';
import { buildNdisInvoicePdfClientDetails } from '../../utils/ndisInvoiceGeneratorOutput.js';
import {
  collectNdisInvoiceRows,
  buildNdisInvoiceOrders,
  enrichInvoiceRows,
  ndisInvoicePdfFilename,
  resolveInvoiceTimezone,
  resolveDueDate,
  formatInvoiceMoney,
} from '../../utils/ndisInvoiceGeneratorPdfHelpers.js';
import { uploadFileToS3, getS3FileUrl } from '../../utils/uploadS3.js';
import {
  enableRepeatHeadOnTables,
  formatDateNumericAU,
  getLogoData,
  saveInvoiceNumber,
} from '../../utils/invoicePdfSupport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Claim the next invoice number for this workspace, atomically.
 *
 * What this replaces: read `documentNumbering.invoice.nextNumber`, render a
 * PDF, then write `nextNumber + 1` back. That is a read-modify-write straddling
 * several awaits, and production runs multiple Elastic Beanstalk instances all
 * pulling from one automation queue — so two boards generated at the same
 * moment both read 40, both mint 'IN-40 (ISO+™)' for different participants,
 * and the counter lands on 41 instead of 42. Two participants then hold one
 * invoice number, which the customer's ledger and Xero both read as a single
 * invoice.
 *
 * `$inc` inside findOneAndUpdate is a single atomic document operation, so
 * concurrent callers serialize on the server. `new: true` returns the document
 * as it now stands, which makes the claimed value unambiguous: the counter has
 * already moved past it, so the number this run owns is one below.
 *
 * Prefix and format are untouched — `prefix + number`, then ' (ISO+™)' at the
 * call site — because the characterization test pins both.
 *
 * The deliberate trade-off: the number is claimed BEFORE the rows are
 * collected, because collectNdisInvoiceRows stamps it onto every row it
 * builds. So a run that turns out to have no billable rows, or that fails
 * during render or upload, leaves a gap in the sequence. A gap is a cosmetic
 * accounting question; a duplicate is a billing-correctness bug. Rolling the
 * counter back would reintroduce the duplicate, since a concurrent run may
 * already hold the number below.
 */
async function allocateInvoiceNumberBase(workspaceId, business) {
  const claimed = await Business.findOneAndUpdate(
    { workspaceId: mongoEq(workspaceId) },
    { $inc: { 'documentNumbering.invoice.nextNumber': 1 } },
    { new: true },
  ).lean();
  const nextNumber = claimed.documentNumbering.invoice.nextNumber - 1;
  return business.documentNumbering.invoice.prefix + nextNumber;
}

export async function generateNdisInvoiceGeneratorPdf({
  workspaceId,
  boardId,
  masterItemIds,
  participantName: fallbackName,
  invoiceDate: invoiceDateInput,
  dueDate: dueDateInput,
}) {
  const business = await Business.findOne({ workspaceId: mongoEq(workspaceId) });
  if (!business) throw new Error('Business not found');

  const { masterItems, refItemsMap, participantProfileItem } =
    await getNdisInvoiceGeneratorContextFromMasterItems({
      workspaceId, boardId, masterItemIds,
    });

  const fallbackParticipantName = String(fallbackName || '').trim()
    || masterItems.map((m) => formatLabelValue(m?.data?.['Participant Full Name']).trim()).find(Boolean)
    || '';

  const prepared = await prepareParticipantForInvoiceGenerator({
    workspaceId,
    boardId,
    participantProfileItem,
    fallbackParticipantName,
  });
  const { participantProfile, participantName } = prepared;
  const profileItem = prepared.participantProfileItem;
  const timezone = resolveInvoiceTimezone(business);
  const invoiceNumberBase = await allocateInvoiceNumberBase(workspaceId, business);
  const invoiceNumber = `${invoiceNumberBase} (ISO+™)`;

  const allRows = await collectNdisInvoiceRows({
    masterItems,
    refItemsMap,
    participantName,
    profileItem,
    invoiceNumber,
    timezone,
    workspaceId,
    boardId,
  });
  if (allRows.length === 0) return { empty: true };

  const clientDetails = buildNdisInvoicePdfClientDetails({
    participantProfile,
    participantProfileItem: profileItem,
    fallbackParticipantName: participantName,
  });
  const invoiceDateRaw = invoiceDateInput || new Date().toISOString();
  const invoiceDate = invoiceDateRaw ? String(invoiceDateRaw).replace('Z', '') : '';
  const dueDate = resolveDueDate(invoiceDateRaw, dueDateInput);

  const fileUrl = await renderAndUploadNdisInvoice({
    business,
    workspaceId,
    boardId,
    invoiceNumberBase,
    participantName: participantName || participantProfile.displayName,
    clientDetails,
    invoiceDate,
    dueDate,
    timezone,
    enrichedRows: enrichInvoiceRows(allRows, masterItems, timezone),
  });

  await persistGeneratedInvoice({
    workspaceId, boardId, masterItems, invoiceNumber, fileUrl,
  });

  return {
    invoiceNumber,
    fileUrl,
    itemCount: masterItems.length,
    lineCount: allRows.length,
  };
}

async function renderAndUploadNdisInvoice({
  business, workspaceId, boardId, invoiceNumberBase, participantName,
  clientDetails, invoiceDate, dueDate, timezone, enrichedRows,
}) {
  const templatePath = path.join(__dirname, '..', '..', 'assets', 'NDISinvoice.json');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  enableRepeatHeadOnTables(template);

  const { ordersArr, subTotal } = buildNdisInvoiceOrders(enrichedRows, timezone);
  const gstTotal = formatInvoiceMoney(0);
  const total = formatInvoiceMoney(Number(subTotal) + Number(gstTotal));
  const pdfBytes = await generate({
    template,
    inputs: [{
      logo: await getLogoData(business),
      subtotal: subTotal,
      totalGST: gstTotal,
      total,
      clientDetails: JSON.stringify(clientDetails),
      invoiceDetails: JSON.stringify({
        Date: formatDateNumericAU(invoiceDate || null, timezone),
        'Invoice Number': invoiceNumberBase,
      }),
      companyName: JSON.stringify({ 'Company Name': business.name }),
      companyDetails: JSON.stringify({
        ABN: business.abn,
        'Street Address': business.address.street,
        Suburb: business.address.suburb,
        State: business.address.state,
        Postcode: business.address.postcode,
        Country: business.address.country,
      }),
      orders: JSON.stringify(ordersArr),
      dueDate: formatDateNumericAU(dueDate || null, timezone),
      'Bank Details': JSON.stringify({
        'Account Name': business.bankDetails.accountName,
        'Bank Name': business.bankDetails.bankName,
        BSB: business.bankDetails.bsb,
        'Account Number': business.bankDetails.accountNumber,
        'invoice Number': invoiceNumberBase,
      }),
    }],
    plugins: { text, image, line, table, multiVariableText },
  });

  const filename = ndisInvoicePdfFilename(
    workspaceId, boardId, invoiceNumberBase, participantName,
  );
  const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, true);
  if (uploadResult?.$metadata?.httpStatusCode !== 200) {
    throw new Error('Upload of PDF failed, please provide correct information.');
  }
  return getS3FileUrl(filename, 3600, true);
}

// No counter write here any more: the number was claimed atomically up front
// by allocateInvoiceNumberBase. Incrementing again would double-advance it.
async function persistGeneratedInvoice({
  workspaceId, boardId, masterItems, invoiceNumber, fileUrl,
}) {
  await Promise.all(masterItems.map((item) => saveInvoiceNumber(
    workspaceId, boardId, item.itemId, invoiceNumber, 'PDF', fileUrl,
  )));
}
