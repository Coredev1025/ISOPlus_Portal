import { XeroClient } from 'xero-node';
import { info, error } from '../utils/logger.js'

let xeroClient = null;

// Configure the Xero client
export async function configure(clientId, clientSecret, redirectUri = null) {
  try {
    const config = {
      clientId: clientId,
      clientSecret: clientSecret,
      redirectUris: [process.env.XERO_REDIRECT_URL],
      scopes: 'openid profile email accounting.transactions offline_access'.split(" "),
    };

    if (redirectUri) {
      // OAuth 2.0 configuration
      config.grantType = 'authorization_code';
      config.redirectUris = [redirectUri];
    } else {
      // Client credentials configuration
      config.grantType = 'client_credentials';
    }

    xeroClient = new XeroClient(config);
    return xeroClient;
  } catch (err) {
    error('Error configuring Xero client', err);
    throw new Error('Error configuring Xero client');
  }
}

// Get OAuth URL for authorization
export async function getAuthUrl() {
  if (!xeroClient) {
    throw new Error('Xero client is not configured.');
  }

  const scopes = 'openid profile email accounting.transactions offline_access'.split(" ");
  const state = Math.random().toString(36).substring(7);
  const url = await xeroClient.buildConsentUrl(scopes, state);
  return url;
}

export async function callback(code, url) {
  try {
    // Exchange code for 
    await xeroClient.apiCallback(url); // Automatically stores tokens

    // Get access token, tenant ID
    const tokenSet = xeroClient.readTokenSet();
    const tenants = await xeroClient.updateTenants(false);

    console.log('🔑 TokenSet:', tokenSet);
    console.log('🏢 Tenants:', tenants);

    return { message: '✅ Successfully connected to Xero!' };
  } catch (error) {
    console.error('❌ Error:', error);
    return { message: 'Failed to authenticate.' };
  }
}

// Exchange authorization code for tokens
export async function exchangeCode(code) {
  try {
    if (!xeroClient) {
      throw new Error('Xero client is not configured.');
    }

    const tokenSet = await xeroClient.apiCallback(code);

    if (!tokenSet || !tokenSet.access_token) {
      throw new Error('Access token is undefined! Please ensure the authorization code is valid.');
    }

    return tokenSet;
  } catch (err) {
    error('Error exchanging authorization code', err);
    throw new Error('Error exchanging authorization code');
  }
}

// Refresh access token
export async function refreshToken(tokenSet) {
  try {
    if (!xeroClient) {
      throw new Error('Xero client is not configured.');
    }

    const newTokenSet = await xeroClient.refreshToken(tokenSet);
    return newTokenSet;
  } catch (err) {
    error('Error refreshing token', err);
    throw new Error('Error refreshing token');
  }
}

// Create an authorization token
export async function createToken() {
  try {
    if (!xeroClient) {
      throw new Error('Xero client is not configured.');
    }

    const token = await xeroClient.getClientCredentialsToken();
    const connections = await xeroClient.connections?.getConnections() || [];
    const xeroTenantId = connections[0]?.tenantId;

    return { token, xeroTenantId };
  } catch (err) {
    error('Error creating token', err);
    throw new Error('Error creating token');
  }
}

// Create an invoice in Xero
export async function createInvoice(invoice) {
  try {
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
  } catch (err) {
    error('Error creating invoice in Xero', err);
    throw new Error('Error creating invoice in Xero');
  }
}

// Get a contact by email
export async function getContactByEmail(email) {
  try {
    const { token, xeroTenantId } = await createToken();

    const response = await xeroClient.accountingApi.getContacts(
      token.access_token,
      xeroTenantId,
      null,
      `EmailAddress=="${email}"`
    );

    return response.body.contacts[0];
  } catch (err) {
    error('Error retrieving contact from Xero', err);
    throw new Error('Error retrieving contact from Xero');
  }
}

// Create or update a contact in Xero
export async function createOrUpdateContact(contact) {
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
  } catch (err) {
    error('Error creating or updating contact in Xero', err);
    throw new Error('Error creating or updating contact in Xero');
  }
}

// Find or create an item in Xero
export async function findOrCreateItem(itemCode, itemName) {
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
  } catch (err) {
    error('Error retrieving or creating item in Xero', err);
    throw new Error('Error retrieving or creating item in Xero');
  }
}

// Create a quote in Xero
export async function createQuote(quote) {
  try {
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
  } catch (err) {
    error('Error creating quote in Xero', err);
    throw new Error('Error creating quote in Xero');
  }
}

// Check if a quote exists in Xero
export async function quoteExists(quoteNumber) {
  try {
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
  } catch (err) {
    error('Error checking if quote exists in Xero', err);
    throw new Error('Error checking if quote exists in Xero');
  }
}

// Check if a purchase order exists in Xero
export async function purchaseOrderExists(purchaseOrderNumber) {
  try {
    const { token, xeroTenantId } = await createToken();

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
  } catch (err) {
    if (err.response && err.response.status === 40) {
      return false;
    }
    error('Error checking if purchase order exists in Xero', error);
    throw new Error('Error checking if purchase order exists in Xero');
  }
}

// Create a purchase order in Xero
export async function createPurchaseOrder(purchaseOrder) {
  try {
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
  } catch (err) {
    error('Error creating purchase order in Xero', err);
    throw new Error('Error creating purchase order in Xero');
  }
}