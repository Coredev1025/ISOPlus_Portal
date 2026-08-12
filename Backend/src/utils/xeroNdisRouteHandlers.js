import Business from '../models/Business.js';
import Item from '../models/Item.js';
import { setIntegrationMessage, setGeneratedField, getQuoteNDISReferencedItems, getNDISMasterPlanReferencedItems, validateItemBelongsToTenant } from '../services/isoplus.js';
import { createInvoice, createQuote, createOrUpdateContact, getContactByEmail, getContactByName, configure, ensureAuthenticated } from '../services/xero.js';
import { Item as ItemPayloadDTO } from '../dto/itemsPayload.js';
import { logAuditTrail } from '../utils/auditLogger.js';
import { getDateOnlyIso } from '../utils/ndisServiceRecords.js';
import { mongoEq } from '../utils/securityHelpers.js';
import {
  pickGstValue,
  resolveSalesLineMapping,
} from '../utils/xeroLineItemMapping.js';
import {
  loadXeroChartOptions,
  rejectIfAccountTaxMismatch,
} from '../utils/xeroAccountTaxHelpers.js';
import {
  getNdisInvoiceGeneratorContextFromMasterItems,
  prepareParticipantForInvoiceGenerator,
} from '../utils/ndisInvoiceGeneratorInvoicing.js';
import {
  buildMasterItemsMap,
  buildNdisXeroInvoiceReference,
  enrichNdisInvoiceGeneratorRows,
} from '../utils/ndisInvoiceGeneratorOutput.js';
import {
  NDIS_MASTERPLAN_ATTR as NDIS_MASTERPLAN_ATTR_DB,
  buildNdisMasterPlanServiceRows,
  buildNdisSupportCatalogueForServicePlan,
  extractRefId as extractNdisRefId,
  formatDdMmYyyy,
} from '../utils/ndisServiceRecords.js';
import { resolveNdisPricingRuleForServicePlan } from '../utils/ndisPricingRules.js';
import {
  buildNdisMasterPlanInvoiceLines,
  computeNdisServiceDate,
  ndisLinesToXeroItems,
  resolveNdisParticipantContact,
} from '../utils/ndisMasterPlanLineHelpers.js';
import {
  buildNdisQuoteMappedAndXeroPayload,
  buildNdisQuoteXeroLineItems,
  resolveNdisQuoteRecipientContact,
} from '../utils/ndisQuoteLineHelpers.js';
import {
  buildParticipantTaxContact,
  buildParticipantTaxLineItems,
  resolveParticipantTaxDueDate,
} from '../utils/xeroParticipantTaxHelpers.js';

const REF_ATTRIBUTE_NAMES = {
  PROFILE_EMAIL_ADDRESS: 'Email',
  PROFILE_BILLING_EMAIL: 'Billing Email',
  PROFILE_BILLING_CONTACT: 'Billing Contact',
  PROFILE_BILLING_ADDRESS: 'Billing Address',
};

const DEFAULT_XERO_TIMEZONE = 'Australia/Sydney';
const NDIS_SALES_MAPPING_OPTIONS = { unmappedTaxFreeType: 'EXEMPTOUTPUT' };

function parseMasterItemIdEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object') return null;
  if (entry.sourceItemId) return String(entry.sourceItemId);
  if (entry.id && String(entry.id).includes(':')) return String(entry.id).split(':')[0];
  if (entry.id) return String(entry.id);
  return null;
}

function lookupFlatDataValue(data, names) {
  for (const attrName of names) {
    if (data[attrName] !== undefined && data[attrName] !== null) {
      return data[attrName];
    }
  }
  return null;
}

function lookupValuesArrayData(data, names) {
  if (!Array.isArray(data.values)) return null;
  for (const attrName of names) {
    const entry = data.values.find((v) => v.attribute?.name === attrName);
    if (entry?.data !== undefined && entry?.data !== null) {
      return entry.data;
    }
  }
  return null;
}

