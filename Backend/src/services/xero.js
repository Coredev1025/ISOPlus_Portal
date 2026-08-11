import { XeroClient } from 'xero-node';
import Business from '../models/Business.js';
import { error } from '../utils/logger.js';
import { buildXeroContactErrorMessage } from '../utils/xeroContactErrorHelpers.js';
import { randomAlphanumeric } from '../utils/securityHelpers.js';
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
    const state = randomAlphanumeric(16);
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

const XERO_RECONNECT_MESSAGE =
    'No Xero organisation is linked. Disconnect and Connect Xero again, then select an organisation.';

function organizationFromApiOrg(org) {
    if (!org) return null;
    return {
        name: org.name,
        legalName: org.legalName,
        shortCode: org.shortCode,
        organisationId: org.organisationID || org.organisationId,
        baseCurrency: org.baseCurrency,
        countryCode: org.countryCode,
        isDemoCompany: org.isDemoCompany,
        organisationStatus: org.organisationStatus
    };
}

function organizationFromTenantConnection(tenant) {
    if (!tenant?.tenantId) return null;
    return {
        name: tenant.tenantName || 'Connected organisation',
        legalName: tenant.tenantName || '',
        shortCode: '',
        organisationId: tenant.tenantId,
        baseCurrency: '',
        countryCode: '',
        isDemoCompany: false,
        organisationStatus: ''
    };
}

export async function getOrganizationInfo(tenantId) {
    try {
        if (!xeroClient) {
            throw new Error('Xero client is not configured.');
        }

        const response = await xeroClient.accountingApi.getOrganisations(tenantId);
        const orgs = response.body?.organisations || response.body?.Organisations || [];
        if (orgs.length > 0) {
            return organizationFromApiOrg(orgs[0]);
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

export async function createToken() {
    try {
        if (!xeroClient) {
            throw new Error('Xero client is not configured.');
        }

        const token = await xeroClient.readTokenSet();
        const connections = await xeroClient.updateTenants(false) || [];
        const xeroTenantId = connections[0]?.tenantId || null;

        return { token, xeroTenantId };
    } catch (err) {
        error('Xero-Service', 'Error creating token', err);
        throw new Error('Error creating token');
    }
}

function normalizeDateOnly(value) {
    if (!value) return undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            return trimmed;
        }
    }
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) {
        throw new Error(`Invalid date value: ${String(value)}`);
    }
    return dt.toISOString().split('T')[0];
}

function mapInvoiceLineItems(lineItems) {
    return lineItems.map(item => ({
        itemCode: item.itemCode,
        description: item.description,
        quantity: item.quantity,
        unitAmount: item.unitAmount,
        accountCode: item.accountCode,
        taxType: item.taxType,
        lineAmount: item.lineAmount
    }));
}

function throwCreateInvoiceError(err) {
    const statusCode = err.response?.statusCode ?? err.response?.body?.statusCode;
    const body = err.response?.body ?? (typeof err.body === 'object' ? err.body : null);

    if (statusCode === 403) {
        throw new Error('Authentication failed. Please re-authenticate.');
    }
    if (body?.Type === 'ValidationException' && Array.isArray(body.Elements)) {
        const validationErrors = body.Elements
            .flatMap((element) => (element.ValidationErrors || []).map((e) => e.Message))
            .filter(Boolean)
            .join(', ');
        if (validationErrors) {
            throw new Error(`Xero Invoice Validation Errors: ${validationErrors}`);
        }
    }
    if (body && typeof body === 'object') {
        throw new Error(`Xero API Error: ${JSON.stringify(body)}`);
    }
    throw new Error(`Xero Invoice creation failed: ${err?.message || String(err)}`);
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

        await xeroClient.updateTenants(false);
        if (!xeroClient.tenants?.length) {
            throw new Error('No organizations connected');
        }
        const tenantId = xeroClient.tenants[0].tenantId;

        const resolvedContactID = invoice.contact?.contactID || invoice.contactID;
        if (!resolvedContactID) {
            throw new Error('Invoice validation failed: contactID is required.');
        }
        const invoiceData = {
            invoices: [{
                type: invoice.type || 'ACCREC',
                contact: { contactID: resolvedContactID },
                reference: invoice.reference,
                date: normalizeDateOnly(invoice.date),
                dueDate: normalizeDateOnly(invoice.dueDate),
                lineAmountTypes: invoice.lineAmountTypes || 'Exclusive',
                lineItems: mapInvoiceLineItems(invoice.lineItems),
                status: invoice.status || 'AUTHORISED'
            }]
        };

        const response = await xeroClient.accountingApi.createInvoices(
            tenantId,
            invoiceData,
            true,
            4
        );

        return response.body.invoices[0];
    } catch (err) {
        throwCreateInvoiceError(err);
    }
}

