import { XeroClient } from 'xero-node';
import Business from '../models/Business.js';
import { error } from '../utils/logger.js';
import {
    IsoPlusInvoiceValues
} from '../dto/itemsPayload.js';

let xeroClient = null;

export async function configure() {
    try {
        const config = {
            clientId: process.env.XERO_CLIENT_ID,
            clientSecret: process.env.XERO_CLIENT_SECRET,
            scopes: 'openid profile email accounting.settings accounting.contacts accounting.transactions accounting.reports.read accounting.attachments offline_access'.split(" "),
        };

        if (process.env.XERO_REDIRECT_URL) {
            config.grantType = 'authorization_code';
            config.redirectUris = [process.env.XERO_REDIRECT_URL];
        } else {
            config.grantType = 'client_credentials';
        }

        xeroClient = new XeroClient(config);
        return xeroClient;
    } catch (err) {
        error('Xero-Service', 'Error configuring Xero client', err);
        throw new Error('Error configuring Xero client');
    }
}

export async function getAuthUrl() {
    if (!xeroClient) {
        throw new Error('Xero client is not configured.');
    }

    const scopes = 'openid profile email accounting.settings accounting.contacts accounting.transactions accounting.reports.read accounting.attachments offline_access'.split(" ");
    const state = Math.random().toString(36).substring(7);
    const url = await xeroClient.buildConsentUrl(scopes, state);
    return url;
}

export async function callback(code, url) {
    try {
        await xeroClient.apiCallback(url);
        const tokenSet = xeroClient.readTokenSet();
        const tenants = await xeroClient.updateTenants(false);
        
        // Get organization information
        let organizationInfo = null;
        if (tenants && tenants.length > 0) {
            organizationInfo = await getOrganizationInfo(tenants[0].tenantId);
        }
        
        return {
            success: true,
            message: 'Successfully connected to Xero!',
            tokenSet,
            tenants,
            organization: organizationInfo
        };
    } catch (err) {
        error('Xero-Service', 'Error in Xero callback', err);
        return {
            success: false,
            message: 'Failed to authenticate: ' + err.message
        };
    }
}

export async function getOrganizationInfo(tenantId) {
    try {
        if (!xeroClient) {
            throw new Error('Xero client is not configured.');
        }

        // Get organization details using the accounting API
        const response = await xeroClient.accountingApi.getOrganisations(tenantId);
        
        if (response.body.organisations && response.body.organisations.length > 0) {
            const org = response.body.organisations[0];
            return {
                name: org.name,
                legalName: org.legalName,
                shortCode: org.shortCode,
                organisationId: org.organisationId,
                baseCurrency: org.baseCurrency,
                countryCode: org.countryCode,
                isDemoCompany: org.isDemoCompany,
                organisationStatus: org.organisationStatus
            };
        }
        
        return null;
    } catch (err) {
        error('Xero-Service', 'Error getting organization info', err);
        // Don't throw error here as it's not critical for the OAuth flow
        return null;
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
        error('Xero-Service', 'Error exchanging authorization code', err);
        throw new Error('Error exchanging authorization code');
    }
}

export async function refreshTokenSet(tokenSet) {
    try {
        if (!xeroClient) {
            throw new Error('Xero client is not configured.');
        }

        const newTokenSet = await xeroClient.refreshToken(tokenSet);
        return newTokenSet;
    } catch (err) {
        error('Xero-Service', 'Error refreshing token', err);
        throw new Error('Error refreshing token');
    }
}

export async function createToken(workspaceId) {
    await ensureAuthenticated(workspaceId);
    const token = xeroClient.readTokenSet();
    const tenantId = xeroClient.tenants[0]?.tenantId;
    return { token, xeroTenantId: tenantId };
}

export async function createInvoice(invoice, workspaceId) {
    const validationObj = {
        type: invoice.type,
        contactID: invoice.contact?.contactID || invoice.contactID,
        lineItems: invoice.lineItems,
        currencyCode: invoice.currencyCode,
        lineAmountTypes: invoice.lineAmountTypes,
        date: invoice.date,
        dueDate: invoice.dueDate,
        status: invoice.status,
        reference: invoice.reference,
        customerName: invoice.customerName,
        amount: invoice.amount
    };

    const { error: validationError } = IsoPlusInvoiceValues.validationSchema()
        .validate(validationObj, { abortEarly: false });
    if (validationError) {
        throw new Error('Invoice validation failed: ' + validationError.details.map(d => d.message).join('; '));
    }

    const tenantId = await ensureAuthenticated(workspaceId);

    const invoiceData = {
        Invoices: [{
            Type: invoice.type || 'ACCREC',
            Contact: { ContactID: invoice.contact?.contactID },
            Reference: invoice.reference,
            Date: new Date(invoice.date).toISOString().split('T')[0],
            DueDate: new Date(invoice.dueDate).toISOString().split('T')[0],
            LineItems: invoice.lineItems.map(item => ({
                Description: item.description,
                Quantity: item.quantity,
                UnitAmount: item.unitAmount,
                TaxType: item.taxType || 'NONE',
                AccountCode: item.accountCode // REQUIRED field
            })),
            Status: invoice.status || 'AUTHORISED'
        }]
    };

    try {
        const response = await xeroClient.accountingApi.createInvoices(tenantId, invoiceData);
        return response.body.Invoices[0];
    } catch (err) {
        await handleXeroError(err, 'createInvoice');
    }
}

