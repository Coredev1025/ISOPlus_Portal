import Business from '../models/Business.js';
import Item from '../models/Item.js';
import { setIntegrationMessage, setGeneratedField, getQuoteNDISReferencedItems, getNDISMasterPlanReferencedItems, validateItemBelongsToTenant } from '../services/isoplus.js';
import { createInvoice, createQuote, createOrUpdateContact, getContactByEmail, getContactByName, getAccounts, configure, ensureAuthenticated } from '../services/xero.js';
import { Item as ItemPayloadDTO } from '../dto/itemsPayload.js';
import { logAuditTrail } from '../utils/auditLogger.js';
import { getDateOnlyIso } from '../utils/ndisServiceRecords.js';
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

function getValueFromFlatData(item, attributeName) {
  if (!item?.data) return null;
  const names = Array.isArray(attributeName) ? attributeName : [attributeName];
  for (const attrName of names) {
    if (item.data[attrName] !== undefined && item.data[attrName] !== null) {
      return item.data[attrName];
    }
  }
  if (Array.isArray(item.data.values)) {
    for (const attrName of names) {
      const entry = item.data.values.find((v) => v.attribute?.name === attrName);
      if (entry?.data !== undefined && entry?.data !== null) {
        return entry.data;
      }
    }
  }
  return null;
}

export function parseInvoiceGeneratorMasterItemIds(body) {
  const raw = Array.isArray(body?.itemIds)
    ? body.itemIds
    : (Array.isArray(body?.items) ? body.items : []);
  return [...new Set(raw.map((r) => {
    if (!r) return null;
    if (typeof r === 'string') return r;
    if (typeof r === 'object') {
      if (r.sourceItemId) return String(r.sourceItemId);
      if (r.id && String(r.id).includes(':')) return String(r.id).split(':')[0];
      if (r.id) return String(r.id);
    }
    return null;
  }).filter(Boolean).map(String))];
}