export async function getContactByEmail(email) {
    try {
        const { tokenSet, xeroTenantId } = await createToken();

        const response = await xeroClient.accountingApi.getContacts(
            xeroTenantId,
            null,
            `EmailAddress=="${email}"`
        );

        return response.body.contacts[0];
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
        const { tokenSet, xeroTenantId } = await createToken();

        const response = await xeroClient.accountingApi.getContacts(
            xeroTenantId,
            null,
            `Name=="${name}"`
        );

        return response.body.contacts[0];
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

function buildContactPayload(contact) {
    const get = (obj, ...keys) => {
        for (const k of keys) {
            const v = obj?.[k];
            if (v !== undefined && v !== null) return v;
        }
        return undefined;
    };
    const payload = {};
    const contactID = get(contact, 'contactID', 'ContactID');
    if (contactID) payload.contactID = contactID;
    const name = get(contact, 'name', 'Name');
    if (name !== undefined) payload.name = name;
    const firstName = get(contact, 'firstName', 'FirstName');
    if (firstName !== undefined) payload.firstName = firstName;
    const lastName = get(contact, 'lastName', 'LastName');
    if (lastName !== undefined) payload.lastName = lastName;
    const emailAddress = get(contact, 'emailAddress', 'EmailAddress');
    if (emailAddress !== undefined) payload.emailAddress = emailAddress;
    const addresses = get(contact, 'addresses', 'Addresses');
    if (addresses !== undefined && Array.isArray(addresses) && addresses.length > 0) {
        payload.addresses = addresses.map(addr => {
            if (typeof addr !== 'object' || addr === null) return addr;
            return {
                addressType: addr.addressType ?? addr.AddressType,
                addressLine1: addr.addressLine1 ?? addr.AddressLine1,
                city: addr.city ?? addr.City,
                region: addr.region ?? addr.Region,
                postalCode: addr.postalCode ?? addr.PostalCode
            };
        });
    }
    return payload;
}

export async function createOrUpdateContact(contact) {
    try {
        const payload = buildContactPayload(contact);
        const { xeroTenantId } = await createToken();
        const contacts = {
            contacts: [payload],
        };

        let response;
        if (!payload.contactID) {
            response = await xeroClient.accountingApi.createContacts(
                xeroTenantId,
                contacts
            );
        } else {
            response = await xeroClient.accountingApi.updateContact(
                xeroTenantId,
                payload.contactID,
                contacts
            );
        }

        return response.body.contacts[0];
    } catch (err) {
        error('Xero-Service', 'Error creating or updating contact in Xero', err);
        throw new Error(buildXeroContactErrorMessage(err));
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

        await xeroClient.updateTenants(false);
        const tenantId = xeroClient.tenants[0].tenantId;

        const searchResponse = await xeroClient.accountingApi.getItems(
            tenantId,
            null,
            `Code=="${itemCode}"`
        );

        if (searchResponse.body.items?.length > 0) {
            return searchResponse.body.items[0];
        }

        const newItem = {
            code: itemCode,
            name: itemName,
        };

        const createResponse = await xeroClient.accountingApi.createItems(
            tenantId,
            { items: [newItem] }
        );

        return createResponse.body.items[0];

    } catch (err) {
        error('Xero-Service', 'Item operation failed:', err);

        if (err.response?.statusCode === 403) {
            throw new Error('Missing accounting.settings scope');
        }
        if (err.message && err.message.includes('toISOString')) {
            throw new Error('Invalid date parameter in API request');
        }

        throw new Error(`Item operation failed: ${err.message}`);
    }
}

export async function createQuote(quote) {
    try {
        const { token, xeroTenantId } = await createToken();

        const quotes = {
            quotes: [{
                ...quote,
                lineAmountTypes: quote.lineAmountTypes || 'Exclusive',
            }],
        };

        const createdQuotes = await xeroClient.accountingApi.createQuotes(
            xeroTenantId,
            quotes
        );

        return createdQuotes.body.quotes[0];
    } catch (err) {
        error('Xero-Service', 'Error creating quote in Xero', err);
        throw new Error('Error creating quote in Xero');
    }
}

export async function quoteExists(quoteNumber) {
    try {
        const { token, xeroTenantId } = await createToken();

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

        return response.body.quotes.length > 0;
    } catch (err) {
        error('Xero-Service', 'Error checking if quote exists in Xero', err);
        throw new Error('Error checking if quote exists in Xero');
    }
}

export async function purchaseOrderExists(purchaseOrderNumber) {
    try {
        if (!purchaseOrderNumber) {
            return false;
        }

        const { token, xeroTenantId } = await createToken();

        const response = await xeroClient.accountingApi.getPurchaseOrderByNumber(
            xeroTenantId,
            purchaseOrderNumber
        );

        return response.body.purchaseOrders.length > 0;
    } catch (err) {
        error('Xero-Service', 'Error checking if purchase order exists in Xero', err);
        return false;
    }
}

export async function createPurchaseOrder(purchaseOrder) {
    try {
        const { token, xeroTenantId } = await createToken();

        const purchaseOrders = {
            purchaseOrders: [{
                ...purchaseOrder,
                lineAmountTypes: purchaseOrder.lineAmountTypes || 'Exclusive',
            }],
        };

        const createdPurchaseOrders = await xeroClient.accountingApi.createPurchaseOrders(
            xeroTenantId,
            purchaseOrders
        );

        return createdPurchaseOrders.body.purchaseOrders[0];
    } catch (err) {
        error('Xero-Service', 'Error creating purchase order in Xero', err);
        throw new Error('Error creating purchase order in Xero');
    }
}

function isValidWorkspaceId(workspaceId) {
    return typeof workspaceId === 'string' && workspaceId.length > 0;
}

async function getLatestTokens(workspaceId) {
    if (!isValidWorkspaceId(workspaceId)) {
        throw new Error('Invalid workspace Id');
    }
    const business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } });
    if (!business || !business.xeroTokens) throw new Error('No Xero tokens found');
    return business.xeroTokens;
}