function getValueFromFlatData(item, attributeName) {
  if (!item?.data) return null;
  const names = Array.isArray(attributeName) ? attributeName : [attributeName];
  return lookupFlatDataValue(item.data, names) ?? lookupValuesArrayData(item.data, names);
}

export function parseInvoiceGeneratorMasterItemIds(body) {
  const raw = Array.isArray(body?.itemIds)
    ? body.itemIds
    : (Array.isArray(body?.items) ? body.items : []);
  return [...new Set(raw.map(parseMasterItemIdEntry).filter(Boolean).map((id) => String(id)))];
}

async function assertMasterPlanReferences(workspaceId, boardId, itemId, servicePlanValues, participantProfileValues) {
  if (!servicePlanValues) {
    await setIntegrationMessage(workspaceId, boardId, itemId, 'Master plan information is required. Master plan is missing a master plan reference.');
    throw new Error('Master plan information is required. Master plan is missing a master plan reference.');
  }
  if (!participantProfileValues || typeof participantProfileValues !== 'object') {
    await setIntegrationMessage(workspaceId, boardId, itemId, 'Participant profile information is required. Master plan is missing a participant profile reference.');
    throw new Error('Participant profile information is required. Master plan is missing a participant profile reference.');
  }
}

function validateParticipantTaxRequest(items, participantName, res) {
  if (!items || items.length === 0) {
    return res.status(400).json({ message: 'No items provided for invoice generation.' });
  }
  if (!participantName && !items[0]?.participant) {
    return res.status(400).json({ message: 'Participant name is required.' });
  }
  return null;
}

async function loadParticipantTaxProfile(workspaceId, boardId, participantName, items) {
  const business = await Business.findOne({ workspaceId: mongoEq(workspaceId) }).lean();
  if (!business) throw new Error('Business not found');

  const participantQueryName = mongoEq(participantName || items[0]?.participant);
  if (!participantQueryName) {
    return { errorResponse: { status: 400, body: { message: 'Participant name is required.' } } };
  }

  const participantProfileItem = await Item.findOne({
    workspaceId: mongoEq(workspaceId),
    boardId: mongoEq(boardId),
    'data.Full Name/Preferred Name': participantQueryName,
  }).select('data updatedAt').lean();
  if (!participantProfileItem) throw new Error('Participant profile item not found');

  return { business, participantProfileItem, participantQueryName };
}

async function setupParticipantTaxXeroAuth(workspaceId, boardId, items) {
  await configure();
  await Promise.all([
    ensureAuthenticated(workspaceId),
    ...items.map((item) => validateItemBelongsToTenant(workspaceId, boardId, item.id)),
  ]);
}

function getParticipantTaxBillingDetails(participantProfileItem) {
  const receiverName = (getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_CONTACT) || '').trim() || '';
  const billingAddressBase = getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_ADDRESS) || '';
  const participantEmail = getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_EMAIL_ADDRESS) || '';
  return {
    receiverName,
    billingAddressBase,
    participantEmail,
    effectiveParticipantName: receiverName || 'Unknown Participant',
  };
}

function getParticipantTaxLabels(isLowCatBoard) {
  return {
    invoiceReferencePrefix: isLowCatBoard ? 'Tax Invoice' : 'Participant Tax Invoice',
    successMessage: isLowCatBoard
      ? 'Your tax invoice has been created successfully in Xero.'
      : 'Your participant tax invoice has been created successfully in Xero.',
    auditAction: isLowCatBoard ? 'Create Xero Tax Invoice' : 'Create Xero Participant Tax Invoice',
    responseMessage: isLowCatBoard
      ? 'Tax Invoice generated successfully in Xero'
      : 'Participant Tax Invoice generated successfully in Xero',
    auditRoleLabel: isLowCatBoard ? 'receiver' : 'participant',
  };
}

async function persistParticipantTaxSuccess(items, workspaceId, boardId, savedInvoiceNumber, successMessage, saveInvoiceNumber) {
  await Promise.all(items.map(async (item) => {
    await setIntegrationMessage(workspaceId, boardId, item.id, successMessage);
    await setGeneratedField(workspaceId, boardId, item.id, savedInvoiceNumber);
    await saveInvoiceNumber(workspaceId, boardId, item.id, savedInvoiceNumber, 'Xero');
  }));
}

