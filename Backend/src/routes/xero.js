import express from 'express';
import dotenv from 'dotenv';
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
  createInvoice,
  createOrUpdateContact,
  createQuote,
  createPurchaseOrder,
  getAuthUrl,
  exchangeCode,
  refreshToken,
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

router.post('/test', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  const payload = req.body;

  try {
    const result = await configure(clientId, clientSecret);
    info(`/test client id: ${clientId}, body: ${JSON.stringify(payload)}, return: ${JSON.stringify(result)}`);
    res.json({ message: 'Test endpoint executed successfully', result });
  } catch (err) {
    error('Error in test endpoint', err);
    res.status(500).json({ message: 'Error in test endpoint', error: err.message });
  }
});

router.get('/hello', (req, res) => {
  res.send('Hello, World!');
});

router.post('/:workspaceId/:boardId/invoice', async (req, res) => {
  const { workspaceId, boardId } = req.params;
  const { clientId, clientSecret } = req.body;
  const payload = req.body;

  try {
    await configure(clientId, clientSecret);

    if (!payload.items || payload.items.length === 0) {
      warn('Received payload with empty items.');
      return res.json('No items found in the payload.');
    }

    const item = payload.items[0];
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
      description: `${jobPlanningValues.jobTitle} - ${serviceFeeType} - ${invoiceValues.jobDurationHrs} Hrs.`,
      quantity: 1,
      unitAmount: invoiceValues.payableServiceFee,
      taxType: "OUTPUT",
    });

    if (invoiceValues.payableMaterialFee > 0) {
      invoice.lineItems.push({
        description: "Used Material/Part",
        quantity: 1,
        unitAmount: invoiceValues.payableMaterialFee,
        taxType: "EXEMPTOUTPUT",
      });
    }

    if (invoiceValues.otherPayableFee > 0) {
      invoice.lineItems.push({
        description: "Other Payable Fee",
        quantity: 1,
        unitAmount: invoiceValues.otherPayableFee,
        taxType: "OUTPUT",
      });
    }

    const createdInvoice = await createInvoice(invoice);
    await setIntegrationMessage(workspaceId, boardId, item.id, "Your invoice is successfully created.");

    res.json(createdInvoice);
  } catch (err) {
    error('Error creating invoice', err);
    if (payload.items[0]) {
      await setIntegrationMessage(workspaceId, boardId, payload.items[0].id, `ERROR: ${err.message}`);
    }
    res.status(500).json({ message: 'Error creating invoice', error: err.message });
  }
});

router.post('/contact', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  const payload = req.body;

  try {
    await configure(clientId, clientSecret);

    if (!payload.items || payload.items.length === 0) {
      warn('Received payload with empty items.');
      return res.json('No items found in the payload.');
    }

    const item = payload.items[0];
    const contactValues = item.values;

    await validateItemBelongsToTenant(item.id);
    await setIntegrationMessage(item.id, "Running...");

    const existingContact = await getContactByEmail(contactValues.emailAddress);
    let contact;

    if (existingContact) {
      existingContact.name = contactValues.client;
      existingContact.phones = [{ phoneType: 'DEFAULT', phoneNumber: contactValues.phoneNumber }];
      existingContact.firstName = contactValues.contactPersonsFirstName;
      existingContact.lastName = contactValues.contactPersonsLastName;
      existingContact.addresses = [
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
      ];
      existingContact.emailAddress = contactValues.emailAddress;

      contact = await createOrUpdateContact(existingContact);
      await setIntegrationMessage(item.id, "Your contact is successfully updated.");
    } else {
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
      await setIntegrationMessage(item.id, "Your contact is successfully created.");
    }

    res.json(contact);
  } catch (err) {
    error('Error creating/updating contact', err);
    if (item) {
      await setIntegrationMessage(item.id, "An error occurred while creating/updating the contact. Please contact support.");
    }
    res.status(500).json({ message: 'Error creating/updating contact', error: err.message });
  }
});