async function persistRefreshedTokenSet(workspaceId, newTokenSet, previousRefreshToken) {
    const refreshTokenChanged =
        newTokenSet.refresh_token && newTokenSet.refresh_token !== previousRefreshToken;
    const now = new Date();
    const updateFields = {
        'xeroTokens.accessToken': newTokenSet.access_token,
        'xeroTokens.refreshToken': newTokenSet.refresh_token,
        'xeroTokens.expiresAt': newTokenSet.expires_at
    };
    if (refreshTokenChanged) {
        updateFields['xeroTokens.refreshTokenExpiresAt'] =
            now.getTime() + 60 * 24 * 60 * 60 * 1000;
    }
    await Business.updateOne(
        { workspaceId: { $eq: String(workspaceId) } },
        { $set: updateFields }
    );
    await xeroClient.setTokenSet(newTokenSet);
}

async function refreshXeroTokenSet(workspaceId, refreshToken, refreshTokenExpiresAt) {
    if (!refreshToken) {
        throw new Error('Your Xero authorization token is expired. Please reconnect to Xero.');
    }
    if (!refreshTokenExpiresAt || refreshTokenExpiresAt < new Date().getTime()) {
        throw new Error('Your Xero authorization token is expired. Please reconnect to Xero.');
    }
    try {
        const newTokenSet = await xeroClient.refreshWithRefreshToken(
            process.env.XERO_CLIENT_ID,
            process.env.XERO_CLIENT_SECRET,
            refreshToken
        );
        await persistRefreshedTokenSet(workspaceId, newTokenSet, refreshToken);
        return newTokenSet;
    } catch (refreshError) {
        error('Xero-Service', 'Error refreshing token', refreshError);
        throw new Error('Your Xero authorization token is expired. Please reconnect to Xero.');
    }
}

async function refreshExpiredXeroToken(workspaceId, currentTokenSet, refreshTokenExpiresAt) {
    if (!currentTokenSet.expired() || !currentTokenSet.refresh_token) return;
    await refreshXeroTokenSet(
        workspaceId,
        currentTokenSet.refresh_token,
        refreshTokenExpiresAt
    );
}

async function loadStoredXeroTenantId(workspaceId) {
    const business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } })
        .select('xeroTenantId xeroOrganization')
        .lean();
    return (
        business?.xeroTenantId ||
        business?.xeroOrganization?.organisationId ||
        null
    );
}

async function persistXeroTenantId(workspaceId, tenantId) {
    if (!tenantId) return;
    await Business.updateOne(
        { workspaceId: { $eq: String(workspaceId) } },
        { $set: { xeroTenantId: tenantId } }
    );
}

async function resolveActiveTenantId(workspaceId, refreshTokenExpiresAt) {
    let tenants = await xeroClient.updateTenants(false);
    if (!tenants?.length) {
        const tokenSet = xeroClient.readTokenSet();
        if (tokenSet?.refresh_token) {
            await refreshXeroTokenSet(
                workspaceId,
                tokenSet.refresh_token,
                refreshTokenExpiresAt
            );
            tenants = await xeroClient.updateTenants(false);
        }
    }
    if (tenants?.length) {
        const tenantId = tenants[0].tenantId;
        await persistXeroTenantId(workspaceId, tenantId);
        return { tenantId, tenant: tenants[0] };
    }

    const storedTenantId = await loadStoredXeroTenantId(workspaceId);
    if (storedTenantId) {
        xeroClient.tenants = [{ tenantId: storedTenantId }];
        return { tenantId: storedTenantId, tenant: { tenantId: storedTenantId } };
    }

    throw new Error(XERO_RECONNECT_MESSAGE);
}

