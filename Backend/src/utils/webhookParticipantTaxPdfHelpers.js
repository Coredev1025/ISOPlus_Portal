import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import {
  validateItemBelongsToTenant,
  setIntegrationMessage,
  setGeneratedField,
} from '../services/isoplus.js';
import { logAuditTrail } from '../utils/auditLogger.js';
import { claimDocumentNumber } from '../utils/documentNumberAllocator.js';
import { extractRefId as extractNdisRefId } from '../utils/ndisServiceRecords.js';
import { mongoEq } from '../utils/securityHelpers.js';
import {
  GENERATED_DOCUMENT_PUBLIC_READ,
  GENERATED_PDF_URL_EXPIRY_SECONDS,
  OUTPUT_TYPE,
} from '../constants/storage.js';
import { buildOutputKey } from './s3OutputKey.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function resolveLowCatBoardFlag(req, boardId) {
  const isLowCat = req.body?.isLowCat || false;
  if (isLowCat) return true;
  const board = await Board.findOne({ boardId: mongoEq(boardId) }).lean();
  return board?.label === 'Care Management - SaH - Low Cat';
}

export async function fetchValidatedDbItems(workspaceId, boardId, itemIds) {
  const dbItems = [];
  for (const itemId of itemIds) {
    await validateItemBelongsToTenant(workspaceId, boardId, itemId);
    const dbItem = await Item.findOne({
      workspaceId: mongoEq(workspaceId),
      boardId: mongoEq(boardId),
      itemId: mongoEq(itemId),
    }).lean();
    if (!dbItem) throw new Error(`Item ${itemId} not found`);
    dbItems.push(dbItem);
  }
  return dbItems;
}

export function collectParticipantTaxReferenceIds(dbItems, getValueFromFlatData, attributeNames) {
  const participantProfileIds = new Set();
  const servicePlanIds = new Set();
  for (const dbItem of dbItems) {
    const getValue = (attributeName) => getValueFromFlatData(dbItem, attributeName);
    const participantProfileId = extractNdisRefId(getValue(attributeNames.PARTICIPANT_PROFILE));
    if (participantProfileId) participantProfileIds.add(participantProfileId);
    const servicePlanId = extractNdisRefId(getValue(attributeNames.SERVICE_PLAN));
    if (servicePlanId) servicePlanIds.add(servicePlanId);
  }
  return { participantProfileIds, servicePlanIds };
}

export function resolveParticipantTaxReceiverDetails(dbItems, refItemsMap, helpers) {
  const {
    getValueFromFlatData,
    attributeNames,
    refAttributeNames,
    getParticipantNameFromProfile,
  } = helpers;

  let participantName = ' ';
  let receiverName = ' ';
  let receiverAddress = ' ';
  if (dbItems.length === 0) {
    return { participantName, receiverName, receiverAddress };
  }

  const firstItem = dbItems[0];
  const getValue = (attributeName) => getValueFromFlatData(firstItem, attributeName);
  const participantProfileId = extractNdisRefId(getValue(attributeNames.PARTICIPANT_PROFILE));
  if (!participantProfileId) {
    return { participantName, receiverName, receiverAddress };
  }

  const participantProfileItem = refItemsMap.get(participantProfileId);
  if (!participantProfileItem) {
    return { participantName, receiverName, receiverAddress };
  }

  participantName = getParticipantNameFromProfile(participantProfileItem) || ' ';
  receiverName = getValueFromFlatData(participantProfileItem, refAttributeNames.PROFILE_BILLING_CONTACT) || ' ';
  const billingAddressBase = getValueFromFlatData(participantProfileItem, refAttributeNames.PROFILE_BILLING_ADDRESS) || ' ';
  receiverAddress = billingAddressBase.trim() || ' ';
  return { participantName, receiverName, receiverAddress };
}

function resolveParticipantTaxRowDate(dbItem, helpers) {
  const { getValueFromFlatData, attributeNames, dateFmt } = helpers;
  const getValue = (attributeName) => getValueFromFlatData(dbItem, attributeName);
  const transactionStatus = helpers.formatLabelValue(getValue(attributeNames.TRANSACTION_STATUS));
  const isDelivered = transactionStatus === 'Delivered - To be claimed and invoiced.';
  if (isDelivered) {
    const actualEnd = getValue(attributeNames.ACTUAL_END);
    return actualEnd ? dateFmt(actualEnd) : ' ';
  }
  const scheduledStart = getValue(attributeNames.SCHEDULED_START);
  return scheduledStart ? dateFmt(scheduledStart) : ' ';
}