router.post('/contractor', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  const payload = req.body;

  try {
    await configure(clientId, clientSecret);

    if (!payload.items || payload.items.length === 0) {
      warn('Received payload with empty items.');
      return res.json('No items found in the payload.');
    }

    const item = payload.items[0];
    const contractorValues = item.values;

    await validateItemBelongsToTenant(item.id);
    await setIntegrationMessage(item.id, "Running...");

    const [contractorValuesFromRef, jobTypeValues] = await getPurchaseOrderReferencedItems(item.id);
    if (!contractorValuesFromRef) {
      throw new Error("Contractor information is required.");
    }

    const existingContact = await getContactByEmail(contractorValuesFromRef.emailAddress);
    let contact;

    if (existingContact) {
      existingContact.name = contractorValuesFromRef.contractor;
      existingContact.phones = [{ phoneType: 'DEFAULT', phoneNumber: contractorValuesFromRef.phoneNumber }];
      existingContact.firstName = contractorValuesFromRef.contactPersonsFirstName;
      existingContact.lastName = contractorValuesFromRef.contactPersonsLastName;
      existingContact.addresses = [
        {
          addressType: 'POBOX',
          addressLine1: contractorValuesFromRef.address,
          city: contractorValuesFromRef.suburb,
          region: contractorValuesFromRef.state,
          postalCode: contractorValuesFromRef.postcode.toString()
        },
        {
          addressType: 'STREET',
          addressLine1: contractorValuesFromRef.address,
          city: contractorValuesFromRef.suburb,
          region: contractorValuesFromRef.state,
          postalCode: contractorValuesFromRef.postcode.toString()
        }
      ];
      existingContact.emailAddress = contractorValuesFromRef.emailAddress;

      contact = await createOrUpdateContact(existingContact);
      await setIntegrationMessage(item.id, "Your contractor is successfully updated.");
    } else {
      contact = await createOrUpdateContact({
        name: contractorValuesFromRef.contractor,
        phones: [{ phoneType: 'DEFAULT', phoneNumber: contractorValuesFromRef.phoneNumber }],
        firstName: contractorValuesFromRef.contactPersonsFirstName,
        lastName: contractorValuesFromRef.contactPersonsLastName,
        addresses: [
          {
            addressType: 'POBOX',
            addressLine1: contractorValuesFromRef.address,
            city: contractorValuesFromRef.suburb,
            region: contractorValuesFromRef.state,
            postalCode: contractorValuesFromRef.postcode.toString()
          },
          {
            addressType: 'STREET',
            addressLine1: contractorValuesFromRef.address,
            city: contractorValuesFromRef.suburb,
            region: contractorValuesFromRef.state,
            postalCode: contractorValuesFromRef.postcode.toString()
          }
        ],
        emailAddress: contractorValuesFromRef.emailAddress
      });
      await setIntegrationMessage(item.id, "Your contractor is successfully created.");
    }

    res.json(contact);
  } catch (err) {
    error('Error creating/updating contractor', err);
    if (item) {
      await setIntegrationMessage(item.id, "An error occurred while creating/updating the contractor. Please contact support.");
    }
    res.status(500).json({ message: 'Error creating/updating contractor', error: err.message });
  }
});

router.post('/quote', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  const payload = req.body;

  try {
    await configure(clientId, clientSecret);

    if (!payload.items || payload.items.length === 0) {
      warn('Received payload with empty items.');
      return res.json('No items found in the payload.');
    }

    const item = payload.items[0];
    const quoteValues = item.values;

    await validateItemBelongsToTenant(item.id);
    await setIntegrationMessage(item.id, "Running...");

    const [contactValues, jobTypeValues] = await getQuoteReferencedItems(item.id);
    if (!contactValues) {
      throw new Error("Client information is required.");
    }
    if (!jobTypeValues) {
      throw new Error("Job Type is required.");
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

    const jobType = await findOrCreateItem(jobTypeValues.jobCode, jobTypeValues.jobType);

    const quote = {
      contact: { contactID: contact.contactID },
      date: quoteValues.issueDate,
      expiryDate: quoteValues.expiryDate,
      quoteNumber: quoteValues.quoteNumber,
      title: quoteValues.jobTitle,
      summary: quoteValues.jobDescription.replace(/<[^>]*>/g, ''),
      lineItems: [
        {
          itemCode: jobType.code,
          description: `${quoteValues.jobTitle} - ${quoteValues.jobDescription.replace(/<[^>]*>/g, '')}`,
          quantity: quoteValues.quantity,
          unitAmount: quoteValues.unitPrice,
          taxType: "OUTPUT",
        }
      ]
    };

    if (await quoteExists(quote.quoteNumber)) {
      await setIntegrationMessage(item.id, "WARN: A quote with the same number already exists.");
      return res.status(400).json({ message: "A quote with the same number already exists." });
    }

    const createdQuote = await createQuote(quote);
    await setIntegrationMessage(item.id, "Your quote is successfully created.");

    res.json(createdQuote);
  } catch (err) {
    error('Error creating quote', err);
    if (item) {
      await setIntegrationMessage(item.id, "An error occurred while creating the quote. Please contact support.");
    }
    res.status(500).json({ message: 'Error creating quote', error: err.message });
  }
});