async function fetchBusinessForXero(workspaceId) {
  try {
    return await Business.findOne({ workspaceId: mongoEq(workspaceId) }).lean();
  } catch {
    return null;
  }
}

async function fetchBusinessTimezone(workspaceId) {
  const businessDoc = await fetchBusinessForXero(workspaceId);
  return businessDoc?.headOfficeTimezone || DEFAULT_XERO_TIMEZONE;
}

function firstRowGst(rows) {
  for (const row of rows || []) {
    const gst = pickGstValue(row?.gst, row?.GST);
    if (gst) return gst;
  }
  return '';
}

function getMasterPlanItemRefs(masterPlanItem, refItemsMap) {
  const spId = extractNdisRefId(masterPlanItem?.data?.[NDIS_MASTERPLAN_ATTR_DB.SERVICE_PLAN]);
  const servicePlanItem = spId ? refItemsMap.get(spId) : null;
  const ctId = extractNdisRefId(masterPlanItem?.data?.['Cancellation Type']);
  const cancellationTypeItem = ctId ? refItemsMap.get(ctId) : null;
  return { servicePlanItem, cancellationTypeItem };
}

export async function handleXeroInvoicendis({
  req,
  res,
  workspaceId,
  boardId,
  item,
  initializeXeroOperation,
  handleError,
  saveInvoiceNumber,
  formatValue,
}) {
  const invoiceValues = item.values;
  const invoiceDate = invoiceValues['Invoice Date'];
  const dueDate = invoiceValues['Due Date'];

  try {
    const business = await initializeXeroOperation(workspaceId, boardId, item);
    const timezone = business?.headOfficeTimezone || DEFAULT_XERO_TIMEZONE;
    const serviceDate = computeNdisServiceDate(invoiceValues, timezone);

    const [[servicePlanValues, cancellationTypeValues, , participantProfileValues], chart] =
      await Promise.all([
        getNDISMasterPlanReferencedItems(workspaceId, boardId, item.id),
        loadXeroChartOptions(workspaceId),
      ]);
    await assertMasterPlanReferences(workspaceId, boardId, item.id, servicePlanValues, participantProfileValues);

    const contact = await resolveNdisParticipantContact({
      participantProfileValues,
      getContactByEmail,
      createOrUpdateContact,
      setIntegrationMessage,
      workspaceId,
      boardId,
      itemId: item.id,
    });

    const groupSize = Number(invoiceValues['Group Size']) || 1;
    const nowISO = getDateOnlyIso(new Date(), timezone);
    const gstValue = pickGstValue(invoiceValues.GST, invoiceValues['GST']);
    const { accountCode: salesAccountCode, taxType: gstType } = resolveSalesLineMapping(
      business,
      'invoice',
      gstValue,
      chart.accounts,
      undefined,
      NDIS_SALES_MAPPING_OPTIONS,
    );
    const mismatchResponse = await rejectIfAccountTaxMismatch({
      workspaceId,
      boardId,
      itemId: item.id,
      accountCode: salesAccountCode,
      taxType: gstType,
      res,
      chart,
    });
    if (mismatchResponse) return mismatchResponse;

    const lineCtx = {
      workspaceId,
      boardId,
      itemId: item.id,
      servicePlanValues,
      cancellationTypeValues,
      invoiceValues,
      groupSize,
      timezone,
      setIntegrationMessage,
      awaitIntegrationMessage: true,
    };
    const ndisLines = await buildNdisMasterPlanInvoiceLines(lineCtx);
    if (ndisLines.length === 0) {
      await setIntegrationMessage(workspaceId, boardId, item.id, 'There is nothing to invoice!');
      return res.status(200).json({ message: 'There is nothing to invoice!' });
    }

    const invoice = {
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference: item.values['Invoice Number'],
      lineItems: ndisLinesToXeroItems(ndisLines, { gstType, salesAccountCode, serviceDate, formatValue }),
      lineAmountTypes: 'Exclusive',
      date: invoiceDate || nowISO,
      dueDate: dueDate || nowISO,
      status: 'DRAFT',
    };

    const createdInvoice = await createInvoice(invoice);
    await setIntegrationMessage(workspaceId, boardId, item.id, 'Your invoice has been created successfully in Xero.');
    logAuditTrail({
      workspaceId,
      action: 'Create Xero Invoice',
      detail: `Invoice created successfully, invoice number: ${createdInvoice.invoiceNumber}`,
      req,
    });
    await setGeneratedField(workspaceId, boardId, item.id, `${createdInvoice.invoiceNumber} (Xero)`);
    await saveInvoiceNumber(workspaceId, boardId, item.id, `${createdInvoice.invoiceNumber} (Xero)`, 'Xero');
    return res.json(createdInvoice);
  } catch (err) {
    const result = await handleError(err, workspaceId, boardId, item, req, 'invoice');
    return res.status(200).json(result.body);
  }
}

