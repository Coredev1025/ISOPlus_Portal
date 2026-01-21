import { XeroClient } from 'xero-node';
import Business from '../models/Business.js';
import { error } from '../utils/logger.js';
import {
    IsoPlusInvoiceValues
} from '../dto/itemsPayload.js';

let xeroClient = null;

export async function configure() {
    try {
        xeroClient = new XeroClient({
            clientId: process.env.XERO_CLIENT_ID,
            clientSecret: process.env.XERO_CLIENT_SECRET,
            redirectUris: process.env.XERO_REDIRECT_URL ? [process.env.XERO_REDIRECT_URL] : undefined,
            scopes: 'openid profile email accounting.settings accounting.contacts accounting.transactions accounting.reports.read accounting.attachments offline_access'.split(' ')
        });

        await xeroClient.initialize();
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

    const scopes = 'openid profile email accounting.settings accounting.contacts accounting.transactions accounting.reports.read accounting.attachments offline_access'.split(' ');
    const state = Math.random().toString(36).substring(7);
    const url = await xeroClient.buildConsentUrl(scopes, state);
    return url;
}

export async function callback(code, url) {
    try {
        await xeroClient.apiCallback(url);
        const tokenSet = xeroClient.readTokenSet();
        await xeroClient.updateTenants();

        // Get organization information
        let organizationInfo = null;
        if (xeroClient.tenants && xeroClient.tenants.length > 0) {
            organizationInfo = await getOrganizationInfo(xeroClient.tenants[0].tenantId);
        }

        return {
            success: true,
            message: 'Successfully connected to Xero!',
            tokenSet,
            tenants: xeroClient.tenants,
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

        if (response.body.Organisations && response.body.Organisations.length > 0) {
            const org = response.body.Organisations[0];
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
        
        if (!tokenSet) {
            throw new Error('Token set is required for refresh');
        }

        const newTokenSet = await xeroClient.refreshToken(tokenSet);
        
        if (!newTokenSet) {
            throw new Error('Failed to refresh token: No token set returned');
        }
        
        return newTokenSet;
    } catch (err) {
        error('Xero-Service', 'Error refreshing token', err);
        throw new Error('Error refreshing token: ' + err.message);
    }
}

export async function createToken() {
    try {
        if (!xeroClient) {
            throw new Error('Xero client is not configured.');
        }

        const token = await xeroClient.readTokenSet();
        await xeroClient.updateTenants();
        const xeroTenantId = xeroClient.tenants[0]?.tenantId || null;

        return { token, xeroTenantId };
    } catch (err) {
        error('Xero-Service', 'Error creating token', err);
        throw new Error('Error creating token');
    }
}

export async function createInvoice(invoice) {
    const {
        type,
        lineItems,
        currencyCode,
        lineAmountTypes,
        date,
        dueDate,
        status,
        reference,
        customerName,
        amount
    } = invoice;
    const contactID = invoice.contact?.contactID || invoice.contactID;
    const validationObj = {
        type,
        contactID,
        lineItems,
        currencyCode,
        lineAmountTypes,
        date,
        dueDate,
        status,
        reference,
        customerName,
        amount
    };
    const { error: validationError } = IsoPlusInvoiceValues.validationSchema().validate(validationObj, { abortEarly: false });
    if (validationError) {
        throw new Error('Invoice validation failed: ' + validationError.details.map(d => d.message).join('; '));
    }
    try {
        if (!xeroClient) {
            throw new Error('Xero client not configured');
        }

        await xeroClient.updateTenants();
        if (!xeroClient.tenants?.length) {
            throw new Error('No organizations connected');
        }
        const tenantId = xeroClient.tenants[0].tenantId;

        const invoiceData = {
            invoices: [{
                Type: invoice.type || 'ACCREC',
                Contact: { ContactID: invoice.contact.contactID },
                Reference: invoice.reference,
                Date: new Date(invoice.date).toISOString().split('T')[0],
                DueDate: new Date(invoice.dueDate).toISOString().split('T')[0],
                LineItems: invoice.lineItems.map(item => ({
                    Description: item.description,
                    Quantity: item.quantity,
                    UnitAmount: item.unitAmount,
                    AccountCode: item.itemCode || item.accountCode, // Map itemCode to AccountCode
                    TaxType: item.taxType,
                    LineAmount: item.lineAmount
                })),
                Status: invoice.status || 'AUTHORISED'
            }]
        };

        const response = await xeroClient.accountingApi.createInvoices(
            tenantId,
            invoiceData
        );

        return response.body.Invoices[0];
    } catch (err) {
        // Improved error handling
        if (err.message?.includes('Invoice validation failed')) {
            throw err; // Re-throw validation errors
        }

        try {
            // Attempt to parse error object safely
            let errorMessage = err;
            if (err.response) {
                errorMessage = err.response;
            } else if (typeof err === 'object' && Object.keys(err).length > 0) {
                const jsonString = Object.values(err).join('');
                errorMessage = JSON.parse(jsonString);
            }

            // Handle specific error scenarios
            if (errorMessage.statusCode === 403 || errorMessage.response?.statusCode === 403) {
                throw new Error('Authentication failed. Please re-authenticate.');
            }
            if (errorMessage.body?.Type === 'ValidationException' || errorMessage.response?.body?.Type === 'ValidationException') {
                const elements = errorMessage.body?.Elements || errorMessage.response?.body?.Elements || [];
                let validationErrors = "";
                elements.forEach(element => {
                    if (element.ValidationErrors) {
                        validationErrors += element.ValidationErrors.map(error => error.Message).join(', ');
                    }
                });
                if (validationErrors) {
                    throw new Error(`Xero Invoice Validation Errors: ${validationErrors.trim()}`);
                }
            }
            if (errorMessage.response?.body) {
                throw new Error(`Xero API Error: ${JSON.stringify(errorMessage.response.body)}`);
            }
        } catch (parseErr) {
            // If error parsing fails, use original message
            if (parseErr.message) {
                throw parseErr;
            }
        }

        throw new Error(`Xero Invoice creation failed: ${err.message}`);
    }
}

export async function getContactByEmail(email) {
    try {
        if (!email || typeof email !== 'string') {
            throw new Error('Email address is required and must be a string');
        }

        const { xeroTenantId } = await createToken();

        const response = await xeroClient.accountingApi.getContacts(
            xeroTenantId,
            null,
            `EmailAddress=="${email.trim()}"`
        );

        if (response.body?.Contacts && Array.isArray(response.body.Contacts) && response.body.Contacts.length > 0) {
            return response.body.Contacts[0];
        }

        return null; // Contact not found
    } catch (err) {
        error('Xero-Service', 'Error retrieving contact from Xero', err);

        if (err.response?.statusCode === 403) {
            throw new Error('Permission denied. Ensure your app has accounting.contacts scope.');
        }
        if (err.response?.statusCode === 401) {
            throw new Error('Authentication expired. Please re-authenticate.');
        }

        throw new Error('Error retrieving contact from Xero: ' + err.message);
    }
}

export async function getContactByName(name) {
    try {
        if (!name || typeof name !== 'string') {
            throw new Error('Contact name is required and must be a string');
        }

        const { xeroTenantId } = await createToken();

        const response = await xeroClient.accountingApi.getContacts(
            xeroTenantId,
            null,
            `Name=="${name.trim()}"`
        );

        if (response.body?.Contacts && Array.isArray(response.body.Contacts) && response.body.Contacts.length > 0) {
            return response.body.Contacts[0];
        }

        return null; // Contact not found
    } catch (err) {
        error('Xero-Service', 'Error retrieving contact from Xero', err);

        if (err.response?.statusCode === 403) {
            throw new Error('Permission denied. Ensure your app has accounting.contacts scope.');
        }
        if (err.response?.statusCode === 401) {
            throw new Error('Authentication expired. Please re-authenticate.');
        }

        throw new Error('Error retrieving contact from Xero: ' + err.message);
    }
}

export async function createOrUpdateContact(contact) {
    try {
        // Validate contact object before sending
        if (!contact) {
            throw new Error('Contact object is required');
        }
        
        if (!contact.name || typeof contact.name !== 'string' || !contact.name.trim()) {
            throw new Error('Contact name is required and must be a non-empty string');
        }

        const { xeroTenantId } = await createToken();
        const contactData = {
            Contacts: [contact],
        };

        const response = await xeroClient.accountingApi.updateOrCreateContacts(
            xeroTenantId,
            contactData,
            true // true for upsert
        );

        if (!response.body?.Contacts || !Array.isArray(response.body.Contacts) || response.body.Contacts.length === 0) {
            throw new Error('Invalid response from Xero API: No contacts returned');
        }

        return response.body.Contacts[0];
    } catch (err) {
        error('Xero-Service', 'Error creating or updating contact in Xero', err);

        // Handle custom validation errors from createContactPayload
        if (err.message?.includes('Invalid email') || err.message?.includes('Invalid phone') || 
            err.message?.includes('Contact name is required') || err.message?.includes('required')) {
            throw err; // Re-throw validation errors as-is
        }

        if (err.response?.statusCode === 403) {
            throw new Error('Permission denied. Ensure your app has accounting.contacts scope.');
        }
        if (err.response?.statusCode === 401) {
            throw new Error('Authentication expired. Please re-authenticate.');
        }
        if (err.response?.statusCode === 400) {
            // Try to extract more specific error info from Xero
            const errorBody = err.response?.body;
            if (errorBody?.Type === 'ValidationException' && errorBody?.Elements) {
                let validationErrors = "";
                errorBody.Elements.forEach(element => {
                    if (element.ValidationErrors) {
                        validationErrors += element.ValidationErrors.map(error => error.Message).join(', ');
                    }
                });
                if (validationErrors) {
                    throw new Error(`Contact validation failed: ${validationErrors}`);
                }
            }
            throw new Error('Invalid contact data. Please check the contact information.');
        }
        if (err.response?.statusCode === 409) {
            throw new Error('Contact already exists with conflicting data.');
        }

        // Handle Xero API validation errors
        if (err.response?.body?.Type === 'ValidationException') {
            let validationErrors = "";
            if (err.response.body.Elements) {
                err.response.body.Elements.forEach(element => {
                    if (element.ValidationErrors) {
                        validationErrors += element.ValidationErrors.map(error => error.Message).join(', ');
                    }
                });
            }
            if (validationErrors) {
                throw new Error(`Contact validation failed: ${validationErrors}`);
            }
        }

        throw new Error('Error creating or updating contact in Xero: ' + (err.message || 'Unknown error'));
    }
}

export async function findOrCreateItem(itemCode, itemName) {
    if (!itemCode || typeof itemCode !== 'string' || !itemName || typeof itemName !== 'string') {
        throw new Error('Item validation failed: itemCode and itemName are required and must be strings.');
    }
    try {
        if (!xeroClient) {
            throw new Error('Xero client not configured');
        }

        await xeroClient.updateTenants();
        if (!xeroClient.tenants?.length) {
            throw new Error('No organizations connected');
        }
        const tenantId = xeroClient.tenants[0].tenantId;

        const searchResponse = await xeroClient.accountingApi.getItems(
            tenantId,
            null,
            `Code=="${itemCode.trim()}"`
        );

        if (searchResponse.body?.Items && Array.isArray(searchResponse.body.Items) && searchResponse.body.Items.length > 0) {
            return searchResponse.body.Items[0];
        }

        const newItem = {
            Code: itemCode.trim(),
            Name: itemName.trim(),
        };

        const createResponse = await xeroClient.accountingApi.createItems(
            tenantId,
            { Items: [newItem] }
        );

        if (!createResponse.body?.Items || !Array.isArray(createResponse.body.Items) || createResponse.body.Items.length === 0) {
            throw new Error('Invalid response from Xero API: No items returned');
        }

        return createResponse.body.Items[0];

    } catch (err) {
        error('Xero-Service', 'Item operation failed:', err);

        if (err.message?.includes('Item validation failed')) {
            throw err; // Re-throw validation errors
        }
        if (err.response?.statusCode === 403) {
            throw new Error('Missing accounting.settings scope');
        }
        if (err.message?.includes('toISOString')) {
            throw new Error('Invalid date parameter in API request');
        }
        if (err.response?.statusCode === 401) {
            throw new Error('Authentication expired. Please re-authenticate.');
        }

        throw new Error(`Item operation failed: ${err.message}`);
    }
}

export async function createQuote(quote) {
    try {
        if (!quote) {
            throw new Error('Quote object is required');
        }

        const { xeroTenantId } = await createToken();

        const quoteData = {
            Quotes: [quote],
        };

        const response = await xeroClient.accountingApi.updateOrCreateQuotes(
            xeroTenantId,
            quoteData,
            true // true for upsert
        );

        if (!response.body?.Quotes || !Array.isArray(response.body.Quotes) || response.body.Quotes.length === 0) {
            throw new Error('Invalid response from Xero API: No quotes returned');
        }

        return response.body.Quotes[0];
    } catch (err) {
        error('Xero-Service', 'Error creating quote in Xero', err);
        
        if (err.response?.statusCode === 403) {
            throw new Error('Permission denied. Ensure your app has accounting.transactions scope.');
        }
        if (err.response?.statusCode === 401) {
            throw new Error('Authentication expired. Please re-authenticate.');
        }
        if (err.response?.body?.Type === 'ValidationException') {
            let validationErrors = "";
            if (err.response.body.Elements) {
                err.response.body.Elements.forEach(element => {
                    if (element.ValidationErrors) {
                        validationErrors += element.ValidationErrors.map(error => error.Message).join(', ');
                    }
                });
            }
            if (validationErrors) {
                throw new Error(`Quote validation failed: ${validationErrors}`);
            }
        }
        
        throw new Error('Error creating quote in Xero: ' + err.message);
    }
}

export async function quoteExists(quoteNumber) {
    try {
        if (!quoteNumber) {
            return false;
        }

        const { xeroTenantId } = await createToken();

        const response = await xeroClient.accountingApi.getQuotes(
            xeroTenantId,
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

        return response.body?.Quotes && Array.isArray(response.body.Quotes) && response.body.Quotes.length > 0;
    } catch (err) {
        error('Xero-Service', 'Error checking if quote exists in Xero', err);
        // Return false on error instead of throwing
        return false;
    }
}

export async function purchaseOrderExists(purchaseOrderNumber) {
    try {
        if (!purchaseOrderNumber || typeof purchaseOrderNumber !== 'string') {
            return false;
        }

        const { xeroTenantId } = await createToken();

        const response = await xeroClient.accountingApi.getPurchaseOrderByNumber(
            xeroTenantId,
            purchaseOrderNumber.trim()
        );

        return response.body?.PurchaseOrders && Array.isArray(response.body.PurchaseOrders) && response.body.PurchaseOrders.length > 0;
    } catch (err) {
        error('Xero-Service', 'Error checking if purchase order exists in Xero', err);
        // Return false on error instead of throwing
        return false;
    }
}

export async function createPurchaseOrder(purchaseOrder) {
    try {
        if (!purchaseOrder) {
            throw new Error('Purchase order object is required');
        }

        const { xeroTenantId } = await createToken();

        const poData = {
            PurchaseOrders: [purchaseOrder],
        };

        const response = await xeroClient.accountingApi.createPurchaseOrders(
            xeroTenantId,
            poData
        );

        if (!response.body?.PurchaseOrders || !Array.isArray(response.body.PurchaseOrders) || response.body.PurchaseOrders.length === 0) {
            throw new Error('Invalid response from Xero API: No purchase orders returned');
        }

        return response.body.PurchaseOrders[0];
    } catch (err) {
        error('Xero-Service', 'Error creating purchase order in Xero', err);
        
        if (err.response?.statusCode === 403) {
            throw new Error('Permission denied. Ensure your app has accounting.transactions scope.');
        }
        if (err.response?.statusCode === 401) {
            throw new Error('Authentication expired. Please re-authenticate.');
        }
        if (err.response?.body?.Type === 'ValidationException') {
            let validationErrors = "";
            if (err.response.body.Elements) {
                err.response.body.Elements.forEach(element => {
                    if (element.ValidationErrors) {
                        validationErrors += element.ValidationErrors.map(error => error.Message).join(', ');
                    }
                });
            }
            if (validationErrors) {
                throw new Error(`Purchase order validation failed: ${validationErrors}`);
            }
        }
        
        throw new Error('Error creating purchase order in Xero: ' + err.message);
    }
}

function isValidWorkspaceId(workspaceId) {
    return typeof workspaceId === 'string';
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
    const { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt } = await getLatestTokens(workspaceId);

    if (!xeroClient) throw new Error('Xero client not configured');

    // Validate token fields
    if (!accessToken || !refreshToken) {
        throw new Error('Invalid token data stored in database');
    }

    const tokenSet = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        token_type: 'Bearer',
        scopes: 'openid profile email accounting.settings accounting.contacts accounting.transactions accounting.reports.read accounting.attachments offline_access'.split(' '),
    };

    await xeroClient.setTokenSet(tokenSet);

    // Check if access token is expired
    const now = new Date().getTime();
    if (expiresAt && expiresAt < now) {
        if (!refreshTokenExpiresAt || refreshTokenExpiresAt < now) {
            throw new Error('Your Xero authorization token is expired.');
        }
        try {
            const newTokenSet = await xeroClient.refreshToken();

            if (!newTokenSet || !newTokenSet.access_token) {
                throw new Error('Failed to refresh token: Invalid token response');
            }

            const refreshTokenChanged = newTokenSet.refresh_token && newTokenSet.refresh_token !== tokenSet.refresh_token;
            const nowDate = new Date();
            const updateFields = {
                'xeroTokens.accessToken': newTokenSet.access_token,
                'xeroTokens.refreshToken': newTokenSet.refresh_token,
                'xeroTokens.expiresAt': newTokenSet.expires_at
            };
            if (refreshTokenChanged) {
                updateFields['xeroTokens.refreshTokenExpiresAt'] = nowDate.getTime() + 60 * 24 * 60 * 60 * 1000;
            }
            await Business.updateOne(
                { workspaceId },
                { $set: updateFields }
            );
            await xeroClient.setTokenSet(newTokenSet);
        } catch (refreshError) {
            error('Xero-Service', 'Error refreshing token', refreshError);
            throw new Error('Your Xero authorization token is expired. Please go to ISOPlus Portal and authorize again.');
        }
    }

    await xeroClient.updateTenants();
    if (!xeroClient.tenants || !xeroClient.tenants.length) {
        throw new Error('No Xero organizations connected');
    }
}

export async function getAccounts(workspaceId) {
    try {
        if (!isValidWorkspaceId(workspaceId)) {
            throw new Error('Invalid workspace Id');
        }
        await configure();
        await ensureAuthenticated(workspaceId);

        await xeroClient.updateTenants();
        if (!xeroClient.tenants?.length) {
            throw new Error('No organizations connected');
        }
        const tenantId = xeroClient.tenants[0].tenantId;

        const response = await xeroClient.accountingApi.getAccounts(tenantId);
        
        if (!response.body?.Accounts || !Array.isArray(response.body.Accounts)) {
            throw new Error('Invalid response from Xero API: No accounts returned');
        }
        
        return response.body.Accounts;
    } catch (err) {
        error('Xero-Service', 'Error getting accounts', err);
        
        if (err.response?.statusCode === 403) {
            throw new Error('Permission denied. Ensure your app has accounting.settings scope.');
        }
        if (err.response?.statusCode === 401) {
            throw new Error('Authentication expired. Please re-authenticate.');
        }
        
        throw new Error('Error getting accounts: ' + err.message);
    }
}

export async function updateOrganizationInfo(workspaceId) {
    try {
        if (!isValidWorkspaceId(workspaceId)) {
            throw new Error('Invalid workspace Id');
        }
        await configure();
        await ensureAuthenticated(workspaceId);

        await xeroClient.updateTenants();
        if (!xeroClient.tenants || !xeroClient.tenants.length) {
            throw new Error('No Xero organizations connected');
        }

        const organizationInfo = await getOrganizationInfo(xeroClient.tenants[0].tenantId);
        
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