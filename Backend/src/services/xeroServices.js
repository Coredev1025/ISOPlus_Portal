import { XeroClient } from 'xero-node';

let xeroClient = null;

// Configure the Xero client
async function configure(clientId, configuration) {
  const clientConfig = configuration[`Integrations:${clientId}`];
  if (!clientConfig) {
    throw new Error('Client configuration not found.');
  }

  xeroClient = new XeroClient({
    clientId: clientConfig['Xero:ClientId'],
    clientSecret: clientConfig['Xero:ClientSecret'],
    grantType: 'client_credentials',
  });
}

// Create an authorization token
async function createToken() {
  if (!xeroClient) {
    throw new Error('Xero client is not configured.');
  }

  const token = await xeroClient.getClientCredentialsToken();
  const connections = await xeroClient.connections.getConnections();
  const xeroTenantId = connections[0].tenantId;

  return { token, xeroTenantId };
}

// Create an invoice in Xero
async function createInvoice(invoice) {
  const { token, xeroTenantId } = await createToken();

  const invoices = {
    invoices: [
      {
        type: invoice.type,
        contact: { contactID: invoice.contactID },
        dueDate: invoice.dueDate,
        lineItems: invoice.lineItems.map((lineItem) => ({
          description: lineItem.description,
          quantity: lineItem.quantity,
          unitAmount: lineItem.unitAmount,
          accountCode: lineItem.accountCode,
          taxType: lineItem.taxType,
          taxAmount: lineItem.taxAmount,
        })),
        status: 'AUTHORISED',
      },
    ],
  };

  const createdInvoices = await xeroClient.accountingApi.createInvoices(
    token.access_token,
    xeroTenantId,
    invoices
  );

  return createdInvoices.body.invoices[0];
}

// Get a contact by email
async function getContactByEmail(email) {
  try {
    const { token, xeroTenantId } = await createToken();

    const response = await xeroClient.accountingApi.getContacts(
      token.access_token,
      xeroTenantId,
      null,
      `EmailAddress=="${email}"`
    );

    return response.body.contacts[0];
  } catch (error) {
    winston.error('Error retrieving contact from Xero', error);
    throw new Error('Error retrieving contact from Xero');
  }
}

// Create or update a contact in Xero
async function createOrUpdateContact(contact) {
  try {
    const { token, xeroTenantId } = await createToken();

    const contacts = {
      contacts: [contact],
    };

    let response;
    if (!contact.contactID) {
      response = await xeroClient.accountingApi.createContacts(
        token.access_token,
        xeroTenantId,
        contacts
      );
    } else {
      response = await xeroClient.accountingApi.updateContact(
        token.access_token,
        xeroTenantId,
        contact.contactID,
        contacts
      );
    }

    return response.body.contacts[0];
  } catch (error) {
    winston.error('Error creating or updating contact in Xero', error);
    throw new Error('Error creating or updating contact in Xero');
  }
}

// Find or create an item in Xero
async function findOrCreateItem(itemCode, itemName) {
  try {
    const { token, xeroTenantId } = await createToken();

    const response = await xeroClient.accountingApi.getItems(
      token.access_token,
      xeroTenantId,
      null,
      `Code=="${itemCode}"`
    );

    const item = response.body.items[0];
    if (item) {
      return item;
    }

    const newItem = {
      code: itemCode,
      name: itemName,
    };

    const createdItems = await xeroClient.accountingApi.createItems(
      token.access_token,
      xeroTenantId,
      { items: [newItem] }
    );

    return createdItems.body.items[0];
  } catch (error) {
    winston.error('Error retrieving or creating item in Xero', error);
    throw new Error('Error retrieving or creating item in Xero');
  }
}

// Create a quote in Xero
async function createQuote(quote) {
  const { token, xeroTenantId } = await createToken();

  const quotes = {
    quotes: [quote],
  };

  const createdQuotes = await xeroClient.accountingApi.createQuotes(
    token.access_token,
    xeroTenantId,
    quotes
  );

  return createdQuotes.body.quotes[0];
}

// Check if a quote exists in Xero
async function quoteExists(quoteNumber) {
  const { token, xeroTenantId } = await createToken();

  const response = await xeroClient.accountingApi.getQuotes(
    token.access_token,
    xeroTenantId,
    null,
    null,
    null,
    null,
    null,
    null,
    quoteNumber
  );

  return response.body.quotes.length > 0;
}

// Check if a purchase order exists in Xero
async function purchaseOrderExists(purchaseOrderNumber) {
  const { token, xeroTenantId } = await createToken();

  try {
    const response = await xeroClient.accountingApi.getPurchaseOrders(
      token.access_token,
      xeroTenantId,
      null,
      null,
      null,
      null,
      null,
      null,
      purchaseOrderNumber
    );

    return response.body.purchaseOrders.length > 0;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return false;
    }
    throw error;
  }
}

// Create a purchase order in Xero
async function createPurchaseOrder(purchaseOrder) {
  const { token, xeroTenantId } = await createToken();

  const purchaseOrders = {
    purchaseOrders: [purchaseOrder],
  };

  const createdPurchaseOrders = await xeroClient.accountingApi.createPurchaseOrders(
    token.access_token,
    xeroTenantId,
    purchaseOrders
  );

  return createdPurchaseOrders.body.purchaseOrders[0];
}

module.exports = {
  configure,
  createInvoice,
  getContactByEmail,
  createOrUpdateContact,
  findOrCreateItem,
  createQuote,
  quoteExists,
  purchaseOrderExists,
  createPurchaseOrder,
};