export async function handleXeroQuotendis({
  req,
  res,
  workspaceId,
  boardId,
  item,
  initializeXeroOperation,
  handleError,
  warn,
}) {
  const payload = req.body;
  if (!payload.items || payload.items.length === 0) {
    warn('Xero-Service', 'Received payload with empty items.', { payload }, req ?? null);
    return res.json('No items found in the payload.');
  }

  try {
    const business = await initializeXeroOperation(workspaceId, boardId, item);
    const NDISQuoteValues = item.values;
    const refs = await getQuoteNDISReferencedItems(workspaceId, boardId, item.id);
    const [serviceAreaValues] = refs;
    if (!serviceAreaValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, 'ERROR: Service Area value is required.');
      throw new Error('Service Area value is required.');
    }

    const contact = await resolveNdisQuoteRecipientContact({
      NDISQuoteValues,
      getContactByEmail,
      createOrUpdateContact,
      setIntegrationMessage,
      workspaceId,
      boardId,
      itemId: item.id,
    });

    const chart = await loadXeroChartOptions(workspaceId);
    const gstValue = pickGstValue(NDISQuoteValues.GST, NDISQuoteValues['GST']);
    const { accountCode, taxType: gstType } = resolveSalesLineMapping(
      business,
      'quote',
      gstValue,
      chart.accounts,
      'quoteService',
      NDIS_SALES_MAPPING_OPTIONS,
    );
    const mismatchResponse = await rejectIfAccountTaxMismatch({
      workspaceId,
      boardId,
      itemId: item.id,
      accountCode,
      taxType: gstType,
      res,
      chart,
    });
    if (mismatchResponse) return mismatchResponse;

    const lineItems = buildNdisQuoteXeroLineItems(NDISQuoteValues, refs.slice(1), {
      gstType,
      accountCode,
    });
    const nowISO = getDateOnlyIso(new Date(), business?.headOfficeTimezone || DEFAULT_XERO_TIMEZONE);
    const { mappedQuote, xeroQuote } = buildNdisQuoteMappedAndXeroPayload({
      NDISQuoteValues,
      lineItems,
      contact,
      business,
      nowISO,
    });

    const { error: validationError } = ItemPayloadDTO.validate('Quote', mappedQuote);
    if (validationError) {
      await setIntegrationMessage(workspaceId, boardId, item.id, `ERROR: Quote validation failed: ${JSON.stringify(validationError.details)}`);
      return res.status(200).json({ message: 'Quote validation failed', details: validationError.details });
    }

    const createdQuote = await createQuote(xeroQuote);
    await setIntegrationMessage(workspaceId, boardId, item.id, 'Your quote has been created successfully in Xero.');
    logAuditTrail({
      workspaceId,
      action: 'Create Xero Quote',
      detail: `Quote created successfully, quote number: ${createdQuote.quoteNumber}`,
      req,
    });
    await setGeneratedField(workspaceId, boardId, item.id, `${createdQuote.quoteNumber} (Xero)`);
    return res.json(createdQuote);
  } catch (err) {
    const result = await handleError(err, workspaceId, boardId, item, req, 'quote');
    return res.status(200).json(result.body);
  }
}

