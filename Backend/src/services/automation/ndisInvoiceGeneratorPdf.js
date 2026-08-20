import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';

import Business from '../../models/Business.js';
import { claimDocumentNumber } from '../../utils/documentNumberAllocator.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { formatLabelValue } from '../../utils/ndisServiceRecords.js';
import {
  getNdisInvoiceGeneratorContextFromMasterItems,
  prepareParticipantForInvoiceGenerator,
} from '../../utils/ndisInvoiceGeneratorInvoicing.js';
import {
  buildMasterItemsMap,
  buildNdisInvoicePdfClientDetails,
  enrichNdisInvoiceGeneratorRows,
} from '../../utils/ndisInvoiceGeneratorOutput.js';
import {
  collectNdisInvoiceRows,
  buildNdisInvoiceOrders,
  ndisInvoicePdfFilename,
  resolveDueDate,
  formatInvoiceMoney,
} from '../../utils/ndisInvoiceGeneratorPdfHelpers.js';
import { uploadFileToS3, getS3FileUrl } from '../../utils/uploadS3.js';
import {
  GENERATED_DOCUMENT_PUBLIC_READ,
  GENERATED_PDF_URL_EXPIRY_SECONDS,
} from '../../constants/storage.js';
import {
  enableRepeatHeadOnTables,
  formatDateNumericAU,
  getLogoData,
  saveInvoiceNumber,
} from '../../utils/invoicePdfSupport.js';
import { DEFAULT_TIMEZONE } from '../../constants/scheduler.js';
import { invoicePeriodSuffix } from '../../utils/invoicePeriodSuffix.js';
import { isMissingPaymentDetails, missingDocumentBranding } from '../../utils/businessDocumentReadiness.js';
import { warn } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Claim the next invoice number for this workspace, atomically.
 *
 * The claim itself lives in utils/documentNumberAllocator.js — one
 * implementation shared with the statement generator and the Age Care
 * participant tax invoice, because there were three and one of them read the
 * counter, rendered a PDF, and only then wrote it back.
 *
 * The number is claimed before the rows are collected, so a run that fails
 * leaves a gap in the sequence. A gap is cosmetic; a duplicate is a billing bug.
 */
async function allocateInvoiceNumberBase(workspaceId) {
  const claimed = await claimDocumentNumber(workspaceId, 'invoice');
  if (!claimed) throw new Error('Business not found');
  return claimed;
}

export async function generateNdisInvoiceGeneratorPdf({
  workspaceId,
  boardId,
  masterItemIds,
  participantName: fallbackName,
  invoiceDate: invoiceDateInput,
  dueDate: dueDateInput,
  period = null,
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
  const timezone = business?.headOfficeTimezone || DEFAULT_TIMEZONE;
  const invoiceNumberBase = await allocateInvoiceNumberBase(workspaceId);
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

  // Not a refusal. The document is correct in every other respect, and
  // refusing to invoice over a missing logo would be worse than the blank
  // corner. But an invoice with no bank details cannot be paid, and until now
  // the only signal was somebody noticing the empty space after it had reached
  // a client.
  const missingBranding = missingDocumentBranding(business);
  if (missingBranding.length > 0) {
    warn('Automation', 'Generating an invoice with branding missing from the business profile', {
      workspaceId,
      boardId,
      missing: missingBranding,
      unpayable: isMissingPaymentDetails(business),
    });
  }

  const { fileUrl, invoiceTotal } = await renderAndUploadNdisInvoice({
    business,
    workspaceId,
    boardId,
    invoiceNumberBase,
    participantName: participantName || participantProfile.displayName,
    clientDetails,
    invoiceDate,
    dueDate,
    timezone,
    enrichedRows: enrichNdisInvoiceGeneratorRows(
      allRows, buildMasterItemsMap(masterItems), timezone,
    ),
    periodSuffix: invoicePeriodSuffix(period, timezone),
  });

  await persistGeneratedInvoice({
    workspaceId, boardId, masterItems, invoiceNumber, fileUrl,
  });

  return {
    invoiceNumber,
    fileUrl,
    invoiceTotal,
    itemCount: masterItems.length,
    lineCount: allRows.length,
  };
}

async function renderAndUploadNdisInvoice({
  business, workspaceId, boardId, invoiceNumberBase, participantName,
  clientDetails, invoiceDate, dueDate, timezone, enrichedRows, periodSuffix = '',
}) {
  const templatePath = path.join(__dirname, '..', '..', 'assets', 'NDISinvoice.json');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  enableRepeatHeadOnTables(template);

  const { ordersArr, subTotal } = buildNdisInvoiceOrders(enrichedRows, timezone);
  const gstTotal = formatInvoiceMoney(0);
  // Kept as a number as well as the formatted string: the statement of account
  // carries the figure the invoice billed through unchanged rather than
  // recomputing it from the source items.
  const invoiceTotal = Number(subTotal) + Number(gstTotal);
  const total = formatInvoiceMoney(invoiceTotal);
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
    workspaceId, boardId, invoiceNumberBase, participantName, periodSuffix,
  );
  const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, GENERATED_DOCUMENT_PUBLIC_READ);
  if (uploadResult?.$metadata?.httpStatusCode !== 200) {
    throw new Error('Upload of PDF failed, please provide correct information.');
  }
  return {
    fileUrl: await getS3FileUrl(filename, GENERATED_PDF_URL_EXPIRY_SECONDS, GENERATED_DOCUMENT_PUBLIC_READ),
    invoiceTotal,
  };
}

async function persistGeneratedInvoice({
  workspaceId, boardId, masterItems, invoiceNumber, fileUrl,
}) {
  await Promise.all(masterItems.map((item) => saveInvoiceNumber(
    workspaceId, boardId, item.itemId, invoiceNumber, 'PDF', fileUrl,
  )));
}
