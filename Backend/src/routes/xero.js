import express from 'express';
import dotenv from 'dotenv';
import Business from '../models/Business.js';
import InvoiceNumber from '../models/InvoiceNumber.js';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { warn, error } from '../utils/logger.js';
import { isEmpty } from '../utils/helpers.js';
import { mongoEq } from '../utils/securityHelpers.js';
import {
  validateItemBelongsToTenant,
  getJobReportingReferencedItems,
  getJobPlanningReferencedItems,
  getQuoteReferencedItems,
  getPurchaseOrderReferencedItems,
  setIntegrationMessage,
  setGeneratedField,
  getQuoteNDISReferencedItems,
  getNDISMasterPlanReferencedItems
} from '../services/isoplus.js';
import {
  configure,
  ensureAuthenticated,
  createInvoice,
  createOrUpdateContact,
  createQuote,
  createPurchaseOrder,
  getAuthUrl,
  refreshTokenSet,
  callback,
  getContactByEmail,
  getContactByName,
  findOrCreateItem,
} from '../services/xero.js';
import { Item as ItemPayloadDTO } from '../dto/itemsPayload.js';
import { logAuditTrail } from '../utils/auditLogger.js';
import { resolveSalesLineMapping } from '../utils/xeroLineItemMapping.js';
import {
  loadXeroChartOptions,
  rejectIfAccountTaxMismatch,
} from '../utils/xeroAccountTaxHelpers.js';
import {
  buildUsedMaterialLineItem,
  getPayableMaterialFeeAmount,
  resolveMaterialSalesLine,
} from '../utils/xeroMaterialLineHelpers.js';
import {
  NDIS_MASTERPLAN_ATTR as NDIS_MASTERPLAN_ATTR_DB,
  buildNdisMasterPlanServiceRows,
  buildNdisSupportCatalogueForServicePlan,
  extractRefId as extractNdisRefId,
  formatDdMmYyyy,
  formatDateTimeInValueZone,
  formatDateInValueZone,
  getDateOnlyIso,
} from '../utils/ndisServiceRecords.js';
import { resolveNdisPricingRuleForServicePlan } from '../utils/ndisPricingRules.js';
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
  handleXeroInvoicendis,
  handleXeroQuotendis,
  handleXeroInvoicendisInvoiceGenerator,
  handleXeroInvoiceParticipantTax,
} from '../utils/xeroNdisRouteHandlers.js';

dotenv.config();
const router = express.Router();

async function validatePayload(payload, req) {
  if (!payload?.items?.length) {
    warn('Xero-Service', 'Received payload with empty items.', { payload }, req ?? null);
    return { error: 'No items found in the payload' };
  }
  return { item: payload.items[0] };
}

function formatValue(val) {
  const num = Number(val);
  if (!isNaN(num)) {
    const factor = Math.pow(10, 2);
    const result = Math.round(num * factor) / factor;

    return result.toFixed(2);
  } else {
    return val;
  }
}

function roundTo(value, dp) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, dp);
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

function round2(value) {
  return roundTo(value, 2);
}