async function buildNdisXeroServiceRows(masterItems, refItemsMap, workspaceId, boardId, profileItem, participantName, xeroNdisTimezone) {
  const pricingRules = await Promise.all(masterItems.map((masterPlanItem) => {
    const { servicePlanItem } = getMasterPlanItemRefs(masterPlanItem, refItemsMap);
    if (!servicePlanItem) {
      throw new Error('Master plan information is required. Master plan is missing a service plan reference.');
    }
    return resolveNdisPricingRuleForServicePlan(workspaceId, servicePlanItem, boardId);
  }));

  const allRows = [];
  for (let i = 0; i < masterItems.length; i++) {
    const masterPlanItem = masterItems[i];
    const { servicePlanItem, cancellationTypeItem } = getMasterPlanItemRefs(masterPlanItem, refItemsMap);
    const pricingRule = pricingRules[i];
    const supportCatalogue = buildNdisSupportCatalogueForServicePlan(servicePlanItem, refItemsMap, pricingRule);
    allRows.push(...buildNdisMasterPlanServiceRows({
      masterPlanItem,
      participantName,
      participantProfileItem: profileItem,
      servicePlanItem,
      supportCatalogue,
      cancellationTypeItem,
      invoiceNumber: '',
      invoicePdfLink: null,
      timeZone: xeroNdisTimezone,
      pricingRule,
    }));
  }
  return allRows;
}

function appendEnrichedRowsToXeroInvoice(invoice, enrichedRows, xeroNdisTimezone, appendDateSuffix, gstType, salesAccountCode) {
  for (const row of enrichedRows) {
    const jobStatus = (row.jobStatus || '').toString().trim().toLowerCase();
    const dateIso = jobStatus === 'cancelled'
      ? row.scheduledServiceDate || row.serviceDeliveryDate || ''
      : row.serviceDeliveryDate || row.scheduledServiceDate || '';
    const rowDate = formatDdMmYyyy(dateIso, xeroNdisTimezone);
    invoice.lineItems.push({
      description: appendDateSuffix(row.service, rowDate),
      quantity: Number(row.quantity) || 0,
      unitAmount: Number(row.unitPrice) || 0,
      taxType: gstType,
      accountCode: salesAccountCode,
    });
  }
}

async function persistXeroInvoiceNumbers(masterItems, workspaceId, boardId, savedInvoiceNumber, saveInvoiceNumber) {
  await Promise.all(masterItems.map((item) =>
    saveInvoiceNumber(workspaceId, boardId, item.itemId, savedInvoiceNumber, 'Xero'),
  ));
}