router.post('/purchaseorder', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  const payload = req.body;

  try {
    await configure(clientId, clientSecret);

    if (!payload.items || payload.items.length === 0) {
      warn('Received payload with empty items.');
      return res.json('No items found in the payload.');
    }

    const item = payload.items[0];
    const purchaseOrderValues = item.values;

    await validateItemBelongsToTenant(item.id);
    await setIntegrationMessage(item.id, "Running...");

    const [contractorValues, jobTypeValues] = await getPurchaseOrderReferencedItems(item.id);
    if (!contractorValues) {
      throw new Error("Contractor information is required. Purchase order is missing Contractor.");
    }
    if (!jobTypeValues) {
      throw new Error("Job type information is required. Purchase order is missing Job Type.");
    }

    let contact = await getContactByEmail(contractorValues.emailAddress);
    if (!contact) {
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
      date: purchaseOrderValues.issueDate,
      deliveryDate: purchaseOrderValues.deliveryDate,
      purchaseOrderNumber: purchaseOrderValues.purchaseOrderNumber,
      attentionTo: `${contractorValues.contactPersonsFirstName} ${contractorValues.contactPersonsLastName}`,
      deliveryAddress: `${contractorValues.address} ${contractorValues.suburb} ${contractorValues.state} ${contractorValues.postcode}`,
      telephone: contractorValues.phoneNumber,
      lineItems: [
        {
          itemCode: jobType.code,
          description: `${purchaseOrderValues.jobTitle} - ${purchaseOrderValues.jobDescription.replace(/<[^>]*>/g, '')}`,
          quantity: purchaseOrderValues.quantity,
          unitAmount: purchaseOrderValues.unitPrice,
          taxType: "INPUT",
        }
      ]
    };

    if (await purchaseOrderExists(purchaseOrder.purchaseOrderNumber)) {
      await setIntegrationMessage(item.id, "WARN: A purchase order with the same number already exists.");
      return res.status(400).json({ message: "A purchase order with the same number already exists." });
    }

    const createdPurchaseOrder = await createPurchaseOrder(purchaseOrder);
    await setIntegrationMessage(item.id, "Your purchase order is successfully created.");

    res.json(createdPurchaseOrder);
  } catch (err) {
    error('Error creating purchase order', err);
    if (item) {
      await setIntegrationMessage(item.id, "An error occurred while creating the purchase order. Please contact support.");
    }
    res.status(500).json({ message: 'Error creating purchase order', error: err.message });
  }
});

router.get("/redirect", async (req, res) => {
  try {
    const { clientId, clientSecret } = req.query;
    await configure(clientId, clientSecret, process.env.XERO_REDIRECT_URL);
    const url = await getAuthUrl();
    res.json({ url });
  } catch (err) {
    error('Error generating redirect URL', err);
    res.status(500).json({ message: 'Error generating redirect URL', error: err.message });
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
                        window.opener.postMessage(${JSON.stringify({ ...result })}, '*');
                        window.close();
                    </script>
                </body>
            </html>
        `);
  } catch (err) {
    error('Error in Xero callback', err);
    res.status(500).send(`
            <html>
                <body>
                    <script>
                        window.opener.postMessage(${JSON.stringify({ success: false, message: 'Authentication failed' })}, '*');
                        window.close();
                    </script>
                </body>
            </html>
        `);
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { clientId, clientSecret, tokenSet } = req.body;
    const redirectUri = `${process.env.APP_URL}/api/xero/callback`;
    await configure(clientId, clientSecret, redirectUri);
    const newTokenSet = await refreshToken(tokenSet);
    res.json({ tokenSet: newTokenSet });
  } catch (err) {
    error('Error refreshing token', err);
    res.status(500).json({ message: 'Error refreshing token', error: err.message });
  }
});

export default router;