function resolveParticipantTaxDescription(dbItem, refItemsMap, helpers) {
  const { getValueFromFlatData, attributeNames, getServiceFromServicePlan } = helpers;
  const getValue = (attributeName) => getValueFromFlatData(dbItem, attributeName);
  const servicePlanId = extractNdisRefId(getValue(attributeNames.SERVICE_PLAN));
  if (servicePlanId) {
    const servicePlanItem = refItemsMap.get(servicePlanId);
    const description = getServiceFromServicePlan(servicePlanItem) || '';
    if (description) return description;
  }
  return 'Service';
}

function appendAdjustmentNotes(description, dbItem, transactionStatus, helpers) {
  const isAdjustment = transactionStatus === 'Adjustment (Charge) - To be claimed and invoiced.' ||
    transactionStatus === 'Adjustment (Refund) - To be claimed and invoiced.';
  if (!isAdjustment) return description;

  const notes = helpers.getValueFromFlatData(dbItem, helpers.attributeNames.ADDITIONAL_NOTES);
  if (!notes) return description;
  const cleanNotes = (typeof notes === 'string') ? notes.replace(/<[^>]*>/g, '').trim() : '';
  return cleanNotes ? `${description} - ${cleanNotes}` : description;
}

export function buildParticipantTaxOrders(dbItems, ctx) {
  const ordersArr = [];
  let totalParticipantContribution = 0;
  let totalAmountSum = 0;
  const gstLabel = 'GST Free';

  for (const dbItem of dbItems) {
    const getValue = (attributeName) => ctx.getValueFromFlatData(dbItem, attributeName);
    const transactionStatus = ctx.formatLabelValue(getValue(ctx.attributeNames.TRANSACTION_STATUS));
    const rowDate = resolveParticipantTaxRowDate(dbItem, ctx);
    let description = resolveParticipantTaxDescription(dbItem, ctx.refItemsMap, ctx);
    description = appendAdjustmentNotes(description, dbItem, transactionStatus, ctx);

    const unit = getValue(ctx.attributeNames.UNIT) || ' ';
    const quantity = Number(getValue(ctx.attributeNames.QUANTITY)) || 0;
    const unitPrice = Number(getValue(ctx.attributeNames.UNIT_PRICE)) || 0;
    const totalAmount = Number(getValue(ctx.attributeNames.TOTAL_AMOUNT)) || 0;
    const participantContribution = Number(getValue(ctx.attributeNames.PARTICIPANT_CONTRIBUTION)) || 0;

    let rowParticipantName = ctx.participantName;
    if (ctx.isLowCatBoard) {
      const itemParticipantProfileId = extractNdisRefId(getValue(ctx.attributeNames.PARTICIPANT_PROFILE));
      if (itemParticipantProfileId) {
        const itemParticipantProfileItem = ctx.refItemsMap.get(itemParticipantProfileId);
        if (itemParticipantProfileItem) {
          rowParticipantName = ctx.getParticipantNameFromProfile(itemParticipantProfileItem) || ctx.participantName;
        }
      }
      ordersArr.push([
        rowParticipantName,
        rowDate,
        description,
        unit,
        ctx.fmt(quantity),
        ctx.formatCurrencyValue(unitPrice),
        gstLabel,
        ctx.formatCurrencyValue(totalAmount),
      ]);
      totalAmountSum += totalAmount;
      continue;
    }

    ordersArr.push([
      rowDate,
      description,
      unit,
      ctx.fmt(quantity),
      ctx.formatCurrencyValue(unitPrice),
      gstLabel,
      ctx.formatCurrencyValue(totalAmount),
      ctx.formatCurrencyValue(participantContribution),
    ]);
    totalParticipantContribution += participantContribution;
  }

  return { ordersArr, totalParticipantContribution, totalAmountSum };
}