export async function handleXeroInvoicendisInvoiceGenerator({
  req,
  res,
  workspaceId,
  boardId,
  saveInvoiceNumber,
  appendDateSuffix,
  error: logError,
}) {
  try {
    const masterItemIds = parseInvoiceGeneratorMasterItemIds(req.body);
    await configure();
    const [, invoiceContext] = await Promise.all([
      ensureAuthenticated(workspaceId),
      getNdisInvoiceGeneratorContextFromMasterItems({ workspaceId, boardId, masterItemIds }),
    ]);
    const { masterItems, refItemsMap, participantProfileItem } = invoiceContext;

    const fallbackParticipantName = String(req.body?.participantName || '').trim();
    const { participantProfile, participantProfileItem: profileItem, participantName, billingContact } =
      await prepareParticipantForInvoiceGenerator({
        workspaceId,
        boardId,
        participantProfileItem,
        fallbackParticipantName,
      });

    if (!billingContact) {
      throw new Error(
        'Billing Contact is required for NDIS invoice contact creation. Please ensure the Participant Profile has a Billing Contact, Full Name/Preferred Name, or Preferred Name.',
      );
    }

    const [contact, business, chart] = await Promise.all([
      buildParticipantTaxContact({
        billingContact,
        participantProfile,
        getContactByEmail,
        getContactByName,
        createOrUpdateContact,
      }),
      fetchBusinessForXero(workspaceId),
      loadXeroChartOptions(workspaceId),
    ]);
    const xeroNdisTimezone = business?.headOfficeTimezone || DEFAULT_XERO_TIMEZONE;

    const invoiceDateRaw = req.body?.invoiceDate || new Date().toISOString();
    const dueDateRaw = req.body?.dueDate || '';
    const invoiceDate = invoiceDateRaw ? String(invoiceDateRaw).split('T')[0] : new Date().toISOString().split('T')[0];
    const dueDate = resolveParticipantTaxDueDate(invoiceDateRaw, dueDateRaw);

    const reference = buildNdisXeroInvoiceReference(participantProfile, profileItem);

    const invoice = {
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference,
      lineItems: [],
      lineAmountTypes: 'Exclusive',
      date: invoiceDate,
      dueDate,
      status: 'DRAFT',
    };

    const allRows = await buildNdisXeroServiceRows(
      masterItems,
      refItemsMap,
      workspaceId,
      boardId,
      profileItem,
      participantName,
      xeroNdisTimezone,
    );

    if (allRows.length === 0) {
      return res.status(200).json({ message: 'There is nothing to invoice!' });
    }

    const gstValue = pickGstValue(req.body?.gst, req.body?.GST, firstRowGst(allRows));
    const { accountCode: salesAccountCode, taxType: gstType } = resolveSalesLineMapping(
      business,
      'invoice',
      gstValue,
      chart.accounts,
      undefined,
      NDIS_SALES_MAPPING_OPTIONS,
    );
    const mismatchResponse = await rejectIfAccountTaxMismatch({
      workspaceId,
      boardId,
      itemId: masterItems[0]?.itemId,
      accountCode: salesAccountCode,
      taxType: gstType,
      res,
      chart,
    });
    if (mismatchResponse) return mismatchResponse;

    const enrichedRows = enrichNdisInvoiceGeneratorRows(allRows, buildMasterItemsMap(masterItems), xeroNdisTimezone);
    appendEnrichedRowsToXeroInvoice(
      invoice,
      enrichedRows,
      xeroNdisTimezone,
      appendDateSuffix,
      gstType,
      salesAccountCode,
    );

    const createdInvoice = await createInvoice(invoice);
    const savedInvoiceNumber = `${createdInvoice.invoiceNumber} (Xero)`;
    await persistXeroInvoiceNumbers(masterItems, workspaceId, boardId, savedInvoiceNumber, saveInvoiceNumber);

    return res.json({
      invoiceNumber: createdInvoice.invoiceNumber,
      invoiceUrl: createdInvoice.url || createdInvoice.onlineInvoiceUrl || '',
      itemCount: masterItems.length,
      lineCount: invoice.lineItems.length,
    });
  } catch (err) {
    const message = err?.message || 'Unknown error';
    logError('Xero-Service', 'Server error (NDIS invoice generator Xero)', { message, stack: err?.stack }, req ?? null);
    return res.status(200).json({ message });
  }
}

