import express from 'express';
import dotenv from 'dotenv';
import Business from '../models/Business.js';
import InvoiceNumber from '../models/InvoiceNumber.js';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { warn, error, extractContextFromReq } from '../utils/logger.js';
import { isEmpty } from '../utils/helpers.js';
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

// Import helper functions from webhook.js
const ATTRIBUTE_NAMES = {
    PARTICIPANT_PROFILE: 'Participant Profile',
};

const REF_ATTRIBUTE_NAMES = {
    PROFILE_BILLING_CONTACT: 'Billing Contact',
    PROFILE_BILLING_ADDRESS: 'Billing Address',
    PROFILE_ADDRESS: 'Address',
    PROFILE_SUBURB: 'Suburb',
    PROFILE_STATE: 'State',
    PROFILE_POSTCODE: 'Postcode',
    PROFILE_POST_CODE: 'Post Code',
};

async function bulkFetchReferenceItemsFromDB(workspaceId, boardId, itemIds) {
    if (!itemIds || itemIds.length === 0) return new Map();

    // Remove duplicates and nulls
    const uniqueIds = [...new Set(itemIds.filter(Boolean).map(id => {
        if (typeof id === 'object' && id.id) return id.id.toString();
        if (typeof id === 'object' && id) return id.toString();
        return id?.toString();
    }).filter(Boolean))];

    if (uniqueIds.length === 0) return new Map();

    // First try to fetch from the same board
    let items = await Item.find({
        workspaceId,
        boardId,
        itemId: { $in: uniqueIds }
    }).lean();

    // Build lookup map
    const itemMap = new Map();
    for (const item of items) {
        itemMap.set(item.itemId, item);
    }

    // Check if we're missing any items - they might be in other boards
    const foundIds = new Set(items.map(i => i.itemId));
    const missingIds = uniqueIds.filter(id => !foundIds.has(id));

    if (missingIds.length > 0) {
        // Fetch missing items from ANY board in the workspace
        const crossBoardItems = await Item.find({
            workspaceId,
            itemId: { $in: missingIds }
        }).lean();

        for (const item of crossBoardItems) {
            if (!itemMap.has(item.itemId)) {
                itemMap.set(item.itemId, item);
            }
        }
    }

    return itemMap;
}

function extractRefId(value) {
    if (!value) return null;
    if (Array.isArray(value) && value.length > 0) {
        const first = value[0];
        if (typeof first === 'object' && first.id) return first.id.toString();
        if (typeof first === 'string') return first;
        return first?.toString();
    }
    if (typeof value === 'object' && value.id) return value.id.toString();
    if (typeof value === 'string') return value;
    return value?.toString();
}

function getValueFromFlatData(item, attributeName) {
    if (!item?.data) return null;

    // Handle array of attribute names (try each until one is found)
    const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];

    for (const attrName of attributeNames) {
        // Check flat format (data.key)
        if (item.data[attrName] !== undefined && item.data[attrName] !== null) {
            return item.data[attrName];
        }
    }

    // Check values array format (data.values) - for older format support
    if (Array.isArray(item.data.values)) {
        for (const attrName of attributeNames) {
            const entry = item.data.values.find(v => v.attribute?.name === attrName);
            if (entry?.data !== undefined && entry?.data !== null) {
                return entry.data;
            }
        }
    }

    return null;
}

function getParticipantNameFromProfile(profileItem) {
    if (!profileItem) return null;

    // Try different name attributes
    const nameAttrs = [
        REF_ATTRIBUTE_NAMES.PROFILE_BILLING_CONTACT,
        'Full Name/Preferred Name',
        'Preferred Name',
        'First Name',
        'Last Name',
        'Name'
    ];

    const name = getValueFromFlatData(profileItem, nameAttrs);
    if (!name) return null;

    // Handle object format
    if (typeof name === 'object' && name.name) return name.name;
    return String(name);
}
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
  findOrCreateItem
} from '../services/xero.js';
import { Item as ItemPayloadDTO } from '../dto/itemsPayload.js';
import { logAuditTrail } from '../utils/auditLogger.js';

dotenv.config();
const router = express.Router();