export async function handleXeroInvoicendis({
  req,
  res,
  workspaceId,
  boardId,
  item,
  validatePayload,
  initializeXeroOperation,
  handleError,
  saveInvoiceNumber,
  formatValue,
}) {
  const payload = req.body;
  const invoiceValues = item.values;
  const invoiceDate = invoiceValues['Invoice Date'];
  const dueDate = invoiceValues['Due Date'];

  try {
    const business = await initializeXeroOperation(workspaceId, boardId, item);
    const timezone = business?.headOfficeTimezone || 'Australia/Sydney';
    const serviceDate = computeNdisServiceDate(invoiceValues, timezone);

    const [servicePlanValues, cancellationTypeValues, , participantProfileValues] =
      await getNDISMasterPlanReferencedItems(workspaceId, boardId, item.id);
    if (!servicePlanValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, 'Master plan information is required. Master plan is missing a master plan reference.');
      throw new Error('Master plan information is required. Master plan is missing a master plan reference.');
    }
    if (!participantProfileValues || typeof participantProfileValues !== 'object') {
      await setIntegrationMessage(workspaceId, boardId, item.id, 'Participant profile information is required. Master plan is missing a participant profile reference.');
      throw new Error('Participant profile information is required. Master plan is missing a participant profile reference.');
    }

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
    const gstType = 'EXEMPTOUTPUT';
    const nowISO = getDateOnlyIso(new Date(), timezone);
    const accounts = await getAccounts(workspaceId);
    const salesAccountCode = accounts.find((acc) => acc.Type === 'REVENUE')?.Code || '200';

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
    const business = await Business.findOne({ workspaceId });
    await initializeXeroOperation(workspaceId, boardId, item);
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

    const lineItems = buildNdisQuoteXeroLineItems(NDISQuoteValues, refs.slice(1));
    const nowISO = getDateOnlyIso(new Date(), business?.headOfficeTimezone || 'Australia/Sydney');
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
    await ensureAuthenticated(workspaceId);

    const { masterItems, refItemsMap, participantProfileItem } =
      await getNdisInvoiceGeneratorContextFromMasterItems({ workspaceId, boardId, masterItemIds });

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

    const contact = await buildParticipantTaxContact({
      billingContact,
      participantProfile,
      getContactByEmail,
      getContactByName,
      createOrUpdateContact,
    });

    const businessForTz = await Business.findOne({ workspaceId: workspaceId.toString() })
      .select('headOfficeTimezone').lean().catch(() => null);
    const xeroNdisTimezone = businessForTz?.headOfficeTimezone || 'Australia/Sydney';

    const invoiceDateRaw = req.body?.invoiceDate || new Date().toISOString();
    const dueDateRaw = req.body?.dueDate || '';
    const invoiceDate = invoiceDateRaw ? String(invoiceDateRaw).split('T')[0] : new Date().toISOString().split('T')[0];
    const dueDate = resolveParticipantTaxDueDate(invoiceDateRaw, dueDateRaw);

    const accounts = await getAccounts(workspaceId);
    const salesAccountCode = accounts.find((acc) => acc.Type === 'REVENUE')?.Code || '200';
    const gstType = 'EXEMPTOUTPUT';
    const reference = buildNdisXeroInvoiceReference(participantProfile, profileItem);

    const invoice = {
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference,
      lineItems: [],
      date: invoiceDate,
      dueDate,
      status: 'DRAFT',
    };

    const allRows = [];
    for (const masterPlanItem of masterItems) {
      const spId = extractNdisRefId(masterPlanItem?.data?.[NDIS_MASTERPLAN_ATTR_DB.SERVICE_PLAN]);
      const servicePlanItem = spId ? refItemsMap.get(spId) : null;
      if (!servicePlanItem) {
        throw new Error('Master plan information is required. Master plan is missing a service plan reference.');
      }
      const ctId = extractNdisRefId(masterPlanItem?.data?.['Cancellation Type']);
      const cancellationTypeItem = ctId ? refItemsMap.get(ctId) : null;
      const pricingRule = await resolveNdisPricingRuleForServicePlan(workspaceId, servicePlanItem, boardId);
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

    if (allRows.length === 0) {
      return res.status(200).json({ message: 'There is nothing to invoice!' });
    }

    const enrichedRows = enrichNdisInvoiceGeneratorRows(allRows, buildMasterItemsMap(masterItems), xeroNdisTimezone);
    for (const r of enrichedRows) {
      const jobStatus = (r.jobStatus || '').toString().trim().toLowerCase();
      const dateIso = jobStatus === 'cancelled'
        ? r.scheduledServiceDate || r.serviceDeliveryDate || ''
        : r.serviceDeliveryDate || r.scheduledServiceDate || '';
      const rowDate = formatDdMmYyyy(dateIso, xeroNdisTimezone);
      invoice.lineItems.push({
        description: appendDateSuffix(r.service, rowDate),
        quantity: Number(r.quantity) || 0,
        unitAmount: Number(r.unitPrice) || 0,
        taxType: gstType,
        accountCode: salesAccountCode,
      });
    }

    const createdInvoice = await createInvoice(invoice);
    const savedInvoiceNumber = `${createdInvoice.invoiceNumber} (Xero)`;
    await Promise.all(masterItems.map(async (it) => {
      await saveInvoiceNumber(workspaceId, boardId, it.itemId, savedInvoiceNumber, 'Xero');
    }));

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

  if (!items || items.length === 0) {
    return res.status(400).json({ message: 'No items provided for invoice generation.' });
  }
  if (!participantName && !items[0]?.participant) {
    return res.status(400).json({ message: 'Participant name is required.' });
  }

  try {
    const business = await Business.findOne({ workspaceId: workspaceId.toString() });
    if (!business) throw new Error('Business not found');

    const participantProfileItem = await Item.findOne({
      workspaceId: workspaceId.toString(),
      boardId: boardId.toString(),
      'data.Full Name/Preferred Name': participantName || items[0]?.participant,
    });
    if (!participantProfileItem) throw new Error('Participant profile item not found');

    await configure();
    await ensureAuthenticated(workspaceId);
    for (const item of items) {
      await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    }

    const receiverName = (getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_CONTACT) || '').trim() || '';
    const billingAddressBase = getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_ADDRESS) || '';
    const participantEmail = getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_EMAIL_ADDRESS) || '';
    const effectiveParticipantName = receiverName || 'Unknown Participant';

    const contact = await buildParticipantTaxContact({
      billingContact: receiverName,
      participantProfile: {
        billingEmail: participantEmail,
        billingAddress: billingAddressBase,
        updatedAt: participantProfileItem.updatedAt,
      },
      getContactByEmail,
      getContactByName,
      createOrUpdateContact,
    });

    const effectiveDueDate = resolveParticipantTaxDueDate(invoiceDate, dueDate, true);
    const accounts = await getAccounts(workspaceId);
    const salesAccountCode = accounts.find((acc) => acc.Type === 'REVENUE')?.Code || '200';
    const { lineItems, totalAmount } = buildParticipantTaxLineItems({
      items,
      isLowCatBoard,
      salesAccountCode,
      gstType: 'EXEMPTOUTPUT',
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

    const invoiceReference = isLowCatBoard
      ? `Tax Invoice - ${effectiveParticipantName}`
      : `Participant Tax Invoice - ${effectiveParticipantName}`;
    const createdInvoice = await createInvoice({
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference: invoiceReference,
      lineItems,
      date: invoiceDate,
      dueDate: effectiveDueDate,
      status: 'DRAFT',
    });

    const successMessage = isLowCatBoard
      ? 'Your tax invoice has been created successfully in Xero.'
      : 'Your participant tax invoice has been created successfully in Xero.';
    await Promise.all(items.map(async (item) => {
      await setIntegrationMessage(workspaceId, boardId, item.id, successMessage);
      await setGeneratedField(workspaceId, boardId, item.id, `${createdInvoice.invoiceNumber} (Xero)`);
      await saveInvoiceNumber(workspaceId, boardId, item.id, `${createdInvoice.invoiceNumber} (Xero)`, 'Xero');
    }));

    logAuditTrail({
      workspaceId,
      action: isLowCatBoard ? 'Create Xero Tax Invoice' : 'Create Xero Participant Tax Invoice',
      detail: `Invoice created successfully, invoice number: ${createdInvoice.invoiceNumber}, ${isLowCatBoard ? 'receiver' : 'participant'}: ${effectiveParticipantName}, items: ${items.length}`,
      req,
    });

    return res.status(200).json({
      message: isLowCatBoard ? 'Tax Invoice generated successfully in Xero' : 'Participant Tax Invoice generated successfully in Xero',
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
    await Promise.all(items.map(async (item) => {
      await setIntegrationMessage(workspaceId, boardId, item.id, `Error: ${errorMessage}`);
    }));
    return res.status(500).json({ message: errorMessage });
  }
}