function round4(value) {
  return roundTo(value, 4);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getXeroServiceRowDate(item) {
  const status = (item?.transactionStatus ?? '').toString().trim();
  const scheduled = (item?.scheduledServiceDate ?? '').toString().trim();
  const delivered = (item?.serviceDeliveryDate ?? '').toString().trim();

  const isDelivered =
    status === 'Delivered - To be claimed and invoiced.' ||
    status.toLowerCase().startsWith('delivered');

  const preferred = isDelivered ? delivered : scheduled;
  const fallback = isDelivered ? scheduled : delivered;
  return preferred || fallback || '';
}

function appendDateSuffix(description, rowDate) {
  const base = (description ?? '').toString().trim() || 'Service';
  const date = (rowDate ?? '').toString().trim();
  if (!date) return base;

  const alreadyHasDateSuffix = new RegExp(`\\s*-\\s*${escapeRegExp(date)}\\s*$`).test(base);
  return alreadyHasDateSuffix ? base : `${base} - ${date}`;
}

async function initializeXeroOperation(workspaceId, boardId, item) {
  const business = await Business.findOne({ workspaceId: mongoEq(workspaceId) });
  if (!business) {
    throw new Error('Business not found');
  }

  await configure();
  await ensureAuthenticated(workspaceId);
  await validateItemBelongsToTenant(workspaceId, boardId, item.id);
  await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

  return business;
}

async function saveInvoiceNumber(workspaceId, boardId, itemId, invoiceNumber, type) {
  try {
    const safeItemId = mongoEq(itemId);
    const safeWorkspaceId = mongoEq(workspaceId);
    const safeBoardId = mongoEq(boardId);
    const safeType = mongoEq(type);
    const safeInvoiceNumber = mongoEq(invoiceNumber);

    await InvoiceNumber.findOneAndUpdate(
      {
        itemId: { $eq: String(safeItemId) },
        workspaceId: { $eq: String(safeWorkspaceId) },
        boardId: { $eq: String(safeBoardId) },
        type: { $eq: String(safeType) }
      },
      {
        $set: {
          itemId: safeItemId,
          workspaceId: safeWorkspaceId,
          boardId: safeBoardId,
          invoiceNumber: safeInvoiceNumber,
          type: safeType,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      {
        upsert: true,
        new: true
      }
    );
  } catch (err) {
    // Log error but don't fail the invoice generation if saving fails
    warn('Xero-Service', 'Failed to save invoice number to database', {
      workspaceId,
      boardId,
      itemId,
      invoiceNumber,
      type,
      error: err.message
    }, null);
  }
}

function createContactPayload(values, isUpdate = false) {
  const basePayload = {
    name: values.client || values.Client || values.Contractor,
    firstName: values.contactPersonsFirstName || values["Contact Person's First Name"] || values.ContactPersonsFirstName,
    lastName: values.contactPersonsLastName || values["Contact Person's Last Name"] || values.ContactPersonsLastName,
    addresses: [
      {
        addressType: 'POBOX',
        addressLine1: values.address || values.Address,
        city: values.suburb || values.Suburb,
        region: values.state || values.State,
        postalCode: (values.postcode || values.Postcode).toString()
      },
      {
        addressType: 'STREET',
        addressLine1: values.address || values.Address,
        city: values.suburb || values.Suburb,
        region: values.state || values.State,
        postalCode: (values.postcode || values.Postcode).toString()
      }
    ],
    emailAddress: values.emailAddress || values['Email Address'] || values.EmailAddress
  };

  return basePayload;
}

async function handleError(err, workspaceId, boardId, item, req, entityType = 'item') {
  error('Xero-Service', `Error processing ${entityType} in Xero`, { err, workspaceId, boardId, itemId: item?.id }, req);
  if (item) {
    await setIntegrationMessage(
      workspaceId,
      boardId,
      item.id,
      `An error occurred whilst processing the ${entityType}. Please contact ISO+™ support. Further information: ${err.message}`
    );
  }

  logAuditTrail({
    workspaceId,
    action: `Process Xero ${entityType}`,
    detail: `Error processing ${entityType}: ${err.message}`,
    req
  });

  return {
    status: 200,
    body: {
      message: `Error processing ${entityType} in Xero`,
      error: err.message
    }
  };
}

function mapInvoiceValuesToJobDTO(values) {
  return {
    jobNumber: values['Job Number'],
    jobDurationHrs: values['Job Duration (Hrs.)'],
    serviceFeeType: values['Service Fee Type'],
    payableServiceFee: values['Payable Service Fee($) - GST Excl.'],
    payableMaterialFee: values['Payable Material Fee($) - GST Excl.'],
    otherPayableFee: values['Other Payable Fee($) - GST Excl.'],
  };
}

const REF_ATTRIBUTE_NAMES = {
  PROFILE_EMAIL_ADDRESS: 'Email',
  PROFILE_BILLING_EMAIL: 'Billing Email',
  PROFILE_BILLING_CONTACT: 'Billing Contact',
  PROFILE_BILLING_ADDRESS: 'Billing Address',
  PROFILE_PHONE_NUMBER: 'Primary Phone Number'
};

const getValueFromFlatData = (item, attributeName) => {
  if (!item?.data) return null;

  const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];

  for (const attrName of attributeNames) {
    if (item.data[attrName] !== undefined && item.data[attrName] !== null) {
      return item.data[attrName];
    }
  }

  if (Array.isArray(item.data.values)) {
    for (const attrName of attributeNames) {
      const entry = item.data.values.find(v => v.attribute?.name === attrName);
      if (entry?.data !== undefined && entry?.data !== null) {
        return entry.data;
      }
    }
  }

  return null;
};

router.get('/services', (req, res) => {
  const services = [
    { Name: 'Create invoice', Status: 'Ready' },
    { Name: 'Update invoice', Status: 'In progress' },
    { Name: 'Get invoice', Status: 'In progress' },
    { Name: 'Retrieving the online invoice URL', Status: 'In progress', Use: 'To get an online invoice URL.' },
    { Name: 'Emailing an invoice', Status: 'In progress', Use: 'To trigger the email of a sales invoice out of Xero.' },
    { Name: 'Webhooks', Status: 'In progress', Use: 'Create a subscription to get invoice events.' },
  ];
  res.json(services);
});

router.get('/hello', (req, res) => {
  res.send('Hello, World!');
});

function buildXeroContactAddresses(contactValues) {
  const shared = {
    addressLine1: contactValues.address,
    city: contactValues.suburb,
    region: contactValues.state,
    postalCode: contactValues.postcode.toString(),
  };
  return [
    { addressType: 'POBOX', ...shared },
    { addressType: 'STREET', ...shared },
  ];
}

function buildXeroContactPayload(contactValues, contactID) {
  return {
    ...(contactID ? { contactID } : {}),
    name: contactValues.client,
    firstName: contactValues.contactPersonsFirstName,
    lastName: contactValues.contactPersonsLastName,
    addresses: buildXeroContactAddresses(contactValues),
    emailAddress: contactValues.emailAddress,
  };
}

async function ensureXeroContactForJob(contact, contactValues, workspaceId, boardId, itemId) {
  if (!contact) {
    await setIntegrationMessage(workspaceId, boardId, itemId, 'The contact does not exist in Xero, creating...');
    return createOrUpdateContact(buildXeroContactPayload(contactValues));
  }

  const xeroUpdatedDate = new Date(contact.updatedDateUTC);
  const isoplusUpdatedDate = new Date(contactValues.updatedAt);
  if (xeroUpdatedDate >= isoplusUpdatedDate) return contact;

  return createOrUpdateContact(buildXeroContactPayload(contactValues, contact.contactID));
}

router.post('/:workspaceId/:boardId/invoice', async (req, res) => {
  const { workspaceId, boardId } = req.params;

  const payload = req.body;
  const { item } = await validatePayload(payload, req);
  const mappedValues = mapInvoiceValuesToJobDTO(item.values);
  const { error: validationError } = ItemPayloadDTO.validate('Job', mappedValues);
  if (validationError) {
    await setIntegrationMessage(workspaceId, boardId, item.id,
      `ERROR: Invoice validation failed: ${JSON.stringify(validationError.details)}`);
    return res.status(200).json({
      message: 'Invoice validation failed',
      details: validationError.details
    });
  }

  try {
    const business = await initializeXeroOperation(workspaceId, boardId, item);

    const [jobPlanningValues, serviceFeeTypeValues] = await getJobReportingReferencedItems(workspaceId, boardId, item.id);
    if (!jobPlanningValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "Job planning information is required. Job reporting is missing a job planning reference.");
      throw new Error("Job planning information is required. Job reporting is missing a job planning reference.");
    }
    if (!serviceFeeTypeValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "Service fee type information is required. Job reporting is missing a service fee type reference.");
      throw new Error("Service fee type information is required. Job reporting is missing a service fee type reference.");
    }

    const [contactValues, jobTypeValues] = await getJobPlanningReferencedItems(workspaceId, boardId, jobPlanningValues.id);
    if (!contactValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "Client information is required. Job planning is missing a client reference.");
      throw new Error("Client information is required. Job planning is missing a client reference.");
    }

    let contact = await getContactByEmail(contactValues.emailAddress);
    contact = await ensureXeroContactForJob(contact, contactValues, workspaceId, boardId, item.id);

    if (!jobTypeValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "Job type information is required. Job planning is missing a job type reference.");
      throw new Error("Job type information is required. Job planning is missing a job type reference.");
    }

    const jobType = await findOrCreateItem(jobTypeValues.jobCode, jobTypeValues.jobType);
    const chart = await loadXeroChartOptions(workspaceId);
    const gstValue = item.values["GST"];
    const invoiceLineTax = resolveSalesLineMapping(
      business,
      'invoice',
      gstValue,
      chart.accounts
    );
    const salesAccountCode = invoiceLineTax.accountCode;
    const materialFeeAmount = getPayableMaterialFeeAmount(item.values);
    const materialLineTax = resolveMaterialSalesLine(
      business,
      'invoice',
      gstValue,
      chart.accounts
    );

    const mismatchResponse = await rejectIfAccountTaxMismatch({
      workspaceId,
      boardId,
      itemId: item.id,
      accountCode: salesAccountCode,
      taxType: invoiceLineTax.taxType,
      res,
      chart,
    });
    if (mismatchResponse) return mismatchResponse;

    if (materialFeeAmount > 0) {
      const materialMismatch = await rejectIfAccountTaxMismatch({
        workspaceId,
        boardId,
        itemId: item.id,
        accountCode: materialLineTax.accountCode || salesAccountCode,
        taxType: materialLineTax.taxType,
        res,
        chart,
      });
      if (materialMismatch) return materialMismatch;
    }

    const invoice = {
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference: jobPlanningValues.jobNumber,
      lineItems: [],
      lineAmountTypes: 'Exclusive',
      date: getDateOnlyIso(new Date(), business?.headOfficeTimezone || 'Australia/Sydney'),
      dueDate: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return getDateOnlyIso(d, business?.headOfficeTimezone || 'Australia/Sydney'); })(),
      status: "DRAFT"
    };

    const serviceFeeType = serviceFeeTypeValues.feeType;
    invoice.lineItems.push({
      itemCode: jobType.code,
      description: `${jobPlanningValues.jobTitle} - ${serviceFeeType} - ${item.values['Job Duration (Hrs.)']} Hrs.`,
      quantity: 1,
      unitAmount: item.values['Payable Service Fee($) - GST Excl.'],
      taxType: invoiceLineTax.taxType,
      accountCode: salesAccountCode
    });

    if (materialFeeAmount > 0) {
      invoice.lineItems.push(
        buildUsedMaterialLineItem(materialFeeAmount, materialLineTax, salesAccountCode)
      );
    }

    if (item.values['Other Payable Fee($) - GST Excl.'] > 0) {
      invoice.lineItems.push({
        description: "Other Payable Fee",
        quantity: 1,
        unitAmount: item.values['Other Payable Fee($) - GST Excl.'],
        taxType: invoiceLineTax.taxType,
        accountCode: salesAccountCode
      });
    }

    const createdInvoice = await createInvoice(invoice);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Your invoice has been created successfully in Xero.");

    logAuditTrail({
      workspaceId,
      action: "Create Xero Invoice",
      detail: `Invoice created successfully, invoice number: ${createdInvoice.invoiceNumber}`,
      req
    });

    await setGeneratedField(workspaceId, boardId, item.id, `${createdInvoice.invoiceNumber} (Xero)`);
    await saveInvoiceNumber(workspaceId, boardId, item.id, `${createdInvoice.invoiceNumber} (Xero)`, 'Xero');

    res.json(createdInvoice);
  } catch (err) {
    const result = await handleError(err, workspaceId, boardId, item, req, 'invoice');
    res.status(200).json(result.body);
  }
});

