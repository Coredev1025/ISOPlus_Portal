import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';
import {
  validateItemBelongsToTenant,
  setIntegrationMessage,
  setGeneratedField,
  getQuoteNDISReferencedItems,
  getNDISMasterPlanReferencedItems,
} from '../services/isoplus.js';
import { fetchParticipantProfileItemForMasterPlan } from '../utils/ndisInvoiceGeneratorInvoicing.js';
import { buildNdisInvoicePdfClientDetails } from '../utils/ndisInvoiceGeneratorOutput.js';
import {
  buildNdisMasterPlanInvoiceLines,
  computeNdisServiceDate,
  ndisLinesToPdfOrders,
  sumNdisLineAmounts,
} from '../utils/ndisMasterPlanLineHelpers.js';
import { buildNdisQuotePdfOrders } from '../utils/ndisQuoteLineHelpers.js';
import {
  GENERATED_DOCUMENT_PUBLIC_READ,
  GENERATED_PDF_URL_EXPIRY_SECONDS,
  OUTPUT_TYPE,
} from '../constants/storage.js';
import { buildOutputKey } from '../utils/s3OutputKey.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function processWebhookNdisQuotePdfItem({
  req,
  res,
  workspaceId,
  boardId,
  business,
  item,
  getLogoData,
  enableRepeatHeadOnTables,
  formatValue,
  formatDateNumericAU,
  isEmpty,
  uploadFileToS3,
  getS3FileUrl,
  handlePDFSuccess,
  handlePDFError,
  saveInvoiceNumber,
}) {
  try {
    await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    await setIntegrationMessage(workspaceId, boardId, item.id, 'Running...');

    const refs = await getQuoteNDISReferencedItems(workspaceId, boardId, item.id);
    const [serviceAreaValues] = refs;
    if (!serviceAreaValues) throw new Error('Service Area value is required.');

    const templatePath = path.join(__dirname, '..', 'assets', 'NDISquote.json');
    const template = JSON.parse(await fs.readFile(templatePath, 'utf8'));
    enableRepeatHeadOnTables(template);

    const logoBase64 = await getLogoData(business);
    const quoteNumber = business.documentNumbering.quote.prefix + business.documentNumbering.quote.nextNumber;
    const NDISQuoteValues = item.values;
    const gst = '0%';
    const issueDate = NDISQuoteValues['Issue Date'] ? NDISQuoteValues['Issue Date'].replace('Z', '') : '';
    const expiryDate = NDISQuoteValues['Expiry Date'] ? NDISQuoteValues['Expiry Date'].replace('Z', '') : '';
    const fromDate = NDISQuoteValues['From Date'] ? NDISQuoteValues['From Date'].replace('Z', '') : '';
    const toDate = NDISQuoteValues['To Date'] ? NDISQuoteValues['To Date'].replace('Z', '') : '';
    const daysOfWeek = Array.isArray(NDISQuoteValues['Days of the Week']) && NDISQuoteValues['Days of the Week'].length > 0
      ? NDISQuoteValues['Days of the Week'].join(', ')
      : ' ';

    const { ordersArr, subTotal: subTotalRaw } = buildNdisQuotePdfOrders(NDISQuoteValues, refs.slice(1), formatValue);
    const subTotal = formatValue(subTotalRaw);
    const gstTotal = formatValue((parseFloat(subTotal) * parseFloat(gst)) / 100);
    const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

    const clientDetails = {
      Address: NDISQuoteValues['Recipient Address'] || ' ',
      Suburb: NDISQuoteValues.Suburb || ' ',
      State: NDISQuoteValues.State || ' ',
      Postcode: NDISQuoteValues.Postcode || ' ',
      Client: NDISQuoteValues['Recipient of the Quote'] || ' ',
    };

    const pdfBytes = await generate({
      template,
      inputs: [{
        logo: logoBase64,
        subtotal: subTotal,
        totalGST: gstTotal,
        total,
        clientDetails: JSON.stringify(clientDetails),
        quoteDetails: JSON.stringify({
          'Issue Date': formatDateNumericAU(issueDate || null, business?.headOfficeTimezone),
          'expiry Date': formatDateNumericAU(expiryDate || null, business?.headOfficeTimezone),
          'Quote Number': quoteNumber,
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
        termsInputs: JSON.stringify({
          'Accounts Receivable Payment Terms': `${business.bankDetails.accountsReceivableTerms ? business.bankDetails.accountsReceivableTerms : ' '}`,
        }),
        field17: JSON.stringify({
          'From Date': formatDateNumericAU(fromDate || null, business?.headOfficeTimezone),
          'To Date': formatDateNumericAU(toDate || null, business?.headOfficeTimezone),
          'Days of the week': daysOfWeek,
        }),
      }],
      plugins: { text, image, line, table, multiVariableText },
    });

    const filename = buildOutputKey({
      workspaceId,
      boardId,
      type: OUTPUT_TYPE.NDIS_QUOTE,
      name: `${quoteNumber}-ISO+™-${item.id}.pdf`,
    });
    const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, GENERATED_DOCUMENT_PUBLIC_READ);
    if (uploadResult['$metadata'].httpStatusCode !== 200) {
      throw new Error('Upload of PDF failed, please provide correct information.');
    }

    const fileUrl = await getS3FileUrl(filename, GENERATED_PDF_URL_EXPIRY_SECONDS, GENERATED_DOCUMENT_PUBLIC_READ);
    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'NDIS Quote', req, res);
    await setGeneratedField(workspaceId, boardId, item.id, `${quoteNumber} (ISO+™)`);
    business.documentNumbering.quote.nextNumber += 1;
    await business.save();
  } catch (err) {
    await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF NDIS Quote', req, res);
  }
}

