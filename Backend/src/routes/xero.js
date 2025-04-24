import express from 'express';
import dotenv from 'dotenv';
import Business from '../models/Business.js';
import { info, warn, error } from '../utils/logger.js';
import {
  validateItemBelongsToTenant,
  getJobReportingReferencedItems,
  getJobPlanningReferencedItems,
  getQuoteReferencedItems,
  getPurchaseOrderReferencedItems,
  setIntegrationMessage
} from '../services/isoplus.js';
import {
  configure,
  ensureAuthenticated,
  createInvoice,
  createOrUpdateContact,
  createQuote,
  quoteExists,
  createPurchaseOrder,
  purchaseOrderExists,
  getAuthUrl,
  exchangeCode,
  refreshTokenSet,
  callback,
  getContactByEmail,
  findOrCreateItem
} from '../services/xero.js';

dotenv.config();
const router = express.Router();

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
  if (!payload.items || payload.items.length === 0) {
    warn('Received payload with empty items.');
    return res.json('No items found in the payload.');
  }

  const item = payload.items[0];

  try {
    const business = await Business.findOne({ workspaceId });
    await configure();
    await ensureAuthenticated(business.xeroTokens.accessToken, business.xeroTokens.refreshToken, business.xeroTokens.expiresAt);
    const invoiceValues = item.values;

    await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

    const [jobPlanningValues, serviceFeeTypeValues] = await getJobReportingReferencedItems(workspaceId, boardId, item.id);
    if (!jobPlanningValues) {
      throw new Error("Job planning information is required. Job reporting is missing a job planning reference.");
    }
    if (!serviceFeeTypeValues) {
      throw new Error("Service fee type information is required. Job reporting is missing a service fee type reference.");
    }

    const [contactValues, jobTypeValues] = await getJobPlanningReferencedItems(workspaceId, boardId, jobPlanningValues.id);
    if (!contactValues) {
      throw new Error("Client information is required. Job planning is missing a client reference.");
    }

    let contact = await getContactByEmail(contactValues.emailAddress);
    if (!contact) {
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
    }

    if (!jobTypeValues) {
      throw new Error("Job type information is required. Job planning is missing a job type reference.");
    }

    const jobType = await findOrCreateItem(jobTypeValues.jobCode, jobTypeValues.jobType);

    const invoice = {
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference: jobPlanningValues.jobNumber,
      lineItems: [],
      dueDate: new Date(new Date().setDate(new Date().getDate() + 30)).toISOString().split('T')[0]
    };

    const serviceFeeType = serviceFeeTypeValues.feeType;
    invoice.lineItems.push({
      itemCode: jobType.code,
      description: `${jobPlanningValues.jobTitle} - ${serviceFeeType} - ${invoiceValues['Job Duration (Hrs.)']} Hrs.`,
      quantity: 1,
      accountCode: 4715,
      unitAmount: invoiceValues['Payable Service Fee($) - GST Excl.'],
      taxType: "OUTPUT",
    });

    if (invoiceValues.payableMaterialFee > 0) {
      invoice.lineItems.push({
        description: "Used Material/Part",
        quantity: 1,
        accountCode: 4715,
        unitAmount: invoiceValues['Payable Material Fee($) - GST Excl.'],
        taxType: "EXEMPTOUTPUT",
      });
    }

    if (invoiceValues.otherPayableFee > 0) {
      invoice.lineItems.push({
        description: "Other Payable Fee",
        quantity: 1,
        accountCode: 4715,
        unitAmount: invoiceValues['Other Payable Fee($) - GST Excl.'],
        taxType: "OUTPUT",
      });
    }

    const createdInvoice = await createInvoice(invoice);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Your invoice is successfully created.");

    res.json(createdInvoice);
  } catch (err) {
    error('Error creating invoice', err);
    let errorMessage = '';
    if (!err.message) {
      errorMessage = err.body.Message;
    } else {
      errorMessage = err.message
    }
    if (payload.items[0]) {
      await setIntegrationMessage(workspaceId, boardId, payload.items[0].id, `ERROR: ${errorMessage}`);
    }
    res.status(200).json({ message: 'Error creating invoice', error: errorMessage });
  }
});