export async function getContactByEmail(email, workspaceId) {
    const tenantId = await ensureAuthenticated(workspaceId);

    try {
        const response = await xeroClient.accountingApi.getContacts(
            tenantId, null, `EmailAddress=="${email}"`
        );

        return response.body.Contacts?.[0] || null;
    } catch (err) {
        await handleXeroError(err, 'getContactByEmail');
    }
}

export async function getContactByName(name, workspaceId) {
    const tenantId = await ensureAuthenticated(workspaceId);

    try {
        const response = await xeroClient.accountingApi.getContacts(
            tenantId, null, `Name=="${name}"`
        );

        return response.body.Contacts?.[0] || null;
    } catch (err) {
        await handleXeroError(err, 'getContactByName');
    }
}

export async function createOrUpdateContact(contact, workspaceId) {
    const tenantId = await ensureAuthenticated(workspaceId);

    const contactsData = { Contacts: [contact] };

    try {
        let response;
        if (!contact.ContactID) {
            response = await xeroClient.accountingApi.createContacts(tenantId, contactsData);
        } else {
            response = await xeroClient.accountingApi.updateContact(tenantId, contact.ContactID, contactsData);
        }

        return response.body.Contacts[0];
    } catch (err) {
        await handleXeroError(err, 'createOrUpdateContact');
    }
}

export async function findOrCreateItem(itemCode, itemName, workspaceId) {
    if (!itemCode || typeof itemCode !== 'string' || !itemName || typeof itemName !== 'string') {
        throw new Error('Item validation failed: itemCode and itemName are required and must be strings.');
    }

    const tenantId = await ensureAuthenticated(workspaceId);

    try {
        const searchResponse = await xeroClient.accountingApi.getItems(
            tenantId,
            null,
            `Code=="${itemCode}"`
        );

        if (searchResponse.body.Items?.length > 0) {
            return searchResponse.body.Items[0];
        }

        const newItem = {
            Code: itemCode,
            Name: itemName,
        };

        const createResponse = await xeroClient.accountingApi.createItems(
            tenantId,
            { Items: [newItem] }
        );

        return createResponse.body.Items[0];

    } catch (err) {
        await handleXeroError(err, 'findOrCreateItem');
    }
}

export async function createQuote(quote, workspaceId) {
    const tenantId = await ensureAuthenticated(workspaceId);

    // Quotes use Invoices endpoint with Type: 'QUOTE'
    const quoteData = {
        Invoices: [{
            Type: 'QUOTE',
            Contact: { ContactID: quote.contactID },
            LineItems: quote.lineItems.map(item => ({
                Description: item.description,
                Quantity: item.quantity,
                UnitAmount: item.unitAmount,
                TaxType: item.taxType || 'NONE'
            })),
            Status: 'DRAFT'
        }]
    };

    try {
        const response = await xeroClient.accountingApi.createInvoices(tenantId, quoteData);
        return response.body.Invoices[0];
    } catch (err) {
        await handleXeroError(err, 'createQuote');
    }
}

export async function quoteExists(quoteNumber, workspaceId) {
    const tenantId = await ensureAuthenticated(workspaceId);

    try {
        const response = await xeroClient.accountingApi.getQuotes(
            tenantId,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            quoteNumber
        );

        return response.body.Quotes?.length > 0 || false;
    } catch (err) {
        await handleXeroError(err, 'quoteExists');
    }
}

export async function purchaseOrderExists(purchaseOrderNumber, workspaceId) {
    if (!purchaseOrderNumber) {
        return false;
    }

    const tenantId = await ensureAuthenticated(workspaceId);

    try {
        const response = await xeroClient.accountingApi.getPurchaseOrderByNumber(
            tenantId,
            purchaseOrderNumber
        );

        return response.body.PurchaseOrders?.length > 0 || false;
    } catch (err) {
        error('Xero-Service', 'Error checking if purchase order exists in Xero', err);
        return false;
    }
}