export async function ensureAuthenticated(workspaceId) {
    if (!isValidWorkspaceId(workspaceId)) {
        throw new Error('Invalid workspace Id');
    }
    const { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt } =
        await getLatestTokens(workspaceId);

    if (!xeroClient) throw new Error('Xero client not configured');

    await xeroClient.setTokenSet({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        token_type: 'Bearer',
        scopes: 'openid profile email accounting.settings accounting.contacts accounting.transactions accounting.reports.read accounting.attachments offline_access'.split(" "),
    });

    const currentTokenSet = xeroClient.readTokenSet();
    if (!currentTokenSet) {
        throw new Error('Not authenticated with Xero');
    }
    await refreshExpiredXeroToken(workspaceId, currentTokenSet, refreshTokenExpiresAt);
    return resolveActiveTenantId(workspaceId, refreshTokenExpiresAt);
}

export async function getAccounts(workspaceId) {
    try {
        if (!isValidWorkspaceId(workspaceId)) {
            throw new Error('Invalid workspace Id');
        }
        if (!xeroClient) await configure();
        const { tenantId } = await ensureAuthenticated(workspaceId);
        const response = await xeroClient.accountingApi.getAccounts(tenantId);
        const accounts = response.body?.Accounts ?? response.body?.accounts;
        if (!Array.isArray(accounts)) {
            return [];
        }
        return accounts;
    } catch (err) {
        error('Xero-Service', 'Error getting accounts', err);
        
        if (err.response?.statusCode === 403) {
            throw new Error('Permission denied. Ensure your app has accounting.settings scope.');
        }
        if (err.response?.statusCode === 401) {
            throw new Error('Authentication expired. Please reconnect to Xero.');
        }
        
        throw new Error(err.message || 'Error getting accounts');
    }
}

export async function getTaxRates(workspaceId) {
    try {
        if (!isValidWorkspaceId(workspaceId)) {
            throw new Error('Invalid workspace Id');
        }
        if (!xeroClient) await configure();
        const { tenantId } = await ensureAuthenticated(workspaceId);
        const response = await xeroClient.accountingApi.getTaxRates(tenantId);
        const taxRates = response.body?.TaxRates ?? response.body?.taxRates;
        if (!Array.isArray(taxRates)) {
            return [];
        }
        return taxRates;
    } catch (err) {
        error('Xero-Service', 'Error getting tax rates', err);

        if (err.response?.statusCode === 403) {
            throw new Error('Permission denied. Ensure your app has accounting.settings scope.');
        }
        if (err.response?.statusCode === 401) {
            throw new Error('Authentication expired. Please reconnect to Xero.');
        }

        throw new Error(err.message || 'Error getting tax rates');
    }
}

export async function isAccountTaxRateMatched(workspaceId, accountCode, taxType) {
    if (!accountCode || !taxType) return true;
    let accounts;
    let taxRates;
    try {
        [accounts, taxRates] = await Promise.all([
            getAccounts(workspaceId),
            getTaxRates(workspaceId)
        ]);
    } catch {
        return true;
    }
    const account = (accounts || []).find((a) => (a.Code ?? a.code) === accountCode);
    const rate = (taxRates || []).find((t) => (t.TaxType ?? t.taxType) === taxType);
    if (!account || !rate) return false;
    const accountClass = String(account.Class ?? account._class ?? account.class ?? '').toUpperCase();
    const canApplyToRevenue = rate.CanApplyToRevenue ?? rate.canApplyToRevenue ?? false;
    const canApplyToExpenses = rate.CanApplyToExpenses ?? rate.canApplyToExpenses ?? false;
    return accountClass === 'EXPENSE' ? !!canApplyToExpenses : !!canApplyToRevenue;
}

export async function updateOrganizationInfo(workspaceId) {
    try {
        if (!isValidWorkspaceId(workspaceId)) {
            throw new Error('Invalid workspace Id');
        }
        await configure();
        const { tenantId, tenant } = await ensureAuthenticated(workspaceId);
        const organizationInfo =
            (await getOrganizationInfo(tenantId)) ||
            organizationFromTenantConnection(tenant);

        if (!organizationInfo) {
            throw new Error(XERO_RECONNECT_MESSAGE);
        }

        await Business.updateOne(
            { workspaceId: { $eq: String(workspaceId) } },
            {
                $set: {
                    xeroOrganization: organizationInfo,
                    xeroTenantId: tenantId,
                },
            }
        );

        return organizationInfo;
    } catch (err) {
        error('Xero-Service', 'Error updating organization info', err);
        throw new Error(err.message || 'Error updating organization info');
    }
}