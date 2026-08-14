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
  const invoiceNumberBase =
    business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;
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
    workspaceId, boardId, masterItems, invoiceNumber, fileUrl, business,
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

async function persistGeneratedInvoice({
  workspaceId, boardId, masterItems, invoiceNumber, fileUrl, business,
}) {
  await Promise.all(masterItems.map((item) => saveInvoiceNumber(
    workspaceId, boardId, item.itemId, invoiceNumber, 'PDF', fileUrl,
  )));
  business.documentNumbering.invoice.nextNumber += 1;
  await business.save();
}