export async function createPurchaseOrder(purchaseOrder, workspaceId) {
    const tenantId = await ensureAuthenticated(workspaceId);

    const poData = {
        PurchaseOrders: [{
            Type: 'ACCPAY',
            Contact: { ContactID: purchaseOrder.contactID },
            Reference: purchaseOrder.reference,
            Date: new Date(purchaseOrder.date).toISOString().split('T')[0],
            LineItems: purchaseOrder.lineItems.map(item => ({
                Description: item.description,
                Quantity: item.quantity,
                UnitAmount: item.unitAmount,
                TaxType: item.taxType || 'NONE'
            })),
            Status: 'AUTHORISED'
        }]
    };

    try {
        const response = await xeroClient.accountingApi.createPurchaseOrders(tenantId, poData);
        return response.body.PurchaseOrders[0];
    } catch (err) {
        await handleXeroError(err, 'createPurchaseOrder');
    }
}

function isValidWorkspaceId(workspaceId) {
    return typeof workspaceId === 'string' && workspaceId.length > 0;
}

async function getLatestTokens(workspaceId) {
    if (!isValidWorkspaceId(workspaceId)) {
        throw new Error('Invalid workspace Id');
    }
    const business = await Business.findOne({ workspaceId });
    if (!business || !business.xeroTokens) throw new Error('No Xero tokens found');
    return business.xeroTokens;
}

export async function ensureAuthenticated(workspaceId) {
    if (!isValidWorkspaceId(workspaceId)) {
        throw new Error('Invalid workspace Id');
    }

    if (!xeroClient) {
        await configure();
    }

    const { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt } = await getLatestTokens(workspaceId);

    await xeroClient.setTokenSet({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        token_type: 'Bearer',
        scopes: 'openid profile email accounting.settings accounting.contacts accounting.transactions accounting.reports.read accounting.attachments offline_access'.split(" "),
    });

    let currentTokenSet = xeroClient.readTokenSet();
    if (currentTokenSet?.expired() && currentTokenSet.refresh_token) {
        if (!refreshTokenExpiresAt || refreshTokenExpiresAt < Date.now()) {
            throw new Error('Your Xero authorization token is expired and cannot be refreshed.');
        }
        try {
            const newTokenSet = await xeroClient.refreshWithRefreshToken(
                process.env.XERO_CLIENT_ID,
                process.env.XERO_CLIENT_SECRET,
                currentTokenSet.refresh_token
            );

            const refreshTokenChanged = newTokenSet.refresh_token && newTokenSet.refresh_token !== currentTokenSet.refresh_token;
            const now = new Date();
            const updateFields = {
                'xeroTokens.accessToken': newTokenSet.access_token,
                'xeroTokens.refreshToken': newTokenSet.refresh_token,
                'xeroTokens.expiresAt': newTokenSet.expires_at
            };
            if (refreshTokenChanged) {
                updateFields['xeroTokens.refreshTokenExpiresAt'] = now.getTime() + 60 * 24 * 60 * 60 * 1000;
            }
            await Business.updateOne({ workspaceId }, { $set: updateFields });
            await xeroClient.setTokenSet(newTokenSet);
        } catch (refreshError) {
            error('Xero-Service', 'Token refresh failed', refreshError);
            throw new Error('Xero token refresh failed. Please re-authorize.');
        }
    }

    const tenants = await xeroClient.updateTenants(false);
    if (!tenants?.length) {
        throw new Error('No Xero organizations connected');
    }

    return tenants[0].tenantId; // Return tenantId for convenience
}

async function handleXeroError(err, operation) {
    error('Xero-Service', `${operation} failed`, err);

    // Proper error parsing for xero-node
    if (err.statusCode === 429) {
        throw new Error('Rate limit exceeded. Please wait and retry.');
    }

    if (err.statusCode === 401) {
        throw new Error('Authentication expired. Please re-authenticate.');
    }

    if (err.statusCode === 403) {
        throw new Error('Insufficient permissions. Check your scopes.');
    }

    if (err.body?.Elements) {
        // Validation errors
        const validationErrors = err.body.Elements.flatMap(el =>
            el.ValidationErrors?.map(v => v.Message) || []
        ).join('; ');
        throw new Error(`Validation Error: ${validationErrors}`);
    }

    if (err.body?.Message) {
        throw new Error(err.body.Message);
    }

    throw new Error(`Xero ${operation} failed: ${err.message}`);
}

export async function updateOrganizationInfo(workspaceId) {
    try {
        if (!isValidWorkspaceId(workspaceId)) {
            throw new Error('Invalid workspace Id');
        }
        await configure();
        await ensureAuthenticated(workspaceId);

        const tenants = await xeroClient.updateTenants(false);
        if (!tenants || !tenants.length) {
            throw new Error('No Xero organizations connected');
        }

        const organizationInfo = await getOrganizationInfo(tenants[0].tenantId);

        if (organizationInfo) {
            await Business.updateOne(
                { workspaceId },
                { $set: { xeroOrganization: organizationInfo } }
            );
        }

        return organizationInfo;
    } catch (err) {
        error('Xero-Service', 'Error updating organization info', err);
        throw new Error('Error updating organization info: ' + err.message);
    }
}