router.post('/:workspaceId/:boardId/invoicendis', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const { item } = await validatePayload(req.body, req);
  return handleXeroInvoicendis({
    req,
    res,
    workspaceId,
    boardId,
    item,
    initializeXeroOperation,
    handleError,
    saveInvoiceNumber,
    formatValue,
  });
});

router.post('/:workspaceId/:boardId/contact', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const { error, item } = await validatePayload(req.body, req);
  if (error) {
    return res.status(200).json({ message: error });
  }

  const contactValues = item.values;
  const mappedContact = {
    client: contactValues['Client'],
    typeOfClient: contactValues['Type Of Client'],
    contactPersonsFirstName: contactValues["Contact Person's First Name"],
    contactPersonsLastName: contactValues["Contact Person's Last Name"],
    emailAddress: contactValues['Email Address'],
    phoneNumber: contactValues['Phone Number'],
    paymentTerm: contactValues['Payment Term'],
    additionalNotes: contactValues['Additional Notes'],
    address: contactValues['Address'],
    suburb: contactValues['Suburb'],
    state: contactValues['State'],
    postcode: contactValues['Postcode'],
    xeroQuote: contactValues['Xero Quote'],
    xeroAccount: contactValues['Xero Account'],
    jobTitle: contactValues['Job Title'],
    issueDate: contactValues['Issue Date'],
    integrationValidation: contactValues['Integration Validation'],
    integrationMessage: contactValues['Integration Message'],
  };

  const { error: validationError } = ItemPayloadDTO.validate('Contact', mappedContact);
  if (validationError) {
    await setIntegrationMessage(workspaceId, boardId, item.id, `ERROR: Contact validation failed: ${JSON.stringify(validationError.details)}`);
    return res.status(200).json({ message: 'Contact validation failed', details: validationError.details });
  }

  try {
    await initializeXeroOperation(workspaceId, boardId, item);
    const existingContact = await getContactByEmail(contactValues['Email Address']);
    let contact;

    if (existingContact) {
      contact = await createOrUpdateContact({
        ...createContactPayload(contactValues),
        contactID: existingContact.contactID
      });
      await setIntegrationMessage(workspaceId, boardId, item.id, "Your contact has been updated successfully in Xero.");
    } else {
      contact = await createOrUpdateContact(createContactPayload(contactValues));
      await setIntegrationMessage(workspaceId, boardId, item.id, "Your contact has been created successfully in Xero.");
    }

    res.json(contact);
  } catch (err) {
    const result = await handleError(err, workspaceId, boardId, item, req, 'contact');
    res.status(200).json(result.body);
  }
});