/**
 * Claimed atomically, and claimed BEFORE the render, the upload and the
 * write-back to ISO+. This used to read the counter off the passed-in
 * `business`, run all of that, then increment and save; two generations
 * overlapping anywhere across those awaits both read the same number and both
 * put it on an invoice. Same allocator the NDIS and statement generators use.
 *
 * A run that fails after this leaves a gap in the sequence. That is the trade:
 * a gap is cosmetic, a duplicate invoice number is a billing bug a client sees.
 *
 * Its own function so the guard does not add a branch to
 * generateParticipantTaxInvoicePdf, which is already over the cognitive
 * complexity gate.
 */
async function claimInvoiceNumber(workspaceId) {
  const invoiceNumber = await claimDocumentNumber(workspaceId, 'invoice');
  if (!invoiceNumber) {
    throw new Error(`Business not found for workspace ${workspaceId}; cannot number an invoice`);
  }
  return invoiceNumber;
}

export async function generateParticipantTaxInvoicePdf({
  req,
  res,
  workspaceId,
  boardId,
  business,
  dbItems,
  isLowCatBoard,
  getLogoData,
  enableRepeatHeadOnTables,
  bulkFetchReferenceItemsFromDB,
  getValueFromFlatData,
  attributeNames,
  refAttributeNames,
  getParticipantNameFromProfile,
  getServiceFromServicePlan,
  formatLabelValue,
  formatValue,
  formatCurrencyValue,
  uploadFileToS3,
  getS3FileUrl,
  saveInvoiceNumber,
  info,
  error,
}) {
  const templatePath = isLowCatBoard
    ? path.join(__dirname, '..', 'assets', 'taxInvoiceAG.json')
    : path.join(__dirname, '..', 'assets', 'participantTaxInvoiceAG.json');
  const template = JSON.parse(await fs.readFile(templatePath, 'utf8'));
  enableRepeatHeadOnTables(template);

  const logoBase64 = await getLogoData(business);
  const invoiceNumber = await claimInvoiceNumber(workspaceId);
  let invoiceDate = req.body?.invoiceDate || new Date().toISOString();
  let dueDate = req.body?.dueDate || '';
  if (!dueDate) {
    const d = new Date(invoiceDate);
    d.setDate(d.getDate() + 14);
    dueDate = d.toISOString();
  }

  const dateFmt = (d) => (d
    ? new Date(d).toLocaleString('en-AU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      timeZone: business?.headOfficeTimezone || 'Australia/Sydney',
    })
    : '');
  const toNumber = (v) => (typeof v === 'number' ? v : Number(v || 0));
  const fmt = (v) => formatValue(toNumber(v));

  const { participantProfileIds, servicePlanIds } =
    collectParticipantTaxReferenceIds(dbItems, getValueFromFlatData, attributeNames);
  const refItemsMap = await bulkFetchReferenceItemsFromDB(
    workspaceId,
    boardId,
    [...participantProfileIds, ...servicePlanIds],
  );

  info('Webhook-Service', 'Bulk fetched reference items from DB', {
    participantProfiles: participantProfileIds.size,
    servicePlans: servicePlanIds.size,
    foundItems: refItemsMap.size,
  }, req ?? null);

  const { participantName, receiverName, receiverAddress } = resolveParticipantTaxReceiverDetails(dbItems, refItemsMap, {
    getValueFromFlatData,
    attributeNames,
    refAttributeNames,
    getParticipantNameFromProfile,
  });

  const { ordersArr, totalParticipantContribution, totalAmountSum } = buildParticipantTaxOrders(dbItems, {
    getValueFromFlatData,
    attributeNames,
    refAttributeNames,
    refItemsMap,
    isLowCatBoard,
    participantName,
    formatLabelValue,
    getParticipantNameFromProfile,
    getServiceFromServicePlan,
    dateFmt,
    fmt,
    formatCurrencyValue,
  });

  if (ordersArr.length === 0) {
    await Promise.all(dbItems.map((item) =>
      setIntegrationMessage(workspaceId, boardId, item.itemId, 'There is nothing to invoice!'),
    ));
    return res.status(400).json({ message: 'There is nothing to invoice!' });
  }

  // Low Cat bills the full service amount; every other Age Care board bills
  // only the participant's contribution. Kept as a number alongside the
  // formatted string because the statement of account has to carry the figure
  // the invoice billed through unchanged rather than recompute it — and
  // recomputing would mean replicating this branch in a second place.
  const invoiceTotalRaw = isLowCatBoard ? totalAmountSum : totalParticipantContribution;
  const subtotalValue = formatCurrencyValue(invoiceTotalRaw);
  const totalAUDValue = subtotalValue;

  const billingContact = (receiverName && receiverName.trim() !== '' && receiverName.trim() !== ' ')
    ? receiverName.trim()
    : ((participantName && participantName.trim() !== '' && participantName.trim() !== ' ')
      ? participantName.trim()
      : ' ');
  const billingAddress = (receiverAddress && receiverAddress.trim() !== '' && receiverAddress.trim() !== ' ')
    ? receiverAddress.trim()
    : ' ';

  const pdfBytes = await generate({
    template,
    inputs: [{
      logo: logoBase64,
      subtotal: subtotalValue,
      totalGST: formatCurrencyValue(0),
      total: totalAUDValue,
      clientDetails: JSON.stringify({
        'Billing Contact': billingContact,
        'Billing Address': billingAddress,
      }),
      invoiceDetails: JSON.stringify({
        Date: new Date(invoiceDate).toLocaleString('en-AU', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          timeZone: business?.headOfficeTimezone || 'Australia/Sydney',
        }),
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
      orders: ordersArr,
      dueDate: new Date(dueDate).toLocaleString('en-AU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        timeZone: business?.headOfficeTimezone || 'Australia/Sydney',
      }),
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
    type: OUTPUT_TYPE.PARTICIPANT_INVOICE,
    name: `${invoiceNumber + '-ISO+™-' + participantName.replace(/\s+/g, '-')}.pdf`,
  });
  const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, GENERATED_DOCUMENT_PUBLIC_READ);
  if (uploadResult['$metadata'].httpStatusCode !== 200) {
    throw new Error('Upload of PDF failed, please provide correct information.');
  }

  const fileUrl = await getS3FileUrl(filename, GENERATED_PDF_URL_EXPIRY_SECONDS, GENERATED_DOCUMENT_PUBLIC_READ);
  await Promise.all(dbItems.map(async (item) => {
    await setIntegrationMessage(workspaceId, boardId, item.itemId, 'Invoice generated successfully');
    await setGeneratedField(workspaceId, boardId, item.itemId, `${invoiceNumber} (ISO+™)`);
    await saveInvoiceNumber(workspaceId, boardId, item.itemId, `${invoiceNumber} (ISO+™)`, 'PDF', fileUrl);
  }));

  logAuditTrail({
    workspaceId,
    action: 'Generate PDF Participant Tax Invoice',
    detail: `Invoice generated successfully, invoice number: ${invoiceNumber} (ISO+™), participant: ${participantName}, items: ${dbItems.length}, fileUrl: ${fileUrl}`,
    req,
  });

  return res.status(200).json({
    message: 'Participant Tax Invoice generated successfully',
    invoiceNumber: `${invoiceNumber} (ISO+™)`,
    fileUrl,
    itemCount: dbItems.length,
    invoiceTotal: Number(invoiceTotalRaw) || 0,
  });
}

export async function handleParticipantTaxInvoiceRoute(req, res, deps) {
  const { workspaceId, boardId } = deps.validateRequestParams(req);
  const business = await deps.getValidatedBusiness(workspaceId);
  const itemIds = req.body.items?.map((item) => item.id || item) || req.body.itemIds || [];
  if (!itemIds || itemIds.length === 0) {
    return res.status(400).json({ message: 'No items provided for invoice generation.' });
  }

  const isLowCatBoard = await resolveLowCatBoardFlag(req, boardId);
  const dbItems = await fetchValidatedDbItems(workspaceId, boardId, itemIds);

  try {
    return await generateParticipantTaxInvoicePdf({
      req,
      res,
      workspaceId,
      boardId,
      business,
      dbItems,
      isLowCatBoard,
      ...deps,
    });
  } catch (err) {
    const errorMessage = err?.message || 'Server error: An unknown error occurred. Please contact support via ISO+™ Portal.';
    deps.error('Webhook-Service', 'Participant tax invoice PDF generation failed', { err, errorMessage }, req);
    return res.status(500).json({ message: errorMessage });
  }
}