export async function processWebhookNdisInvoicePdfItem({
  req,
  res,
  workspaceId,
  boardId,
  business,
  item,
  getLogoData,
  enableRepeatHeadOnTables,
  formatValue,
  formatDateNumericAU,
  uploadFileToS3,
  getS3FileUrl,
  handlePDFSuccess,
  handlePDFError,
  saveInvoiceNumber,
}) {
  try {
    await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    await setIntegrationMessage(workspaceId, boardId, item.id, 'Running...');

    const [servicePlanValues, cancellationTypeValues, , participantProfileValues] =
      await getNDISMasterPlanReferencedItems(workspaceId, boardId, item.id);
    if (!participantProfileValues || !servicePlanValues) {
      throw new Error('Participant Profile and Service Plan information is required.');
    }

    const templatePath = path.join(__dirname, '..', 'assets', 'NDISinvoice.json');
    const template = JSON.parse(await fs.readFile(templatePath, 'utf8'));
    enableRepeatHeadOnTables(template);

    const logoBase64 = await getLogoData(business);
    const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;
    const invoiceValues = item.values;
    const invoiceDate = invoiceValues['Invoice Date'] ? invoiceValues['Invoice Date'].replace('Z', '') : '';
    const dueDate = invoiceValues['Due Date'] ? invoiceValues['Due Date'].replace('Z', '') : '';
    const tz = business?.headOfficeTimezone || 'Australia/Sydney';
    const serviceDate = computeNdisServiceDate(invoiceValues, tz);
    const groupSize = Number(invoiceValues['Group Size']) || 1;
    const gst = '0%';
    const gstLabel = 'GST Free';

    const lineCtx = {
      workspaceId,
      boardId,
      itemId: item.id,
      servicePlanValues,
      cancellationTypeValues,
      invoiceValues,
      groupSize,
      timezone: tz,
      setIntegrationMessage,
      awaitIntegrationMessage: false,
    };
    const ndisLines = await buildNdisMasterPlanInvoiceLines(lineCtx);
    if (ndisLines.length === 0) {
      await setIntegrationMessage(workspaceId, boardId, item.id, 'There is nothing to invoice!');
      return res.status(200).json({ message: 'There is nothing to invoice!' });
    }

    const ordersArr = ndisLinesToPdfOrders(ndisLines, { gstLabel, serviceDate, formatValue });
    let subTotal = sumNdisLineAmounts(ndisLines);
    const orders = JSON.stringify(ordersArr);
    subTotal = formatValue(subTotal);
    const gstTotal = formatValue((parseFloat(subTotal) * parseFloat(gst)) / 100);
    const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

    const participantProfileItemForPdf = await fetchParticipantProfileItemForMasterPlan(workspaceId, boardId, item.id);
    const clientDetails = buildNdisInvoicePdfClientDetails({
      participantProfileItem: participantProfileItemForPdf,
      apiProfileValues: participantProfileValues,
      fallbackParticipantName: participantProfileValues?.fullName || '',
    });

    const pdfBytes = await generate({
      template,
      inputs: [{
        logo: logoBase64,
        subtotal: subTotal,
        totalGST: gstTotal,
        total,
        clientDetails: JSON.stringify(clientDetails),
        invoiceDetails: JSON.stringify({
          Date: formatDateNumericAU(invoiceDate || null, business?.headOfficeTimezone),
          'Invoice Number': invoiceNumber,
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
        orders,
        dueDate: formatDateNumericAU(dueDate || null, business?.headOfficeTimezone),
        'Bank Details': JSON.stringify({
          'Account Name': business.bankDetails.accountName,
          'Bank Name': business.bankDetails.bankName,
          BSB: business.bankDetails.bsb,
          'Account Number': business.bankDetails.accountNumber,
          'invoice Number': invoiceNumber,
        }),
      }],
      plugins: { text, image, line, table, multiVariableText },
    });

    const filename = buildOutputKey({
      workspaceId,
      boardId,
      type: OUTPUT_TYPE.NDIS_INVOICE,
      name: `${invoiceNumber}-ISO+™-${item.id}.pdf`,
    });
    const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, GENERATED_DOCUMENT_PUBLIC_READ);
    if (uploadResult['$metadata'].httpStatusCode !== 200) {
      throw new Error('Upload of PDF failed, please provide correct information.');
    }

    const fileUrl = await getS3FileUrl(filename, GENERATED_PDF_URL_EXPIRY_SECONDS, GENERATED_DOCUMENT_PUBLIC_READ);
    // The details the statement of account matches on. Until they travelled
    // with the success call, an invoice raised by hand wrote a document row
    // carrying none of them, and the statement — which looks invoices up by
    // board and participant and charges `invoiceTotal` — could not see it. On
    // one dev workspace that was 170 of 175 invoice rows, a year of history
    // absent from every statement. `invoiceDate` is the operator's own
    // `Invoice Date` on the item, so a backdated invoice is reported in the
    // month it claims rather than on the day it happened to be generated.
    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'NDIS Invoice', req, res, {
      participant: clientDetails['Participant Name'] || '',
      invoiceNumber: `${invoiceNumber} (ISO+™)`,
      invoiceTotal: Number(total),
      invoiceDate,
    });
    await setGeneratedField(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`);
    await saveInvoiceNumber(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`, 'PDF', fileUrl);
    business.documentNumbering.invoice.nextNumber += 1;
    await business.save();
  } catch (err) {
    await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF NDIS Invoice', req, res);
  }
}