router.post('/:workspaceId/:boardId/contact', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const payload = req.body;
  if (!payload.items || payload.items.length === 0) {
    warn('Received payload with empty items.');
    return res.json('No items found in the payload.');
  }

  const item = payload.items[0];

  try {
    const business = await Business.findOne({ workspaceId });
    await configure();
    await ensureAuthenticated(business.xeroTokens.accessToken, business.xeroTokens.refreshToken, business.xeroTokens.expiresAt);
    const contactValues = item.values;

    await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

    const existingContact = await getContactByEmail(contactValues['Email Address']);
    let contact;

    if (existingContact) {
      existingContact.name = contactValues.Client;
      existingContact.phones = [{ phoneType: 'DEFAULT', phoneNumber: contactValues['Phone Number'] }];
      existingContact.firstName = contactValues["Contact Person's First Name"];
      existingContact.lastName = contactValues["Contact Person's Last Name"];
      existingContact.addresses = [
        {
          addressType: 'POBOX',
          addressLine1: contactValues.Address,
          city: contactValues.Suburb,
          region: contactValues.State,
          postalCode: contactValues.Postcode.toString()
        },
        {
          addressType: 'STREET',
          addressLine1: contactValues.Address,
          city: contactValues.Suburb,
          region: contactValues.State,
          postalCode: contactValues.Postcode.toString()
        }
      ];
      existingContact.emailAddress = contactValues['Email Address'];

      contact = await createOrUpdateContact(existingContact);
      await setIntegrationMessage(workspaceId, boardId, item.id, "Your contact is successfully updated.");
    } else {
      contact = await createOrUpdateContact({
        name: contactValues.Client,
        phones: [{ phoneType: 'DEFAULT', phoneNumber: contactValues['Phone Number'] }],
        firstName: contactValues["Contact Person's First Name"],
        lastName: contactValues["Contact Person's Last Name"],
        addresses: [
          {
            addressType: 'POBOX',
            addressLine1: contactValues.Address,
            city: contactValues.Suburb,
            region: contactValues.State,
            postalCode: contactValues.Postcode.toString()
          },
          {
            addressType: 'STREET',
            addressLine1: contactValues.Address,
            city: contactValues.Suburb,
            region: contactValues.State,
            postalCode: contactValues.Postcode.toString()
          }
        ],
        emailAddress: contactValues['Email Address']
      });

      await setIntegrationMessage(workspaceId, boardId, item.id, "Your contact is successfully created.");
    }

    res.json(contact);
  } catch (err) {
    error('Error creating/updating contact', err);
    if (item) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "An error occurred while creating/updating the contact. Please contact support.");
    }
    res.status(200).json({ message: 'Error creating/updating contact', error: err.message });
  }
});

router.post('/:workspaceId/:boardId/contractor', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const payload = req.body;
  if (!payload.items || payload.items.length === 0) {
    warn('Received payload with empty items.');
    return res.json('No items found in the payload.');
  }

  const item = payload.items[0];

  try {
    const business = await Business.findOne({ workspaceId });
    await configure();
    await ensureAuthenticated(business.xeroTokens.accessToken, business.xeroTokens.refreshToken, business.xeroTokens.expiresAt);

    const contractorValues = item.values;

    await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

    const existingContact = await getContactByEmail(contractorValues['Email Address']);
    let contact;

    if (existingContact) {
      existingContact.name = contractorValues.Contractor;
      existingContact.phones = [{ phoneType: 'DEFAULT', phoneNumber: contractorValues['Phone Number'] }];
      existingContact.firstName = contractorValues["Contact Person's First Name"];
      existingContact.lastName = contractorValues["Contact Person's Last Name"];
      existingContact.addresses = [
        {
          addressType: 'POBOX',
          addressLine1: contractorValues.Address,
          city: contractorValues.Suburb,
          region: contractorValues.State,
          postalCode: contractorValues.Postcode.toString()
        },
        {
          addressType: 'STREET',
          addressLine1: contractorValues.Address,
          city: contractorValues.Suburb,
          region: contractorValues.State,
          postalCode: contractorValues.Postcode.toString()
        }
      ];
      existingContact.emailAddress = contractorValues['Email Address'];

      contact = await createOrUpdateContact(existingContact);
      await setIntegrationMessage(workspaceId, boardId, item.id, "Your contractor is successfully updated.");
    } else {
      contact = await createOrUpdateContact({
        name: contractorValues.Contractor,
        phones: [{ phoneType: 'DEFAULT', phoneNumber: contractorValues['Phone Number'] }],
        firstName: contractorValues["Contact Person's First Name"],
        lastName: contractorValues["Contact Person's Last Name"],
        addresses: [
          {
            addressType: 'POBOX',
            addressLine1: contractorValues.Address,
            city: contractorValues.Suburb,
            region: contractorValues.State,
            postalCode: contractorValues.Postcode.toString()
          },
          {
            addressType: 'STREET',
            addressLine1: contractorValues.Address,
            city: contractorValues.Suburb,
            region: contractorValues.State,
            postalCode: contractorValues.Postcode.toString()
          }
        ],
        emailAddress: contractorValues['Email Address']
      });
      await setIntegrationMessage(workspaceId, boardId, item.id, "Your contractor is successfully created.");
    }

    res.json(contact);
  } catch (err) {
    error('Error creating/updating contractor', err);
    if (item) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "An error occurred while creating/updating the contractor. Please contact support.");
    }
    res.status(200).json({ message: 'Error creating/updating contractor', error: err.message });
  }
});