async function validatePayload(payload, req) {
  if (!payload?.items?.length) {
    warn('Xero-Service', 'Received payload with empty items.', { payload }, extractContextFromReq(req));
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

async function initializeXeroOperation(workspaceId, boardId, item) {
  const business = await Business.findOne({ workspaceId: workspaceId.toString() });
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
    await InvoiceNumber.findOneAndUpdate(
      {
        itemId: itemId,
        workspaceId: workspaceId,
        boardId: boardId,
        type: type
      },
      {
        $set: {
          itemId: itemId,
          workspaceId: workspaceId,
          boardId: boardId,
          invoiceNumber: invoiceNumber,
          type: type,
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
    }, extractContextFromReq({}));
  }
}

function createContactPayload(values, isUpdate = false) {
  const basePayload = {
    name: values.client || values.Client || values.Contractor,
    phones: [{
      phoneType: 'DEFAULT',
      phoneNumber: values.phoneNumber || values['Phone Number'] || values.PhoneNumber
    }],
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
  error('Xero-Service', `Error processing ${entityType} in Xero`, err.message);
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
    await initializeXeroOperation(workspaceId, boardId, item);

    const [jobPlanningValues, serviceFeeTypeValues] = await getJobReportingReferencedItems(workspaceId, boardId, item.id);
    if (!jobPlanningValues) {
      setIntegrationMessage(workspaceId, boardId, item.id, "Job planning information is required. Job reporting is missing a job planning reference.");
      throw new Error("Job planning information is required. Job reporting is missing a job planning reference.");
    }
    if (!serviceFeeTypeValues) {
      setIntegrationMessage(workspaceId, boardId, item.id, "Service fee type information is required. Job reporting is missing a service fee type reference.");
      throw new Error("Service fee type information is required. Job reporting is missing a service fee type reference.");
    }

    const [contactValues, jobTypeValues] = await getJobPlanningReferencedItems(workspaceId, boardId, jobPlanningValues.id);
    if (!contactValues) {
      setIntegrationMessage(workspaceId, boardId, item.id, "Client information is required. Job planning is missing a client reference.");
      throw new Error("Client information is required. Job planning is missing a client reference.");
    }

    let contact = await getContactByEmail(contactValues.emailAddress);
    if (!contact) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "The contact does not exist in Xero, creating...");
      contact = await createOrUpdateContact({
        name: contactValues.client,
        phones: [{ phoneType: 'DEFAULT', phoneNumber: contactValues.phoneNumber }],
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
          phones: [{ phoneType: 'DEFAULT', phoneNumber: contactValues.phoneNumber }],
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

    if (!jobTypeValues) {
      setIntegrationMessage(workspaceId, boardId, item.id, "Job type information is required. Job planning is missing a job type reference.");
      throw new Error("Job type information is required. Job planning is missing a job type reference.");
    }

    const jobType = await findOrCreateItem(jobTypeValues.jobCode, jobTypeValues.jobType);
    let gst = item.values["GST"] == "10%" ? "10%" : "0%";
    const invoice = {
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference: jobPlanningValues.jobNumber,
      lineItems: [],
      date: new Date().toISOString().split('T')[0],
      dueDate: new Date(new Date().setDate(new Date().getDate() + 30)).toISOString().split('T')[0],
      status: "DRAFT"
    };

    const serviceFeeType = serviceFeeTypeValues.feeType;
    invoice.lineItems.push({
      itemCode: jobType.code,
      description: `${jobPlanningValues.jobTitle} - ${serviceFeeType} - ${item.values['Job Duration (Hrs.)']} Hrs.`,
      quantity: 1,
      unitAmount: item.values['Payable Service Fee($) - GST Excl.'],
      taxType: gst == "10%" ? "OUTPUT" : "EXEMPTOUTPUT",
    });

    if (item.values['Payable Material Fee($) - GST Excl.'] > 0) {
      invoice.lineItems.push({
        description: "Used Material/Part",
        quantity: 1,
        unitAmount: item.values['Payable Material Fee($) - GST Excl.'],
        taxType: gst == "10%" ? "OUTPUT" : "EXEMPTOUTPUT",
      });
    }

    if (item.values['Other Payable Fee($) - GST Excl.'] > 0) {
      invoice.lineItems.push({
        description: "Other Payable Fee",
        quantity: 1,
        unitAmount: item.values['Other Payable Fee($) - GST Excl.'],
        taxType: gst == "10%" ? "OUTPUT" : "EXEMPTOUTPUT",
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

  const payload = req.body;
  const { item } = await validatePayload(payload, req);
  const invoiceValues = item.values;
  const invoiceDate = invoiceValues["Invoice Date"];
  const dueDate = invoiceValues["Due Date"];

  try {
    await initializeXeroOperation(workspaceId, boardId, item);

    const [servicePlanValues, cancellationTypeValues, fundValues, participantProfileValues] = await getNDISMasterPlanReferencedItems(workspaceId, boardId, item.id);
    if (!servicePlanValues) {
      setIntegrationMessage(workspaceId, boardId, item.id, "Master plan information is required. Master plan is missing a master plan reference.");
      throw new Error("Master plan information is required. Master plan is missing a master plan reference.");
    }

    let { firstName, lastName } = participantProfileValues;
    firstName = firstName.trim();
    lastName = lastName.trim();
    let contact = await getContactByEmail(participantProfileValues.email);
    if (!contact) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "The contact does not exist in Xero, creating...");
      if(!firstName || !lastName) {
        throw new Error("First name and last name are required for NDIS invoice contact creation. Please ensure the participant profile contains both first and last name.");
      }
      contact = await createOrUpdateContact({
        name: participantProfileValues.fullName || firstName + ' ' + lastName,
        phones: [{ phoneType: 'DEFAULT', phoneNumber: participantProfileValues.Phone }],
        firstName: firstName,
        lastName: lastName,
        addresses: [
          {
            addressType: 'POBOX',
            addressLine1: participantProfileValues.address || ' ',
            city: participantProfileValues.suburb || ' ',
            region: participantProfileValues.state || ' ',
            postalCode: participantProfileValues.postcode?.toString() || ' '
          },
          {
            addressType: 'STREET',
            addressLine1: participantProfileValues.address || ' ',
            city: participantProfileValues.suburb || ' ',
            region: participantProfileValues.state || ' ',
            postalCode: participantProfileValues.postcode?.toString() || ' '
          }
        ],
        emailAddress: participantProfileValues.email
      });
    } else {
      const xeroUpdatedDate = new Date(contact.updatedDateUTC);
      const isoplusUpdatedDate = new Date(participantProfileValues.updatedAt);
      if (xeroUpdatedDate < isoplusUpdatedDate && firstName && lastName) {
        contact = await createOrUpdateContact({
          contactID: contact.contactID,
          name: participantProfileValues.fullName || firstName + ' ' + lastName,
          phones: [{ phoneType: 'DEFAULT', phoneNumber: participantProfileValues.Phone }],
          firstName: firstName,
          lastName: lastName,
          addresses: [
            {
              addressType: 'POBOX',
              addressLine1: participantProfileValues.address || ' ',
              city: participantProfileValues.suburb || ' ',
              region: participantProfileValues.state || ' ',
              postalCode: participantProfileValues.postcode?.toString() || ' '
            },
            {
              addressType: 'STREET',
              addressLine1: participantProfileValues.address || ' ',
              city: participantProfileValues.suburb || ' ',
              region: participantProfileValues.state || ' ',
              postalCode: participantProfileValues.postcode?.toString() || ' '
            }
          ],
          emailAddress: participantProfileValues.email
        });
      }
    }

    let lineItems = [];
    const gstType = "EXEMPTOUTPUT"; // GST Free for NDIS
    const nowISO = new Date().toISOString();
    const groupSize = Number(invoiceValues['Group Size']) || 1;

    const invoice = {
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference: item.values["Invoice Number"],
      lineItems: [],
      date: invoiceDate || nowISO,
      dueDate: dueDate || nowISO,
      status: "DRAFT"
    };

    if (invoiceValues['Job Status'] !== 'Cancelled') {
      // Line 1: Direct Support - Hour based
      if (servicePlanValues?.directSupportUnit === "Hour(H)") {
        const unitPrice1 = Number(servicePlanValues?.directSupportUnitPrice) / groupSize || 0;
        const itemNumber1 = servicePlanValues?.directSupportItemNumber || '';
        const itemName1 = servicePlanValues?.directSupportItemName || '';
        const startTime1 = invoiceValues["Actual Shift Start Date and Time"] ? new Date(invoiceValues["Actual Shift Start Date and Time"]).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const endTime1 = invoiceValues["Actual Shift End Date and Time"] ? new Date(invoiceValues["Actual Shift End Date and Time"]).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        let qty1 = 0;
        const actualShiftDuration1 = Number(invoiceValues["Actual Shift Duration(Hr.)"]);
        if (typeof actualShiftDuration1 === 'number' && !isNaN(actualShiftDuration1)) {
          qty1 = Number(actualShiftDuration1.toFixed(1));
        }
        const amount1 = formatValue(qty1 * unitPrice1);
        const amountValue1 = formatValue(Number(invoiceValues["Direct Support Value($) - Time Based Support"])) || 0;

        if (amountValue1 > 0) {
          let desc1 = itemName1;
          if (itemNumber1) {
            desc1 += ` - ${itemNumber1}`;
          }
          if (startTime1 && endTime1) {
            desc1 += ` - from ${startTime1} to ${endTime1}`;
          }
          if (desc1 == '') {
            desc1 = 'Direct Support - Hour based';
          }
          if (groupSize !== 1) {
            desc1 += ` - Group Size: ${groupSize}`;
          }
          if (servicePlanValues?.directSupportUnit) {
            desc1 += ` - Unit: ${servicePlanValues?.directSupportUnit}`;
          }

          if (parseFloat(formatValue(amountValue1)) != parseFloat(formatValue(amount1))) {
            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
          }

          lineItems.push({
            description: desc1,
            quantity: formatValue(qty1),
            unitAmount: unitPrice1,
            taxType: gstType
          });
        }
      }

      // Line 2: Direct Support - Non Hour based
      if (servicePlanValues?.directSupportUnit !== "Hour(H)") {
        const unitPrice2 = Number(servicePlanValues?.directSupportUnitPrice) || 0;
        const itemNumber2 = servicePlanValues?.directSupportItemNumber || '';
        const itemName2 = servicePlanValues?.directSupportItemName || '';
        const quantity2 = invoiceValues["Quantity (Direct Support - Non Time Based Support)"] || 0;
        const unit2 = servicePlanValues?.directSupportUnit || '';
        const qty2 = Number(quantity2) || 0;
        const amount2 = formatValue(qty2 * unitPrice2);
        const amountValue2 = formatValue(Number(invoiceValues["Direct Support Value($) - Non Time Based Support"])) || 0;

        if (amountValue2 > 0) {
          let desc2 = itemName2;
          if (itemNumber2) {
            desc2 += ` - ${itemNumber2}`;
          }
          if (quantity2 && unit2) {
            desc2 += ` - ${quantity2} ${unit2}`;
          }
          if (desc2 == '') {
            desc2 = 'Direct Support - NOT Hour based';
          }
          if (servicePlanValues?.directSupportUnit) {
            desc2 += ` - ${servicePlanValues?.directSupportUnit}`;
          }

          if (parseFloat(formatValue(amountValue2)) != parseFloat(formatValue(amount2))) {
            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
          }

          lineItems.push({
            description: desc2,
            quantity: formatValue(qty2),
            unitAmount: unitPrice2,
            taxType: gstType
          });
        }
      }

      // Line 3: Provider Travel - Non-Labour Cost
      const unitPrice3 = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
      const mileage3 = invoiceValues["Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a Vehicle is Used."] || '';
      const others3 = invoiceValues["Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied."] || '';
      const itemName3 = servicePlanValues?.providerTravelItemName || '';
      const itemNumber3 = servicePlanValues?.providerTravelItemNumber || '';
      const qty3 = Number(invoiceValues["Provider Travel - Non-Labour Cost Amount($)"]) || 0;
      const amount3 = formatValue(qty3 * unitPrice3);
      const amountValue3 = formatValue(Number(invoiceValues["Provider Travel - Non-Labour Cost Amount($)"]) * unitPrice3) || 0;

      if (amountValue3 > 0) {
        let desc3 = itemName3;
        if (itemNumber3) {
          desc3 += ` - ${itemNumber3}`;
        }
        if (mileage3) {
          desc3 += ` - ${mileage3}km`;
        }
        if (others3) {
          desc3 += ` - Others: ${others3}`;
        }
        if (desc3 == '') {
          desc3 = 'Provider Travel - Non-Labour Cost Item';
        }
        if (servicePlanValues?.nonLabourTravelUnit) {
          desc3 += ` - ${servicePlanValues?.nonLabourTravelUnit}`;
        }

        if (parseFloat(formatValue(amountValue3)) != parseFloat(formatValue(amount3))) {
          setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
          throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
        }

        lineItems.push({
          description: desc3,
          quantity: formatValue(qty3),
          unitAmount: unitPrice3,
          taxType: gstType
        });
      }

      // Line 4: Activity Based Transport
      const unitPrice4 = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
      const mileage4 = invoiceValues["Activity Base Transport Mileage(Kms) as per the Service Plan, if a Vehicle is Used."] || '';
      const others4 = invoiceValues["Activity Base Transport Costs as per the Service Plan, if other costs are applied."] || '';
      const itemName4 = servicePlanValues?.activityBasedTransportItemName || '';
      const itemNumber4 = servicePlanValues?.activityBasedTransportItemNumber || '';
      const qty4 = Number(invoiceValues["Activity Base Transport Amount($)"]) || 0;
      const amount4 = formatValue(qty4 * unitPrice4);
      const amountValue4 = formatValue(Number(invoiceValues["Activity Base Transport Amount($)"]) * unitPrice4) || 0;

      if (amountValue4 > 0) {
        let desc4 = itemName4;
        if (itemNumber4) {
          desc4 += ` - ${itemNumber4}`;
        }
        if (mileage4) {
          desc4 += ` - ${mileage4}km`;
        }
        if (others4) {
          desc4 += ` - Others: ${others4}`;
        }
        if (desc4 == '') {
          desc4 = 'Activity Based Transport Item';
        }
        if (servicePlanValues?.activityBasedTransportUnit) {
          desc4 += ` - ${servicePlanValues?.activityBasedTransportUnit}`;
        }

        if (parseFloat(formatValue(amountValue4)) != parseFloat(formatValue(amount4))) {
          setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
          throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
        }

        lineItems.push({
          description: desc4,
          quantity: formatValue(qty4),
          unitAmount: unitPrice4,
          taxType: gstType
        });
      }

      // Line 5: Centre Capital Costs
      const unitPrice5 = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
      const itemName5 = servicePlanValues?.centreCapitalCostsItemName || '';
      const itemNumber5 = servicePlanValues?.centreCapitalCostsItemNumber || '';
      let qty5 = 0;
      const actualShiftDuration5 = Number(invoiceValues["Actual Shift Duration(Hr.)"]);
      if (typeof actualShiftDuration5 === 'number' && !isNaN(actualShiftDuration5)) {
        qty5 = Number(actualShiftDuration5.toFixed(1));
      }
      const amount5 = formatValue(qty5 * unitPrice5);
      const amountValue5 = formatValue(Number(invoiceValues["Centre Capital Costs Amount($)"])) || 0;

      if (amountValue5 > 0) {
        let desc5 = itemName5;
        if (itemNumber5) {
          desc5 += ` - ${itemNumber5}`;
        }
        if (desc5 == '') {
          desc5 = 'Centre Capital Costs Item';
        }
        if (servicePlanValues?.centreCapitalCostsUnit) {
          desc5 += ` - ${servicePlanValues?.centreCapitalCostsUnit}`;
        }

        if (parseFloat(formatValue(amountValue5)) != parseFloat(formatValue(amount5))) {
          setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
          throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
        }

        lineItems.push({
          description: desc5,
          quantity: formatValue(qty5),
          unitAmount: unitPrice5,
          taxType: gstType
        });
      }

      // Line 6: Labour Travel Time
      const unitPrice6 = Number(servicePlanValues?.labourTravelTimeUnitPrice) || 0;
      const qty6 = Number(invoiceValues["Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable."]) || 0;
      const amount6 = formatValue(qty6 * unitPrice6);
      const amountValue6 = formatValue(Number(invoiceValues["Labour Travel Time Amount($)"])) || 0;

      if (amountValue6 > 0) {
        let desc6 = 'Provider Travel - Labour Travel Time Costs';
        if (servicePlanValues?.labourTravelTimeUnit) {
          desc6 += ` - ${servicePlanValues?.labourTravelTimeUnit}`;
        }

        if (parseFloat(formatValue(amountValue6)) != parseFloat(formatValue(amount6))) {
          setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
          throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
        }

        lineItems.push({
          description: desc6,
          quantity: formatValue(qty6),
          unitAmount: unitPrice6,
          taxType: gstType
        });
      }

      // Line 7: Allowances
      const unitPrice7 = Number(invoiceValues['Used Allowance Amount($) as per the Service Plan']) || 0;
      const qty7 = 1;
      const amount7 = unitPrice7;
      const amountValue7 = formatValue(Number(invoiceValues["Allowances Amount($)"])) || 0;

      if (amountValue7 > 0) {
        let desc7 = `Allowances - ${invoiceValues["Allowances"]}`;
        if (servicePlanValues?.usedAllowanceUnit) {
          desc7 += ` - ${servicePlanValues?.usedAllowanceUnit}`;
        }

        if (parseFloat(formatValue(amountValue7)) != parseFloat(formatValue(amount7))) {
          setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
          throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
        }


        lineItems.push({
          description: desc7,
          quantity: formatValue(qty7),
          unitAmount: unitPrice7,
          taxType: gstType
        });
      }

      // Line 8: Non-Face-to-Face Support
      const unitPrice8 = Number(servicePlanValues?.nonFaceToFaceSupportUnitPrice) || 0;
      const qty8 = Number(invoiceValues["Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)"]) || 0;
      const amount8 = formatValue(qty8 * unitPrice8);
      const amountValue8 = formatValue(Number(invoiceValues["Non-Face-to-Face Amount($)"])) || 0;

      if (amountValue8 > 0) {
        let desc8 = `Non-Face-to-Face Support - ${invoiceValues["Non-Face-to-Face Supports"]}`;
        if (servicePlanValues?.nonFaceToFaceSupportUnit) {
          desc8 += ` - ${servicePlanValues?.nonFaceToFaceSupportUnit}`;
        }

        if (parseFloat(formatValue(amountValue8)) != parseFloat(formatValue(amount8))) {
          setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
          throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
        }

        lineItems.push({
          description: desc8,
          quantity: formatValue(qty8),
          unitAmount: unitPrice8,
          taxType: gstType
        });
      }
    } else {
      if (!cancellationTypeValues) {
        setIntegrationMessage(workspaceId, boardId, item.id, "Cancellation Type Item not found");
        throw new Error("Cancellation Type Item not found");
      }
      const cancellationPercentage1 = Number(cancellationTypeValues?.billableToClient) || 0;
      const scheduledShiftDuration = (invoiceValues['Scheduled Shift Duration(Hr.)'] > 0)
        ? Number(invoiceValues['Scheduled Shift Duration(Hr.)']).toFixed(1)
        : 0;
      let totalCancellationFee = 0;
      const amountValue1 = formatValue(Number(invoiceValues["Cancellation Fee($)"])) || 0;
      if (servicePlanValues?.directSupportShortNoticeCancellations === 'Y') {
        // Line 1: Direct Support - Hour based (Cancelled)
        const baseUnitPrice1 = groupSize > 0 ? Number(servicePlanValues?.directSupportUnitPrice) / groupSize : 0;
        const itemName1 = servicePlanValues?.directSupportItemName || '';
        const itemNumber1 = servicePlanValues?.directSupportItemNumber || '';
        let qty1 = scheduledShiftDuration;
        let unitPrice1, amount1;
        if (servicePlanValues?.directSupportUnit === "Hour(H)") {
          unitPrice1 = Number(formatValue(baseUnitPrice1 * (cancellationPercentage1 / 100)));
        } else {
          const nonTimeBasedValue = Number(servicePlanValues.directSupportUnitPrice) || 0;
          unitPrice1 = Number(formatValue(nonTimeBasedValue * (cancellationPercentage1 / 100)));
          qty1 = Number(invoiceValues["Quantity (Direct Support - Non Time Based Support)"]) || 0;
        }

        amount1 = formatValue(qty1 * unitPrice1);

        if (amountValue1 > 0) {
          let desc1 = 'Cancellation Fee';
          if (itemName1) {
            desc1 += ` - ${itemName1}`;
          }
          if (itemNumber1) {
            desc1 += ` - ${itemNumber1}`;
          }
          desc1 += ` - ${cancellationPercentage1}%`;
          if (groupSize !== 1) {
            desc1 += ` - Group Size: ${groupSize}`;
          }

          if (servicePlanValues?.directSupportUnit) {
            desc1 += ` - Unit: ${servicePlanValues.directSupportUnit}`;
          }

          lineItems.push({
            description: desc1,
            quantity: formatValue(qty1),
            unitAmount: unitPrice1,
            taxType: gstType
          });
          totalCancellationFee += Number(amount1);
        }
      }
      if (servicePlanValues?.providerTravelShortNoticeCancellations === 'Y') {
        // Line 3: Provider Travel - Non-Labour Cost
        const baseUnitPrice3 = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
        const itemName3 = servicePlanValues?.providerTravelItemName || '';
        const itemNumber3 = servicePlanValues?.providerTravelItemNumber || '';
        const qty3 = scheduledShiftDuration;
        const unitPrice3 = Number(formatValue(baseUnitPrice3 * (cancellationPercentage1 / 100)));
        const amount3 = formatValue(qty3 * unitPrice3);

        if (amount3 > 0) {
          let desc3 = 'Cancellation Fee';
          if (itemName3) {
            desc3 += ` - ${itemName3}`;
          }
          if (itemNumber3) {
            desc3 += ` - ${itemNumber3}`;
          }
          desc3 += ` - ${cancellationPercentage1}%`;

          if (servicePlanValues?.nonLabourTravelUnit) {
            desc3 += ` - ${servicePlanValues.nonLabourTravelUnit}`;
          }

          lineItems.push({
            description: desc3,
            quantity: formatValue(qty3),
            unitAmount: unitPrice3,
            taxType: gstType
          });
          totalCancellationFee += Number(amount3);
        }
      }
      if (servicePlanValues?.activityBasedTransportShortNoticeCancellations === 'Y') {
        // Line 4: Activity Based Transport
        const baseUnitPrice4 = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
        const itemName4 = servicePlanValues?.activityBasedTransportItemName || '';
        const itemNumber4 = servicePlanValues?.activityBasedTransportItemNumber || '';
        const qty4 = scheduledShiftDuration;
        const unitPrice4 = Number(formatValue(baseUnitPrice4 * (cancellationPercentage1 / 100)));
        const amount4 = formatValue(qty4 * unitPrice4);

        if (amount4 > 0) {
          let desc4 = 'Cancellation Fee';
          if (itemName4) {
            desc4 += ` - ${itemName4}`;
          }
          if (itemNumber4) {
            desc4 += ` - ${itemNumber4}`;
          }
          desc4 += ` - ${cancellationPercentage1}%`;

          if (servicePlanValues?.activityBasedTransportUnit) {
            desc4 += ` - ${servicePlanValues.activityBasedTransportUnit}`;
          }

          lineItems.push({
            description: desc4,
            quantity: formatValue(qty4),
            unitAmount: unitPrice4,
            taxType: gstType
          });
          totalCancellationFee += Number(amount4);
        }
      }
      if (servicePlanValues?.centreCapitalCostsShortNoticeCancellations === 'Y') {
        // Line 5: Centre Capital Costs
        const baseUnitPrice5 = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
        const itemName5 = servicePlanValues?.centreCapitalCostsItemName || '';
        const itemNumber5 = servicePlanValues?.centreCapitalCostsItemNumber || '';
        let qty5 = scheduledShiftDuration;
        const unitPrice5 = Number(formatValue(baseUnitPrice5 * (cancellationPercentage1 / 100)));
        const amount5 = formatValue(qty5 * unitPrice5);

        if (baseUnitPrice5 > 0 && amount5 > 0) {
          let desc5 = 'Cancellation Fee';
          if (itemName5) {
            desc5 += ` - ${itemName5}`;
          }
          if (itemNumber5) {
            desc5 += ` - ${itemNumber5}`;
          }
          desc5 += ` - ${cancellationPercentage1}%`;

          if (servicePlanValues?.centreCapitalCostsUnit) {
            desc5 += ` - ${servicePlanValues.centreCapitalCostsUnit}`;
          }

          lineItems.push({
            description: desc5,
            quantity: formatValue(qty5),
            unitAmount: unitPrice5,
            taxType: gstType
          });
          totalCancellationFee += Number(amount5);
        }
      }
      if (parseFloat(formatValue(amountValue1)) != parseFloat(formatValue(totalCancellationFee))) {
        setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
        throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
      }
    }

    if (lineItems.length === 0) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "There is nothing to invoice!");
      return res.status(200).json({ message: "There is nothing to invoice!" });
    }

    invoice.lineItems = lineItems;

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
    await initializeXeroOperation(workspaceId, boardId, item);
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
        phones: [{ phoneType: 'DEFAULT', phoneNumber: contactValues.phoneNumber }],
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
          phones: [{ phoneType: 'DEFAULT', phoneNumber: contactValues.phoneNumber }],
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
    // let rawChecklist = quoteValues['Quote Checklist'];
    // let quoteChecklist = [];
    // if (Array.isArray(rawChecklist)) {
    //   quoteChecklist = rawChecklist.map(String);
    // } else if (typeof rawChecklist === 'string' && rawChecklist.trim() !== '') {
    //   quoteChecklist = [rawChecklist];
    // }
    const mappedQuote = {
      issueDate: quoteValues['Issue Date'],
      expiryDate: quoteValues['Expiry Date'],
      jobTitle: quoteValues['Job Title'],
      unitPrice: quoteValues['Unit Price($) - GST Excl.'],
      quantity: quoteValues.Quantity,
      jobDescription: quoteValues['Job Description'] ? quoteValues['Job Description'].toString().replace(/<[^>]*>/g, '') : '',
      quoteChecklist: lineItems,
    };
    const xeroQuote = {
      contact: { contactID: contact.contactID },
      date: quoteValues['Issue Date'],
      expiryDate: quoteValues['Expiry Date'],
      title: quoteValues['Job Title'],
      summary: quoteValues['Job Description'].toString().replace(/<[^>]*>/g, ''),
      lineItems: [
        {
          itemCode: jobType.code,
          description: `${quoteValues['Job Title']} - ${quoteValues['Job Description'].toString().replace(/<[^>]*>/g, '')}`,
          quantity: quoteValues.Quantity,
          unitAmount: quoteValues['Unit Price($) - GST Excl.'],
          taxType: quoteValues['GST'] == "10%" ? "OUTPUT" : "EXEMPTOUTPUT",
        }
      ]
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
  const payload = req.body;
  if (!payload.items || payload.items.length === 0) {
    warn('Xero-Service', 'Received payload with empty items.', { payload }, extractContextFromReq(req));
    return res.json('No items found in the payload.');
  }

  const item = payload.items[0];

  try {
    const business = await Business.findOne({ workspaceId });
    await initializeXeroOperation(workspaceId, boardId, item);
    const NDISQuoteValues = item.values;

    const [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues, providerTravelLabourTravelTime] = await getQuoteNDISReferencedItems(workspaceId, boardId, item.id);
    if (!serviceAreaValues) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "ERROR: Service Area value is required.");
      throw new Error("Service Area value is required.");
    }

    let contact = await getContactByEmail(NDISQuoteValues['Recipient Email']);
    if (!contact) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "The contact does not exist in Xero, creating...");
      contact = await createOrUpdateContact({
        name: NDISQuoteValues['Recipient of the Quote'],
        phones: [{ phoneType: 'DEFAULT', phoneNumber: NDISQuoteValues['Recipient Phone Number'] }],
        addresses: [
          {
            addressType: 'POBOX',
            addressLine1: NDISQuoteValues['Recipient Address'],
            city: NDISQuoteValues['Suburb'],
            region: NDISQuoteValues['State'],
            postalCode: NDISQuoteValues['Postcode'].toString()
          },
          {
            addressType: 'STREET',
            addressLine1: NDISQuoteValues['Recipient Address'],
            city: NDISQuoteValues['Suburb'],
            region: NDISQuoteValues['State'],
            postalCode: NDISQuoteValues['Postcode'].toString()
          }
        ],
        emailAddress: NDISQuoteValues['Recipient Email']
      });
    } else {
      const xeroUpdatedDate = new Date(contact.updatedDateUTC);
      const isoplusUpdatedDate = new Date(NDISQuoteValues.updatedAt);

      if (xeroUpdatedDate < isoplusUpdatedDate) {
        contact = await createOrUpdateContact({
          contactID: contact.contactID,
          name: NDISQuoteValues['Recipient of the Quote'],
          phones: [{ phoneType: 'DEFAULT', phoneNumber: NDISQuoteValues['Recipient Phone Number'] }],
          addresses: [
            {
              addressType: 'POBOX',
              addressLine1: NDISQuoteValues['Recipient Address'],
              city: NDISQuoteValues['Suburb'],
              region: NDISQuoteValues['State'],
              postalCode: NDISQuoteValues['Postcode'].toString()
            },
            {
              addressType: 'STREET',
              addressLine1: NDISQuoteValues['Recipient Address'],
              city: NDISQuoteValues['Suburb'],
              region: NDISQuoteValues['State'],
              postalCode: NDISQuoteValues['Postcode'].toString()
            }
          ],
          emailAddress: NDISQuoteValues['Recipient Email']
        });
      }
    }

    let lineItems = [];
    const gstType = "EXEMPTOUTPUT"; // GST Free for NDIS

    // 1. Direct Support
    if (NDISQuoteValues['Quantity (Direct Support)'] && NDISQuoteValues['Unit Price for Direct Support($)']) {
      lineItems.push({
        description: (`${NDISQuoteValues['Direct Support Item Number'] || ''}${directSupportValues && directSupportValues.itemName ? '-' + directSupportValues.itemName : ''}` || 'Direct Support') + (NDISQuoteValues['Unit (Direct Support)'] ? ' - ' + NDISQuoteValues['Unit (Direct Support)'] : ''),
        quantity: Number(NDISQuoteValues['Quantity (Direct Support)']) || 0,
        unitAmount: Number(NDISQuoteValues['Unit Price for Direct Support($)']) || 0,
        taxType: gstType,
      });
    }
    // 2. Provider Travel - Non-Labour Cost
    if (NDISQuoteValues['Quantity (Provider Travel)'] && NDISQuoteValues['Unit Price for Provider Travel($)']) {
      lineItems.push({
        description: (`${NDISQuoteValues['Provider Travel - Non-Labour Cost Item Number'] || ''}${providerTravelValues && providerTravelValues.itemName ? '-' + providerTravelValues.itemName : ''}` || 'Provider Travel - Non-Labour Cost') + (NDISQuoteValues['Unit (Provider Travel - Non-Labour Cost)'] ? ' - ' + NDISQuoteValues['Unit (Provider Travel - Non-Labour Cost)'] : ''),
        quantity: Number(NDISQuoteValues['Quantity (Provider Travel)']) || 0,
        unitAmount: Number(NDISQuoteValues['Unit Price for Provider Travel($)']) || 0,
        taxType: gstType,
      });
    }
    // 3. Activity Based Transport
    if (NDISQuoteValues['Quantity (Activity Based Transport)'] && NDISQuoteValues['Unit Price for Activity Based Transport($)']) {
      lineItems.push({
        description: (`${NDISQuoteValues['Activity Based Transport Item Number'] || ''}${activityBasedTransportValues && activityBasedTransportValues.itemName ? '-' + activityBasedTransportValues.itemName : ''}` || 'Activity Based Transport') + (NDISQuoteValues['Unit (Activity Based Transport)'] ? ' - ' + NDISQuoteValues['Unit (Activity Based Transport)'] : ''),
        quantity: Number(NDISQuoteValues['Quantity (Activity Based Transport)']) || 0,
        unitAmount: Number(NDISQuoteValues['Unit Price for Activity Based Transport($)']) || 0,
        taxType: gstType,
      });
    }
    // 4. Centre Capital Costs
    if (NDISQuoteValues['Quantity (Centre Capital Costs)'] && NDISQuoteValues['Unit Price for Centre Capital Costs($)']) {
      lineItems.push({
        description: (`${NDISQuoteValues['Centre Capital Costs Item'] || ''}${centreCapitalCostsValues && centreCapitalCostsValues.itemName ? '-' + centreCapitalCostsValues.itemName : ''}` || 'Centre Capital Costs') + (NDISQuoteValues['Unit (Centre Capital Costs)'] ? ' - ' + NDISQuoteValues['Unit (Centre Capital Costs)'] : ''),
        quantity: Number(NDISQuoteValues['Quantity (Centre Capital Costs)']) || 0,
        unitAmount: Number(NDISQuoteValues['Unit Price for Centre Capital Costs($)']) || 0,
        taxType: gstType,
      });
    }
    // 5. Provider Travel - Labour Travel Time Costs
    if (NDISQuoteValues['Quantity (Labour Travel Time)']) {
      lineItems.push({
        description: ('Provider Travel - Labour Travel Time Costs' + (providerTravelLabourTravelTime && providerTravelLabourTravelTime.itemName ? '-' + providerTravelLabourTravelTime.itemName : '') || 'Provider Travel - Labour Travel Time Costs') + (NDISQuoteValues['Unit (Labour Travel Time)'] ? ' - ' + NDISQuoteValues['Unit (Labour Travel Time)'] : ''),
        quantity: Number(NDISQuoteValues['Quantity (Labour Travel Time)']) || 0,
        unitAmount: Number(NDISQuoteValues['Unit Price for Labour Travel Time ($)']) || 1,
        taxType: gstType,
      });
    }
    // 6. Allowances
    if (NDISQuoteValues['Allowances'] && NDISQuoteValues['Allowances Amount($)']) {
      lineItems.push({
        description: isEmpty(NDISQuoteValues['Allowances']) ? 'Allowances' : `Allowances - ${NDISQuoteValues['Allowances']}` + (NDISQuoteValues['Unit (Allowances)'] ? ' - ' + NDISQuoteValues['Unit (Allowances)'] : ''),
        quantity: 1,
        unitAmount: Number(NDISQuoteValues['Allowances Amount($)']) || 0,
        taxType: gstType,
      });
    }
    // 7. Non-Face-to-Face Support
    if (NDISQuoteValues['Non-Face-to-Face Supports'] && NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) {
      lineItems.push({
        description: isEmpty(NDISQuoteValues['Non-Face-to-Face Supports']) ? 'Non-Face-to-Face Support' : `Non-Face-to-Face Support - ${NDISQuoteValues['Non-Face-to-Face Supports']}` + (NDISQuoteValues['Unit (Non-Face-to-Face Support)'] ? ' - ' + NDISQuoteValues['Unit (Non-Face-to-Face Support)'] : ''),
        quantity: Number(NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) || 0,
        unitAmount: Number(NDISQuoteValues['Unit Price for Non-Face-to-Face Support ($)']) || 1,
        taxType: gstType,
      });
    }

    // Fallbacks for required fields
    const firstLine = lineItems[0] || {};
    // Use current date in ISO format if missing
    const nowISO = new Date().toISOString();
    const mappedQuote = {
      issueDate: NDISQuoteValues['Issue Date'] || nowISO,
      expiryDate: NDISQuoteValues['Expiry Date'] || nowISO,
      jobTitle: NDISQuoteValues['Job Title'] || firstLine.description || '',
      unitPrice: NDISQuoteValues['Unit Price($) - GST Excl.'] || firstLine.unitAmount || 0,
      quantity: NDISQuoteValues.Quantity || firstLine.quantity || 0,
      jobDescription: NDISQuoteValues['Job Description'] ? NDISQuoteValues['Job Description'].toString().replace(/<[^>]*>/g, '') : (firstLine.description || ''),
      quoteChecklist: lineItems.map(li => li.description || ''),
    };

    const xeroQuote = {
      contact: { contactID: contact.contactID },
      date: NDISQuoteValues['Issue Date'] || nowISO,
      expiryDate: NDISQuoteValues['Expiry Date'] || nowISO,
      // title: NDISQuoteValues['Job Title'] || firstLine.description || '',
      // summary: NDISQuoteValues['Job Description'] ? NDISQuoteValues['Job Description'].toString().replace(/<[^>]*>/g, '') : (firstLine.description || ''),
      lineItems,
      terms: `Terms & Conditions\n- This quote remains valid until the expiry date indicated above.\n- Payment Terms: ${business && business.bankDetails && business.bankDetails.accountsReceivableTerms ? business.bankDetails.accountsReceivableTerms : ' '}\n- All prices are subject to change with prior notice.\n- A cancellation fee may apply as per the terms of the service agreement.`,
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

router.post('/:workspaceId/:boardId/purchaseorder', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const payload = req.body;
  const { item } = await validatePayload(payload, req);

  try {
    await initializeXeroOperation(workspaceId, boardId, item);

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
        phones: [{ phoneType: 'DEFAULT', phoneNumber: contractorValues.phoneNumber }],
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
          phones: [{ phoneType: 'DEFAULT', phoneNumber: contractorValues.phoneNumber }],
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
          taxType: purchaseOrderValues['GST'] == "10%" ? "INPUT" : "EXEMPTEXPENSES",
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

router.post('/:workspaceId/:boardId/invoiceparticipanttax', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const items = req.body.items || [];
  const participantName = req.body?.participantName || '';
  const invoiceDate = req.body?.invoiceDate || new Date().toISOString();
  const dueDate = req.body?.dueDate || '';
  const isLowCat = req.body?.isLowCat || false;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: "No items provided for invoice generation." });
  }

  if (!participantName && (!items[0]?.participant)) {
    return res.status(400).json({ message: "Participant name is required." });
  }

  try {
    const business = await Business.findOne({ workspaceId: workspaceId.toString() });
    if (!business) {
      throw new Error('Business not found');
    }

    await configure();
    await ensureAuthenticated(workspaceId);

    // Check if this is a Low-Cat board
    let boardLabel = '';
    if (!isLowCat) {
      // Check board label from database
      const board = await Board.findOne({ boardId: boardId.toString() }).lean();
      if (board?.label === 'Care Management - SaH - Low Cat') {
        boardLabel = board.label;
      }
    }
    const isLowCatBoard = isLowCat || boardLabel === 'Care Management - SaH - Low Cat';

    // Validate all items belong to the workspace/board
    for (const item of items) {
      await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    }

    // OPTIMIZED: Collect all reference IDs first, then bulk fetch from database
    const participantProfileIds = new Set();

    // Extract all reference IDs from items
    for (const item of items) {
      // Get participant profile ID from the actual database item
      const dbItem = await Item.findOne({ workspaceId, boardId, itemId: item.id.toString() }).lean();
      if (dbItem) {
        const participantProfileValue = getValueFromFlatData(dbItem, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
        const participantProfileId = extractRefId(participantProfileValue);
        if (participantProfileId) participantProfileIds.add(participantProfileId);
      }
    }

    // Bulk fetch all reference items from MongoDB (NO API calls!)
    const allRefIds = [...participantProfileIds];
    const refItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, allRefIds);

    // Get participant name from first item using database lookup
    let participantNameFromDB = ' ';
    let receiverName = ' ';
    let receiverAddress = ' ';

    if (items.length > 0) {
      const firstItem = await Item.findOne({ workspaceId, boardId, itemId: items[0].id.toString() }).lean();
      if (firstItem) {
        // Get Participant Profile reference from DB lookup map
        const participantProfileValue = getValueFromFlatData(firstItem, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
        const participantProfileId = extractRefId(participantProfileValue);

        if (participantProfileId) {
          const participantProfileItem = refItemsMap.get(participantProfileId);
          if (participantProfileItem) {
            // Use helper functions to get participant profile data
            const profileName = getParticipantNameFromProfile(participantProfileItem);
            participantNameFromDB = profileName || ' ';

            // Always try to get billing contact and billing address from participant profile
            // These are the preferred fields for the PDF template
            receiverName = getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_CONTACT) || ' ';
            const billingAddressBase = getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_ADDRESS) || ' ';

            // Get address info for fallback construction
            const addressInfo = {
              address: getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_ADDRESS) || ' ',
              suburb: getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_SUBURB) || ' ',
              state: getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_STATE) || '',
              postcode: getValueFromFlatData(participantProfileItem, [REF_ATTRIBUTE_NAMES.PROFILE_POSTCODE, REF_ATTRIBUTE_NAMES.PROFILE_POST_CODE]) || ' '
            };

            // For both SaH and SaH (Low-Cat), Billing Address in Xero must match
            // the Billing Address field in ISO+ exactly when it is present.
            if (billingAddressBase && billingAddressBase.trim() !== '') {
              receiverAddress = billingAddressBase.trim();
            } else {
              // If Billing Address is not available, construct a fallback from address fields
              let addressParts = [];
              if (addressInfo.address && addressInfo.address.trim() !== ' ') {
                addressParts.push(addressInfo.address.trim());
              }
              if (addressInfo.suburb && addressInfo.suburb.trim() !== ' ') {
                addressParts.push(addressInfo.suburb.trim());
              }
              if (addressInfo.state && addressInfo.state.trim() !== '') {
                addressParts.push(addressInfo.state.trim());
              }
              if (addressInfo.postcode && addressInfo.postcode.trim() !== ' ') {
                addressParts.push(addressInfo.postcode.trim());
              }
              receiverAddress = addressParts.filter(p => p).join(', ') || ' ';
            }
          }
        }
      }
    }

    // Get participant name - use from DB if available, fallback to request
    let effectiveParticipantName = participantNameFromDB && participantNameFromDB.trim() !== ' '
      ? participantNameFromDB.trim()
      : (participantName || items[0].participant || '');

    // Map client details to match template - both templates expect "Billing Contact" and "Billing Address"
    // Use billing contact/address from profile if available, otherwise fall back to participant name and address
    let billingContact = (receiverName && receiverName.trim() !== '' && receiverName.trim() !== ' ')
      ? receiverName.trim()
      : (effectiveParticipantName && effectiveParticipantName.trim() !== '' && effectiveParticipantName.trim() !== ' '
        ? effectiveParticipantName.trim()
        : ' ');

    let billingAddress = (receiverAddress && receiverAddress.trim() !== '' && receiverAddress.trim() !== ' ')
      ? receiverAddress.trim()
      : ' ';

    // Try to find or create contact in Xero
    let contact = null;
    const participantEmail = req.body?.participantEmail || '';

    if (participantEmail) {
      contact = await getContactByEmail(participantEmail);
    }

    // If contact not found by email, try to create one with available information
    if (!contact) {
      await setIntegrationMessage(workspaceId, boardId, items[0].id, "The contact does not exist in Xero, creating...");

      // Parse participant name into first and last name
      const nameParts = billingContact.trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      // Use Billing Address from ISO+ directly for the Xero contact Billing Address.
      // We keep the entire Billing Address string in addressLine1 and only use
      // city/region/postalCode as optional extras when available.
      const contactAddress = billingAddress || ' ';

      contact = await createOrUpdateContact({
        name: billingContact,
        firstName: firstName,
        lastName: lastName || firstName, // Use firstName as lastName if not provided
        phones: participantEmail ? [] : [{ phoneType: 'DEFAULT', phoneNumber: req.body?.participantPhone || '' }],
        addresses: [
          {
            addressType: 'POBOX',
            addressLine1: contactAddress || ' '
          },
          {
            addressType: 'STREET',
            addressLine1: contactAddress || ' '
          }
        ],
        emailAddress: participantEmail || undefined
      });
    }

    // Calculate due date if not provided
    let effectiveDueDate = dueDate;
    if (!effectiveDueDate) {
      const d = new Date(invoiceDate);
      d.setDate(d.getDate() + 14);
      effectiveDueDate = d.toISOString();
    }

    // Build line items from service records
    const lineItems = [];
    const gstType = isLowCatBoard ? "OUTPUT" : "EXEMPTOUTPUT"; // GST 10% for Low-Cat, GST Free for others
    let totalAmount = 0;

    for (const item of items) {
      // Use service from Service Records table (item.service) as the primary source for description
      // This matches what's shown in the Service Records table
      let description = '';
      if (item.service && typeof item.service === 'string' && item.service.trim()) {
        description = item.service.trim();
      } else if (item.notes && typeof item.notes === 'string' && item.notes.trim()) {
        // Fallback to notes if service is not available
        description = item.notes.replace(/<[^>]*>/g, '').trim();
      } else if (item.worker && typeof item.worker === 'string' && item.worker.trim()) {
        // Fallback to worker if neither service nor notes are available
        description = item.worker.trim();
      } else {
        // Final fallback
        description = 'Service';
      }

      const quantity = typeof item.quantity === 'number' ? item.quantity : Number(item.quantity || 0);
      const unitPrice = typeof item.unitPrice === 'number' ? item.unitPrice : Number(item.unitPrice || 0);
      const totalItemAmount = typeof item.totalAmount === 'number' ? item.totalAmount : Number(item.totalAmount || 0);

      // For Low-Cat, use total amount; for others, use participant contribution if available
      const lineAmount = isLowCatBoard
        ? totalItemAmount // For Low-Cat, use total amount
        : (typeof item.participantContribution === 'number' && item.participantContribution > 0
          ? item.participantContribution
          : totalItemAmount); // For others, use participant contribution or total amount

      if (lineAmount > 0) {
        // Calculate unit price: if quantity > 0, divide line amount by quantity; otherwise use the unitPrice from item
        const calculatedUnitPrice = quantity > 0 ? lineAmount / quantity : (unitPrice > 0 ? unitPrice : lineAmount);

        lineItems.push({
          description: description || 'Service',
          quantity: formatValue(quantity || 1),
          unitAmount: formatValue(calculatedUnitPrice),
          taxType: gstType
        });
        totalAmount += lineAmount;
      }
    }

    if (lineItems.length === 0) {
      await Promise.all(items.map(item =>
        setIntegrationMessage(workspaceId, boardId, item.id, "There is nothing to invoice!")
      ));
      return res.status(400).json({ message: "There is nothing to invoice!" });
    }

    // Create invoice in Xero
    const invoiceReference = isLowCatBoard
      ? `Tax Invoice - ${billingContact}`
      : `Participant Tax Invoice - ${billingContact}`;

    const invoice = {
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference: invoiceReference,
      lineItems: lineItems,
      date: invoiceDate,
      dueDate: effectiveDueDate,
      status: "DRAFT"
    };

    const createdInvoice = await createInvoice(invoice);

    // Update integration messages for all items
    const successMessage = isLowCatBoard
      ? "Your tax invoice has been created successfully in Xero."
      : "Your participant tax invoice has been created successfully in Xero.";

    await Promise.all(items.map(async (item) => {
      await setIntegrationMessage(workspaceId, boardId, item.id, successMessage);
      await setGeneratedField(workspaceId, boardId, item.id, `${createdInvoice.invoiceNumber} (Xero)`);
      await saveInvoiceNumber(workspaceId, boardId, item.id, `${createdInvoice.invoiceNumber} (Xero)`, 'Xero');
    }));

    const auditAction = isLowCatBoard
      ? "Create Xero Tax Invoice"
      : "Create Xero Participant Tax Invoice";

    logAuditTrail({
      workspaceId,
      action: auditAction,
      detail: `Invoice created successfully, invoice number: ${createdInvoice.invoiceNumber}, ${isLowCatBoard ? 'receiver' : 'participant'}: ${billingContact}, items: ${items.length}`,
      req
    });

    const responseMessage = isLowCatBoard
      ? "Tax Invoice generated successfully in Xero"
      : "Participant Tax Invoice generated successfully in Xero";

    res.status(200).json({
      message: responseMessage,
      invoiceNumber: createdInvoice.invoiceNumber,
      invoiceId: createdInvoice.invoiceID,
      invoiceUrl: createdInvoice.url,
      itemCount: items.length,
      participantName: billingContact
    });
  } catch (err) {
    const errorMessage = (err && err.message) ? err.message : 'Server error: An unknown error occurred. Please contact support via ISO+™ Portal.';
    error('Xero-Service', 'Error creating participant tax invoice in Xero', {
      message: errorMessage,
      workspaceId,
      boardId,
      itemCount: items.length
    }, extractContextFromReq(req));

    // Update integration messages for all items
    await Promise.all(items.map(async (item) => {
      await setIntegrationMessage(workspaceId, boardId, item.id, `Error: ${errorMessage}`);
    }));

    return res.status(500).json({ message: errorMessage });
  }
});

export default router;