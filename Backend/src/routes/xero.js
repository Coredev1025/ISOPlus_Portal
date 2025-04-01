import express from 'express';
import dotenv from 'dotenv';
import { info, warn, error } from '../utils/logger.js';
import { validateItemBelongsToTenant, getJobReportingReferencedItems } from '../services/isoplus.js';
import { configure, createInvoice, createOrUpdateContact, createQuote, createPurchaseOrder, getAuthUrl, exchangeCode, refreshToken, callback } from '../services/xero.js';
import querystring from 'querystring';
import axios from 'axios';

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

  const result = await configure(clientId, clientSecret);
  info(`/test client id: ${clientId}, body: ${JSON.stringify(payload)}, return: ${JSON.stringify(result)}`);
  res.json({ message: 'Test endpoint executed successfully', result });
});

router.get('/hello', (req, res) => {
  res.send('Hello, World!');
});

router.post('/invoice', async (req, res) => {
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

    await validateItemBelongsToTenant(item.id);

    const { contact, jobType } = await getJobReportingReferencedItems(item.id);

    const invoice = {
      type: 'ACCREC',
      contact: { contactID: contact.contactID },
      reference: invoiceValues.reference,
      lineItems: invoiceValues.lineItems.map((lineItem) => ({
        description: lineItem.description,
        quantity: lineItem.quantity,
        unitAmount: lineItem.unitAmount,
        accountCode: lineItem.accountCode,
        taxType: lineItem.taxType,
      })),
      dueDate: invoiceValues.dueDate,
    };

    const createdInvoice = await createInvoice(clientId, invoice);
    res.json(createdInvoice);
  } catch (err) {
    error('Error creating invoice', err);
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

    const contact = {
      name: contactValues.client,
      emailAddress: contactValues.emailAddress,
      phones: [{ phoneType: 'DEFAULT', phoneNumber: contactValues.phoneNumber }],
      firstName: contactValues.contactPersonsFirstName,
      lastName: contactValues.contactPersonsLastName,
      addresses: [
        {
          addressType: 'POBOX',
          addressLine1: contactValues.address,
          city: contactValues.suburb,
          region: contactValues.state,
          postalCode: contactValues.postcode.toString(),
        },
        {
          addressType: 'STREET',
          addressLine1: contactValues.address,
          city: contactValues.suburb,
          region: contactValues.state,
          postalCode: contactValues.postcode.toString(),
        },
      ],
    };

    const updatedContact = await createOrUpdateContact(clientId, contact);
    res.json(updatedContact);
  } catch (err) {
    error('Error creating/updating contact', err);
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

    res.json({ message: 'Contractor created/updated successfully' });
  } catch (err) {
    error('Error creating/updating contractor', err);
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

    const quote = {
      contact: { contactID: quoteValues.contactID },
      lineItems: quoteValues.lineItems.map((lineItem) => ({
        description: lineItem.description,
        quantity: lineItem.quantity,
        unitAmount: lineItem.unitAmount,
        accountCode: lineItem.accountCode,
        taxType: lineItem.taxType,
      })),
      date: quoteValues.date,
      expiryDate: quoteValues.expiryDate,
    };

    const createdQuote = await createQuote(clientId, quote);
    res.json(createdQuote);
  } catch (err) {
    error('Error creating quote', err);
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

    const purchaseOrder = {
      contact: { contactID: purchaseOrderValues.contactID },
      lineItems: purchaseOrderValues.lineItems.map((lineItem) => ({
        description: lineItem.description,
        quantity: lineItem.quantity,
        unitAmount: lineItem.unitAmount,
        accountCode: lineItem.accountCode,
        taxType: lineItem.taxType,
      })),
      date: purchaseOrderValues.date,
      deliveryDate: purchaseOrderValues.deliveryDate,
    };

    const createdPurchaseOrder = await createPurchaseOrder(clientId, purchaseOrder);
    res.json(createdPurchaseOrder);
  } catch (err) {
    error('Error creating purchase order', err);
    res.status(500).json({ message: 'Error creating purchase order', error: err.message });
  }
});

router.get("/redirect", async (req, res) => {
  await configure(req.query.clientId, req.query.clientSecret, process.env.XERO_REDIRECT_URL);
  const url = await getAuthUrl();

  res.json({ url });
});

router.get('/callback', async (req, res) => {
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
});

router.get('/oauth', async (req, res) => {
  console.log('/oauth')
});

router.post('/refresh', async (req, res) => {
  const { clientId, clientSecret, tokenSet } = req.body;
  const redirectUri = `${process.env.APP_URL}/api/xero/callback`;

  try {
    await configure(clientId, clientSecret, redirectUri);
    const newTokenSet = await refreshToken(tokenSet);
    res.json({ tokenSet: newTokenSet });
  } catch (err) {
    error('Error refreshing token', err);
    res.status(500).json({ message: 'Error refreshing token', error: err.message });
  }
});

export default router;