router.post('/:workspaceId/:boardId/quote', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const payload = req.body;
  if (!payload.items || payload.items.length === 0) {
    warn('Received payload with empty items.');
    return res.json('No items found in the payload.');
  }

  const item = payload.items[0];

  try {
    const business = await Business.findOne({ workspaceId });
    await configure();
    await ensureAuthenticated(business.xeroTokens.accessToken, business.xeroTokens.refreshToken, business.xeroTokens.expiresAt);
    const quoteValues = item.values;

    await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

    const [contactValues, jobTypeValues] = await getQuoteReferencedItems(workspaceId, boardId, item.id);
    if (!contactValues) {
      throw new Error("Client information is required.");
    }
    if (!jobTypeValues) {
      throw new Error("Job Type is required.");
    }

    let contact = await getContactByEmail(contactValues.emailAddress);
    if (!contact) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "Creating a new contact...");
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
    }

    const jobType = await findOrCreateItem(jobTypeValues.jobCode, jobTypeValues.jobType);

    const quote = {
      contact: { contactID: contact.contactID },
      date: quoteValues['Issue Date'],
      expiryDate: quoteValues['Expiry Date'],
      quoteNumber: quoteValues['Quote Number'],
      title: quoteValues['Job Title'],
      summary: quoteValues['Job Description'].toString().replace(/<[^>]*>/g, ''),
      lineItems: [
        {
          itemCode: jobType.code,
          description: `${quoteValues['Job Title']} - ${quoteValues['Job Description'].toString().replace(/<[^>]*>/g, '')}`,
          quantity: quoteValues.Quantity,
          unitAmount: quoteValues['Unit Price($) - GST Excl.'],
          taxType: "OUTPUT",
        }
      ]
    };

    if (await quoteExists(quoteValues['Quote Number'])) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "WARN: A quote with the same number already exists.");
      return res.status(200).json({ message: "A quote with the same number already exists." });
    }

    const createdQuote = await createQuote(quote);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Your quote is successfully created.");

    res.json(createdQuote);
  } catch (err) {
    error('Error creating quote', err);
    if (item) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "An error occurred while creating the quote. Please contact support.");
    }
    res.status(200).json({ message: 'Error creating quote', error: err.message });
  }
});

router.post('/:workspaceId/:boardId/purchaseorder', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const payload = req.body;
  if (!payload.items || payload.items.length === 0) {
    warn('Received payload with empty items.');
    return res.json('No items found in the payload.');
  }

  const item = payload.items[0];

  try {
    const business = await Business.findOne({ workspaceId });
    await configure();
    await ensureAuthenticated(business.xeroTokens.accessToken, business.xeroTokens.refreshToken, business.xeroTokens.expiresAt);

    const purchaseOrderValues = item.values;

    await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

    const [contractorValues, jobTypeValues] = await getPurchaseOrderReferencedItems(workspaceId, boardId, item.id);
    if (!contractorValues) {
      throw new Error("Contractor information is required. Purchase order is missing Contractor.");
    }
    if (!jobTypeValues) {
      throw new Error("Job type information is required. Purchase order is missing Job Type.");
    }

    let contact = await getContactByEmail(contractorValues.emailAddress);
    if (!contact) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "Creating a new contact...");
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
    }
 
    const jobType = await findOrCreateItem(jobTypeValues.jobCode, jobTypeValues.jobType);

    const purchaseOrder = {
      contact: { contactID: contact.contactID },
      date: purchaseOrderValues['Issue Date'],
      deliveryDate: purchaseOrderValues['Delivery Date'],
      purchaseOrderNumber: purchaseOrderValues['PO Number'],
      attentionTo: `${contractorValues.contactPersonsFirstName} ${contractorValues.contactPersonsLastName}`,
      deliveryAddress: `${contractorValues.address} ${contractorValues.suburb} ${contractorValues.state} ${contractorValues.postcode}`,
      telephone: contractorValues.phoneNumber,
      lineItems: [
        {
          itemCode: jobType.code,
          description: `${purchaseOrderValues['Job Title']} - ${purchaseOrderValues['Job Description'].replace(/<[^>]*>/g, '')}`,
          quantity: purchaseOrderValues.Quantity,
          unitAmount: purchaseOrderValues['Unit Price($) - GST Excl.'],
          taxType: "INPUT",
        }
      ]
    };

    if (await purchaseOrderExists(purchaseOrder.purchaseOrderNumber)) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "WARN: A purchase order with the same number already exists.");
      return res.status(200).json({ message: "A purchase order with the same number already exists." });
    }

    const createdPurchaseOrder = await createPurchaseOrder(purchaseOrder);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Your purchase order is successfully created.");

    res.json(createdPurchaseOrder);
  } catch (err) {
    error('Error creating purchase order', err);
    if (item) {
      await setIntegrationMessage(workspaceId, boardId, item.id, "An error occurred while creating the purchase order. Please contact support.");
    }
    res.status(200).json({ message: 'Error creating purchase order', error: err.message });
  }
});

router.get("/redirect", async (req, res) => {
  try {
    await configure();
    const url = await getAuthUrl();
    res.json({ url });
  } catch (err) {
    error('Error generating redirect URL', err);
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
    error('Error in Xero callback', err);
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
    error('Error refreshing token', err);
    res.status(200).json({ message: 'Error refreshing token', error: err.message });
  }
});

export default router;