router.post('/:workspaceId/:boardId/contractor', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const { error, item } = await validatePayload(req.body, req);
  if (error) {
    return res.status(200).json({ message: error });
  }

  const contractorValues = item.values;
  const mappedContractor = {
    Contractor: contractorValues['Contractor'],
    TypeOfContractor: contractorValues['Type Of Contractor'],
    ContactPersonsFirstName: contractorValues["Contact Person's First Name"],
    ContactPersonsLastName: contractorValues["Contact Person's Last Name"],
    EmailAddress: contractorValues['Email Address'],
    PhoneNumber: contractorValues['Phone Number'],
    PaymentTerm: contractorValues['Payment Term'],
    AdditionalNotes: contractorValues['Additional Notes'],
    Address: contractorValues['Address'],
    Suburb: contractorValues['Suburb'],
    State: contractorValues['State'],
    Postcode: contractorValues['Postcode'],
    IntegrationValidation: contractorValues['Integration Validation'],
    IntegrationMessage: contractorValues['Integration Message'],
  };

  const { error: validationError } = ItemPayloadDTO.validate('Contractor', mappedContractor);
  if (validationError) {
    await setIntegrationMessage(workspaceId, boardId, item.id, `ERROR: Contractor validation failed: ${JSON.stringify(validationError.details)}`);
    return res.status(200).json({ message: 'Contractor validation failed', details: validationError.details });
  }

  try {
    await initializeXeroOperation(workspaceId, boardId, item);
    const existingContact = await getContactByEmail(contractorValues['Email Address']);
    let contact;

    if (existingContact) {
      contact = await createOrUpdateContact({
        ...createContactPayload(contractorValues),
        contactID: existingContact.contactID
      });
      await setIntegrationMessage(workspaceId, boardId, item.id, "Your contractor has been updated successfully in Xero.");
    } else {
      contact = await createOrUpdateContact(createContactPayload(contractorValues));
      await setIntegrationMessage(workspaceId, boardId, item.id, "Your contractor has been created successfully in Xero.");
    }

    res.json(contact);
  } catch (err) {
    const result = await handleError(err, workspaceId, boardId, item, req, 'contractor');
    res.status(200).json(result.body);
  }
});

