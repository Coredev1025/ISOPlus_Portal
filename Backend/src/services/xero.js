import { XeroClient } from 'xero-node';
import { info, error } from '../utils/logger.js';

let xeroClient = null;

export async function configure(clientId, clientSecret, redirectUri = null) {
    try {
        const config = {
            clientId: clientId,
            clientSecret: clientSecret,
            scopes: 'openid profile email accounting.transactions offline_access'.split(" "),
        };

        if (redirectUri) {
            config.grantType = 'authorization_code';
            config.redirectUris = [redirectUri];
        } else {
            config.grantType = 'client_credentials';
        }

        xeroClient = new XeroClient(config);
        return xeroClient;
    } catch (err) {
        error('Error configuring Xero client', err);
        throw new Error('Error configuring Xero client');
    }
}

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
        await xeroClient.apiCallback(url);
        const tokenSet = xeroClient.readTokenSet();
        const tenants = await xeroClient.updateTenants(false);
        return { success: true, message: 'Successfully connected to Xero!', tokenSet, tenants };
    } catch (err) {
        error('Error in Xero callback', err);
        return { success: false, message: 'Failed to authenticate.' };
    }
}

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

export async function createToken() {
    try {
        if (!xeroClient) {
            throw new Error('Xero client is not configured.');
        }

        const token = await xeroClient.getClientCredentialsToken();
        const connections = await xeroClient.connections?.getConnections() || [];
        const xeroTenantId = connections[0]?.tenantId;
        console.log(token, xeroTenantId)
        return { token, xeroTenantId };
    } catch (err) {
        error('Error creating token', err);
        throw new Error('Error creating token');
    }
}

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
        if (err.response && err.response.status === 404) {
            return false;
        }
        error('Error checking if purchase order exists in Xero', err);
        throw new Error('Error checking if purchase order exists in Xero');
    }
}

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