export async function handleXeroInvoiceParticipantTax({
  req,
  res,
  workspaceId,
  boardId,
  saveInvoiceNumber,
  getXeroServiceRowDate,
  appendDateSuffix,
  formatDdMmYyyy,
  round2,
  round4,
  error: logError,
}) {
  const items = req.body.items || [];
  const participantName = req.body?.participantName || '';
  const invoiceDate = req.body?.invoiceDate || new Date().toISOString();
  const dueDate = req.body?.dueDate || '';
  const isLowCatBoard = req.body?.isLowCat || false;

  const validationResponse = validateParticipantTaxRequest(items, participantName, res);
  if (validationResponse) return validationResponse;

  try {
    const profileResult = await loadParticipantTaxProfile(workspaceId, boardId, participantName, items);
    if (profileResult.errorResponse) {
      return res.status(profileResult.errorResponse.status).json(profileResult.errorResponse.body);
    }
    const { business, participantProfileItem } = profileResult;

    await setupParticipantTaxXeroAuth(workspaceId, boardId, items);

    const {
      receiverName,
      billingAddressBase,
      participantEmail,
      effectiveParticipantName,
    } = getParticipantTaxBillingDetails(participantProfileItem);

    const [contact, chart] = await Promise.all([
      buildParticipantTaxContact({
        billingContact: receiverName,
        participantProfile: {
          billingEmail: participantEmail,
          billingAddress: billingAddressBase,
          updatedAt: participantProfileItem.updatedAt,
        },
        getContactByEmail,
        getContactByName,
        createOrUpdateContact,
      }),
      loadXeroChartOptions(workspaceId),
    ]);

    const effectiveDueDate = resolveParticipantTaxDueDate(invoiceDate, dueDate, true);
    const gstValue = pickGstValue(
      req.body?.gst,
      req.body?.GST,
      items[0]?.values?.GST,
      items[0]?.gst,
    );
    const { accountCode: salesAccountCode, taxType: gstType } = resolveSalesLineMapping(
      business,
      'invoice',
      gstValue,
      chart.accounts,
      undefined,
      NDIS_SALES_MAPPING_OPTIONS,
    );
    const mismatchResponse = await rejectIfAccountTaxMismatch({
      workspaceId,
      boardId,
      itemId: items[0]?.id,
      accountCode: salesAccountCode,
      taxType: gstType,
      res,
      chart,
    });
    if (mismatchResponse) return mismatchResponse;

    const { lineItems } = buildParticipantTaxLineItems({
      items,
      isLowCatBoard,
      salesAccountCode,
      gstType,
      business,
      getXeroServiceRowDate,
      appendDateSuffix,
      formatDdMmYyyy,
      round2,
      round4,
    });

    if (lineItems.length === 0) {
      await Promise.all(items.map((item) =>
        setIntegrationMessage(workspaceId, boardId, item.id, 'There is nothing to invoice!'),
      ));
      return res.status(400).json({ message: 'There is nothing to invoice!' });
    }

    const labels = getParticipantTaxLabels(isLowCatBoard);
    const createdInvoice = await createInvoice({
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference: `${labels.invoiceReferencePrefix} - ${effectiveParticipantName}`,
      lineItems,
      lineAmountTypes: 'Exclusive',
      date: invoiceDate,
      dueDate: effectiveDueDate,
      status: 'DRAFT',
    });

    const savedInvoiceNumber = `${createdInvoice.invoiceNumber} (Xero)`;
    await persistParticipantTaxSuccess(
      items,
      workspaceId,
      boardId,
      savedInvoiceNumber,
      labels.successMessage,
      saveInvoiceNumber,
    );

    logAuditTrail({
      workspaceId,
      action: labels.auditAction,
      detail: `Invoice created successfully, invoice number: ${createdInvoice.invoiceNumber}, ${labels.auditRoleLabel}: ${effectiveParticipantName}, items: ${items.length}`,
      req,
    });

    return res.status(200).json({
      message: labels.responseMessage,
      invoiceNumber: createdInvoice.invoiceNumber,
      invoiceId: createdInvoice.invoiceID,
      invoiceUrl: createdInvoice.url,
      itemCount: items.length,
      participantName: effectiveParticipantName,
    });
  } catch (err) {
    const errorMessage = err?.message || 'Server error: An unknown error occurred. Please contact support via ISO+™ Portal.';
    logError('Xero-Service', 'Error creating participant tax invoice in Xero', {
      message: errorMessage,
      workspaceId,
      boardId,
      itemCount: items.length,
    }, req ?? null);
    await Promise.all(items.map((item) =>
      setIntegrationMessage(workspaceId, boardId, item.id, `Error: ${errorMessage}`),
    ));
    return res.status(500).json({ message: errorMessage });
  }
}