router.post('/:workspaceId/:boardId/quote', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const payload = req.body;
  const { item } = await validatePayload(payload, req);

  try {
    const business = await initializeXeroOperation(workspaceId, boardId, item);
    const quoteValues = item.values;

    const [contactValues, jobTypeValues] = await getQuoteReferencedItems(workspaceId, boardId, item.id);
    if (!contactValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "ERROR: Client information is required.");
      throw new Error("Client information is required.");
    }
    if (!jobTypeValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "ERROR: Job type information is required.");
      throw new Error("Job type information is required.");
    }

    let contact = await getContactByEmail(contactValues.emailAddress);
    if (!contact) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "The contact does not exist in Xero, creating...");
      contact = await createOrUpdateContact({
        name: contactValues.client,
        firstName: contactValues.contactPersonsFirstName,
        lastName: contactValues.contactPersonsLastName,
        addresses: [
          {
            addressType: 'POBOX',
            addressLine1: contactValues.address,
            city: contactValues.suburb,
            region: contactValues.state,
            postalCode: contactValues.postcode.toString()
          },
          {
            addressType: 'STREET',
            addressLine1: contactValues.address,
            city: contactValues.suburb,
            region: contactValues.state,
            postalCode: contactValues.postcode.toString()
          }
        ],
        emailAddress: contactValues.emailAddress
      });
    } else {
      const xeroUpdatedDate = new Date(contact.updatedDateUTC);
      const isoplusUpdatedDate = new Date(contactValues.updatedAt);

      if (xeroUpdatedDate < isoplusUpdatedDate) {
        contact = await createOrUpdateContact({
          contactID: contact.contactID,
          name: contactValues.client,
          firstName: contactValues.contactPersonsFirstName,
          lastName: contactValues.contactPersonsLastName,
          addresses: [
            {
              addressType: 'POBOX',
              addressLine1: contactValues.address,
              city: contactValues.suburb,
              region: contactValues.state,
              postalCode: contactValues.postcode.toString()
            },
            {
              addressType: 'STREET',
              addressLine1: contactValues.address,
              city: contactValues.suburb,
              region: contactValues.state,
              postalCode: contactValues.postcode.toString()
            }
          ],
          emailAddress: contactValues.emailAddress
        });
      }
    }

    const jobType = await findOrCreateItem(jobTypeValues.jobCode, jobTypeValues.jobType);
    const chart = await loadXeroChartOptions(workspaceId);
    const quoteGst = quoteValues['GST'];
    const quoteLineTax = resolveSalesLineMapping(
      business,
      'quote',
      quoteGst,
      chart.accounts,
      'quoteService'
    );
    const materialFeeAmount = getPayableMaterialFeeAmount(quoteValues);
    const materialLineTax = resolveMaterialSalesLine(
      business,
      'quote',
      quoteGst,
      chart.accounts
    );
    const quoteMismatch = await rejectIfAccountTaxMismatch({
      workspaceId,
      boardId,
      itemId: item.id,
      accountCode: quoteLineTax.accountCode,
      taxType: quoteLineTax.taxType,
      res,
      chart,
    });
    if (quoteMismatch) return quoteMismatch;
    if (materialFeeAmount > 0) {
      const materialMismatch = await rejectIfAccountTaxMismatch({
        workspaceId,
        boardId,
        itemId: item.id,
        accountCode: materialLineTax.accountCode || quoteLineTax.accountCode,
        taxType: materialLineTax.taxType,
        res,
        chart,
      });
      if (materialMismatch) return materialMismatch;
    }
    const jobDescription = quoteValues['Job Description']
      ? quoteValues['Job Description'].toString().replace(/<[^>]*>/g, '')
      : '';
    const lineItems = [
      {
        itemCode: jobType.code,
        description: `${quoteValues['Job Title']} - ${jobDescription}`,
        quantity: quoteValues.Quantity,
        unitAmount: quoteValues['Unit Price($) - GST Excl.'],
        taxType: quoteLineTax.taxType,
        accountCode: quoteLineTax.accountCode,
      },
    ];
    if (materialFeeAmount > 0) {
      lineItems.push(
        buildUsedMaterialLineItem(
          materialFeeAmount,
          materialLineTax,
          quoteLineTax.accountCode
        )
      );
    }
    const mappedQuote = {
      issueDate: quoteValues['Issue Date'],
      expiryDate: quoteValues['Expiry Date'],
      jobTitle: quoteValues['Job Title'],
      unitPrice: quoteValues['Unit Price($) - GST Excl.'],
      quantity: quoteValues.Quantity,
      jobDescription,
      quoteChecklist: lineItems.map((li) => li.description || ''),
    };
    const xeroQuote = {
      contact: { contactID: contact.contactID },
      date: quoteValues['Issue Date'],
      expiryDate: quoteValues['Expiry Date'],
      title: quoteValues['Job Title'],
      summary: jobDescription,
      lineItems,
    };

    const { error: validationError } = ItemPayloadDTO.validate('Quote', mappedQuote);
    if (validationError) {
      await setIntegrationMessage(workspaceId, boardId, item.id, `ERROR: Quote validation failed: ${JSON.stringify(validationError.details)}`);
      return res.status(200).json({ message: 'Quote validation failed', details: validationError.details });
    }

    const createdQuote = await createQuote(xeroQuote);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Your quote has been created successfully in Xero.");

    logAuditTrail({
      workspaceId,
      action: "Create Xero Quote",
      detail: `Quote created successfully, quote number: ${createdQuote.quoteNumber}`,
      req
    });

    await setGeneratedField(workspaceId, boardId, item.id, `${createdQuote.quoteNumber} (Xero)`);

    res.json(createdQuote);
  } catch (err) {
    const result = await handleError(err, workspaceId, boardId, item, req, 'quote');
    res.status(200).json(result.body);
  }
});

router.post('/:workspaceId/:boardId/quotendis', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const item = req.body.items?.[0];
  return handleXeroQuotendis({
    req,
    res,
    workspaceId,
    boardId,
    item,
    initializeXeroOperation,
    handleError,
    warn,
  });
});

router.post('/:workspaceId/:boardId/purchaseorder', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const payload = req.body;
  const { item } = await validatePayload(payload, req);

  try {
    const business = await initializeXeroOperation(workspaceId, boardId, item);

    const purchaseOrderValues = item.values;

    const [contractorValues, jobTypeValues] = await getPurchaseOrderReferencedItems(workspaceId, boardId, item.id);
    if (!contractorValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "ERROR: Contractor information is required. Purchase order is missing Contractor.");
      throw new Error("Contractor information is required. Purchase order is missing Contractor.");
    }
    if (!jobTypeValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "ERROR: Job type information is required. Purchase order is missing Job Type.");
      throw new Error("Job type information is required. Purchase order is missing Job Type.");
    }

    let contact = await getContactByEmail(contractorValues.emailAddress);
    if (!contact) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "The contact does not exist in Xero, creating...");
      contact = await createOrUpdateContact({
        name: contractorValues.contractor,
        firstName: contractorValues.contactPersonsFirstName,
        lastName: contractorValues.contactPersonsLastName,
        addresses: [
          {
            addressType: 'POBOX',
            addressLine1: contractorValues.address,
            city: contractorValues.suburb,
            region: contractorValues.state,
            postalCode: contractorValues.postcode.toString()
          },
          {
            addressType: 'STREET',
            addressLine1: contractorValues.address,
            city: contractorValues.suburb,
            region: contractorValues.state,
            postalCode: contractorValues.postcode.toString()
          }
        ],
        emailAddress: contractorValues.emailAddress
      });
    } else {
      const xeroUpdatedDate = new Date(contact.updatedDateUTC);
      const isoplusUpdatedDate = new Date(contractorValues.updatedAt);

      if (xeroUpdatedDate < isoplusUpdatedDate) {
        contact = await createOrUpdateContact({
          contactID: contact.contactID,
          name: contractorValues.contractor,
          firstName: contractorValues.contactPersonsFirstName,
          lastName: contractorValues.contactPersonsLastName,
          addresses: [
            {
              addressType: 'POBOX',
              addressLine1: contractorValues.address,
              city: contractorValues.suburb,
              region: contractorValues.state,
              postalCode: contractorValues.postcode.toString()
            },
            {
              addressType: 'STREET',
              addressLine1: contractorValues.address,
              city: contractorValues.suburb,
              region: contractorValues.state,
              postalCode: contractorValues.postcode.toString()
            }
          ],
          emailAddress: contractorValues.emailAddress
        });
      }
    }

    const jobType = await findOrCreateItem(jobTypeValues.jobCode, jobTypeValues.jobType);
    const chart = await loadXeroChartOptions(workspaceId);
    const poLineTax = resolveSalesLineMapping(
      business,
      'purchaseOrder',
      purchaseOrderValues['GST'],
      chart.accounts,
      undefined,
      { fallbackAccountType: 'EXPENSE', defaultAccountCode: undefined }
    );
    const poMismatch = await rejectIfAccountTaxMismatch({
      workspaceId,
      boardId,
      itemId: item.id,
      accountCode: poLineTax.accountCode,
      taxType: poLineTax.taxType,
      res,
      chart,
    });
    if (poMismatch) return poMismatch;

    const mappedPO = {
      clientsOrderNumber: purchaseOrderValues["Client's Order Number"],
      issueDate: purchaseOrderValues['Issue Date'],
      deliveryDate: purchaseOrderValues['Delivery Date'],
      jobTitle: purchaseOrderValues['Job Title'],
      unitPrice: purchaseOrderValues['Unit Price($) - GST Excl.'],
      quantity: purchaseOrderValues.Quantity,
      jobDescription: purchaseOrderValues['Job Description'],
    };
    const purchaseOrder = {
      contact: { contactID: contact.contactID },
      date: purchaseOrderValues['Issue Date'],
      deliveryDate: purchaseOrderValues['Delivery Date'],
      attentionTo: `${contractorValues.contactPersonsFirstName} ${contractorValues.contactPersonsLastName}`,
      deliveryAddress: `${contractorValues.address} ${contractorValues.suburb} ${contractorValues.state} ${contractorValues.postcode}`,
      telephone: contractorValues.phoneNumber,
      deliveryInstructions: `${purchaseOrderValues['Additional Notes'] ? purchaseOrderValues['Additional Notes'].replace(/<[^>]*>/g, '') : ''}`,
      lineItems: [
        {
          itemCode: jobType.code,
          description: `${purchaseOrderValues['Job Title']}${purchaseOrderValues['Job Description'] ? ` - ${purchaseOrderValues['Job Description'].replace(/<[^>]*>/g, '')}` : ''}`,
          quantity: purchaseOrderValues.Quantity,
          unitAmount: purchaseOrderValues['Unit Price($) - GST Excl.'],
          taxType: poLineTax.taxType,
          accountCode: poLineTax.accountCode,
        }
      ]
    };

    const { error: validationError } = ItemPayloadDTO.validate('PurchaseOrder', mappedPO);
    if (validationError) {
      await setIntegrationMessage(workspaceId, boardId, item.id, `ERROR: Purchase order validation failed: ${JSON.stringify(validationError.details)}`);
      return res.status(200).json({ message: 'Purchase order validation failed', details: validationError.details });
    }

    const createdPurchaseOrder = await createPurchaseOrder(purchaseOrder);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Your purchase order has been created successfully in Xero.");

    logAuditTrail({
      workspaceId,
      action: "Create Xero Purchase Order",
      detail: `Purchase order created successfully, PO number: ${createdPurchaseOrder.purchaseOrderNumber}`,
      req
    });
    await setGeneratedField(workspaceId, boardId, item.id, `${createdPurchaseOrder.purchaseOrderNumber} (Xero)`);
    res.json(createdPurchaseOrder);
  } catch (err) {
    const result = await handleError(err, workspaceId, boardId, item, req, 'purchase order');
    res.status(200).json(result.body);
  }
});

router.get("/redirect", async (req, res) => {
  try {
    await configure();
    const url = await getAuthUrl();
    res.json({ url });
  } catch (err) {
    error('Xero-Service', 'Error generating redirect URL', err);
    res.status(200).json({ message: 'Error generating redirect URL', error: err.message });
  }
});

router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const result = await callback(code, req.url);
    res.send(`
            <html>
                <body>
                    <script>
                        window.opener.postMessage(${JSON.stringify({ ...result, type: 'XERO_AUTH' })}, '*');
                        window.close();
                    </script>
                </body>
            </html>
        `);
  } catch (err) {
    error('Xero-Service', 'Error in Xero callback', err);
    res.status(200).send(`
            <html>
                <body>
                    <script>
                        window.opener.postMessage(${JSON.stringify({ success: false, message: 'Authentication failed', type: 'XERO_AUTH' })}, '*');
                        window.close();
                    </script>
                </body>
            </html>
        `);
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { tokenSet } = req.body;
    await configure();
    const newTokenSet = await refreshTokenSet(tokenSet);
    res.json({ tokenSet: newTokenSet });
  } catch (err) {
    error('Xero-Service', 'Error refreshing token', err);
    res.status(200).json({ message: 'Error refreshing token', error: err.message });
  }
});

router.post('/:workspaceId/:boardId/invoicendis-invoice-generator', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  return handleXeroInvoicendisInvoiceGenerator({
    req,
    res,
    workspaceId,
    boardId,
    saveInvoiceNumber,
    appendDateSuffix,
    error,
  });
});

router.post('/:workspaceId/:boardId/invoiceparticipanttax', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  return handleXeroInvoiceParticipantTax({
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
    error,
  });
});


export default router;