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
    console.log('🔵 [createInvoice] Starting invoice creation');
    console.log('📋 [createInvoice] Invoice object:', JSON.stringify({
        type: invoice.type,
        reference: invoice.reference,
        date: invoice.date,
        dueDate: invoice.dueDate,
        status: invoice.status,
        contactID: invoice.contact?.ContactID || invoice.contact?.contactID,
        lineItemsCount: invoice.lineItems?.length
    }, null, 2));
    
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
    const contactID = invoice.contact?.ContactID || invoice.contact?.contactID;
    
    console.log('✅ [createInvoice] Extracted contactID:', contactID);
    
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
        console.error('🔴 [createInvoice] Validation failed:', validationError.details);
        throw new Error('Invoice validation failed: ' + validationError.details.map(d => d.message).join('; '));
    }
    try {
        if (!xeroClient) {
            console.error('🔴 [createInvoice] Xero client not configured');
            throw new Error('Xero client not configured');
        }

        console.log('🔄 [createInvoice] Updating tenants...');
        await xeroClient.updateTenants();
        if (!xeroClient.tenants?.length) {
            console.error('🔴 [createInvoice] No organizations connected');
            throw new Error('No organizations connected');
        }
        const tenantId = xeroClient.tenants[0].tenantId;
        console.log('✅ [createInvoice] Tenant ID:', tenantId);

        const invoiceData = {
            invoices: [{
                Type: invoice.type || 'ACCREC',
                Contact: { ContactID: invoice.contact.ContactID },
                Reference: invoice.reference,
                Date: new Date(invoice.date).toISOString().split('T')[0],
                DueDate: new Date(invoice.dueDate).toISOString().split('T')[0],
                LineItems: invoice.lineItems.map(item => ({
                    Description: item.description,
                    Quantity: item.quantity,
                    UnitAmount: item.unitAmount,
                    AccountCode: item.itemCode || item.accountCode,
                    TaxType: item.taxType,
                    LineAmount: item.lineAmount
                })),
                Status: invoice.status || 'AUTHORISED'
            }]
        };

        console.log('📤 [createInvoice] Sending to Xero API:', JSON.stringify(invoiceData, null, 2));
        const response = await xeroClient.accountingApi.createInvoices(
            tenantId,
            invoiceData
        );

        console.log('📥 [createInvoice] Response received:', { 
            invoiceID: response.body.Invoices[0]?.InvoiceID,
            invoiceNumber: response.body.Invoices[0]?.InvoiceNumber,
            status: response.body.Invoices[0]?.Status
        });

        console.log('✅ [createInvoice] Invoice created successfully');
        return response.body.Invoices[0];
    } catch (err) {
        console.error('🔴 [createInvoice] Error caught:', { 
            message: err.message, 
            statusCode: err.response?.statusCode,
            errorType: err.response?.body?.ApiException?.ErrorNumber,
            validationErrors: err.response?.body?.ApiException?.ValidationErrors,
            stack: err.stack?.split('\n').slice(0, 3).join('\n')
        });
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
        console.log('🔵 [getContactByEmail] Starting - searching for email:', email);
        
        if (!email || typeof email !== 'string') {
            console.error('🔴 [getContactByEmail] Email validation failed:', { email, type: typeof email });
            throw new Error('Email address is required and must be a string');
        }

        console.log('🔄 [getContactByEmail] Getting tenant ID...');
        const { xeroTenantId } = await createToken();
        console.log('✅ [getContactByEmail] Tenant ID:', xeroTenantId);

        const whereClause = `EmailAddress=="${email.trim()}"`;
        console.log('📤 [getContactByEmail] Querying Xero with:', whereClause);
        
        const response = await xeroClient.accountingApi.getContacts(
            xeroTenantId,
            null,
            whereClause
        );

        console.log('📥 [getContactByEmail] Response:', { 
            contactsCount: response.body?.Contacts?.length,
            foundContacts: response.body?.Contacts?.map(c => ({ id: c.ContactID, name: c.Name }))
        });

        if (response.body?.Contacts && Array.isArray(response.body.Contacts) && response.body.Contacts.length > 0) {
            console.log('✅ [getContactByEmail] Contact found:', response.body.Contacts[0].ContactID);
            return response.body.Contacts[0];
        }

        console.log('⚠️ [getContactByEmail] Contact not found for email:', email);
        return null; // Contact not found
    } catch (err) {
        console.error('🔴 [getContactByEmail] Error:', { 
            message: err.message, 
            statusCode: err.response?.statusCode,
            email 
        });
        
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
    console.log('🔵 [getContactByName] Starting - searching for contact by name:', name);
    
    try {
        if (!name || typeof name !== 'string') {
            console.error('🔴 [getContactByName] Validation failed - name required and must be string');
            throw new Error('Contact name is required and must be a string');
        }

        console.log('✅ [getContactByName] Name validation passed:', { nameLength: name.length });

        console.log('🔄 [getContactByName] Creating/retrieving token...');
        const { xeroTenantId } = await createToken();
        console.log('✅ [getContactByName] Token retrieved, TenantID:', xeroTenantId);

        const whereClause = `Name=="${name.trim()}"`;
        console.log('📤 [getContactByName] Querying Xero with WHERE clause:', whereClause);
        
        const response = await xeroClient.accountingApi.getContacts(
            xeroTenantId,
            null,
            whereClause
        );

        console.log('📥 [getContactByName] Response received:', { 
            contactsCount: response.body?.Contacts?.length,
            foundContacts: response.body?.Contacts?.map(c => ({ id: c.ContactID, name: c.Name }))
        });

        if (response.body?.Contacts && Array.isArray(response.body.Contacts) && response.body.Contacts.length > 0) {
            const contact = response.body.Contacts[0];
            console.log('✅ [getContactByName] Contact found:', { 
                ContactID: contact.ContactID, 
                Name: contact.Name,
                Status: contact.Status
            });
            return contact;
        }

        console.log('⚠️ [getContactByName] No contact found with name:', name);
        return null; // Contact not found
    } catch (err) {
        console.error('🔴 [getContactByName] Error caught:', { 
            message: err.message, 
            statusCode: err.response?.statusCode,
            errorBody: err.response?.body
        });
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
        console.log('🔵 [createOrUpdateContact] Starting contact creation/update', { 
            contactKeys: Object.keys(contact || {}),
            contactName: contact?.Name || contact?.name 
        });
        
        // Validate contact object before sending
        if (!contact) {
            console.error('🔴 [createOrUpdateContact] Contact object is null/undefined');
            throw new Error('Contact object is required');
        }
        
        console.log('📋 [createOrUpdateContact] Full contact payload:', JSON.stringify(contact, null, 2));
        
        // Support both camelCase (legacy) and PascalCase (xero-node v13.3.1)
        const contactName = contact.Name || contact.name;
        console.log('✅ [createOrUpdateContact] Contact name resolved:', { 
            contactName, 
            hasName: !!contact.Name, 
            hasNameLower: !!contact.name 
        });
        
        if (!contactName || typeof contactName !== 'string' || !contactName.trim()) {
            console.error('🔴 [createOrUpdateContact] Validation failed:', { 
                contactName, 
                type: typeof contactName, 
                isTrimmed: contactName?.trim() 
            });
            throw new Error('Contact name is required and must be a non-empty string');
        }

        console.log('🔄 [createOrUpdateContact] Getting Xero tenant ID...');
        const { xeroTenantId } = await createToken();
        console.log('✅ [createOrUpdateContact] Tenant ID obtained:', xeroTenantId);
        
        const contactData = {
            Contacts: [contact],
        };

        console.log('📤 [createOrUpdateContact] Sending to Xero API with tenant:', xeroTenantId);
        const response = await xeroClient.accountingApi.updateOrCreateContacts(
            xeroTenantId,
            contactData,
            true // true for upsert
        );

        console.log('📥 [createOrUpdateContact] Received response from Xero:', { 
            contactsCount: response.body?.Contacts?.length,
            firstContactId: response.body?.Contacts?.[0]?.ContactID 
        });

        if (!response.body?.Contacts || !Array.isArray(response.body.Contacts) || response.body.Contacts.length === 0) {
            console.error('🔴 [createOrUpdateContact] Invalid response structure:', response.body);
            throw new Error('Invalid response from Xero API: No contacts returned');
        }

        console.log('✅ [createOrUpdateContact] Contact created/updated successfully:', response.body.Contacts[0].ContactID);
        return response.body.Contacts[0];
    } catch (err) {
        console.error('🔴 [createOrUpdateContact] Error caught:', { 
            message: err.message, 
            statusCode: err.response?.statusCode,
            errorType: err.response?.body?.Type,
            fullError: JSON.stringify(err, null, 2)
        });
        
        error('Xero-Service', 'Error creating or updating contact in Xero', err);

        // Handle custom validation errors from createContactPayload
        if (err.message?.includes('Invalid email') || err.message?.includes('Invalid phone') || 
            err.message?.includes('Contact name is required') || err.message?.includes('required')) {
            console.error('🔴 [createOrUpdateContact] Validation error - re-throwing:', err.message);
            throw err; // Re-throw validation errors as-is
        }

        if (err.response?.statusCode === 403) {
            console.error('🔴 [createOrUpdateContact] Permission denied (403)');
            throw new Error('Permission denied. Ensure your app has accounting.contacts scope.');
        }
        if (err.response?.statusCode === 401) {
            console.error('🔴 [createOrUpdateContact] Authentication expired (401)');
            throw new Error('Authentication expired. Please re-authenticate.');
        }
        if (err.response?.statusCode === 400) {
            console.error('🔴 [createOrUpdateContact] Bad request (400):', err.response?.body);
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
                    console.error('🔴 [createOrUpdateContact] Xero validation errors:', validationErrors);
                    throw new Error(`Contact validation failed: ${validationErrors}`);
                }
            }
            throw new Error('Invalid contact data. Please check the contact information.');
        }
        if (err.response?.statusCode === 409) {
            console.error('🔴 [createOrUpdateContact] Conflict - contact already exists (409)');
            throw new Error('Contact already exists with conflicting data.');
        }

        // Handle Xero API validation errors
        if (err.response?.body?.Type === 'ValidationException') {
            console.error('🔴 [createOrUpdateContact] Xero validation exception:', err.response.body);
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
    console.log('🔵 [findOrCreateItem] Starting item search/creation');
    console.log('📋 [findOrCreateItem] Parameters:', { itemCode, itemName });
    
    if (!itemCode || typeof itemCode !== 'string' || !itemName || typeof itemName !== 'string') {
        console.error('🔴 [findOrCreateItem] Validation failed - itemCode and itemName required as strings');
        throw new Error('Item validation failed: itemCode and itemName are required and must be strings.');
    }
    
    console.log('✅ [findOrCreateItem] Validation passed');
    
    try {
        if (!xeroClient) {
            console.error('🔴 [findOrCreateItem] Xero client not configured');
            throw new Error('Xero client not configured');
        }

        console.log('🔄 [findOrCreateItem] Updating tenants...');
        await xeroClient.updateTenants();
        if (!xeroClient.tenants?.length) {
            console.error('🔴 [findOrCreateItem] No organizations connected');
            throw new Error('No organizations connected');
        }
        const tenantId = xeroClient.tenants[0].tenantId;
        console.log('✅ [findOrCreateItem] Tenant ID:', tenantId);

        const whereClause = `Code=="${itemCode.trim()}"`;
        console.log('📤 [findOrCreateItem] Searching for existing item with WHERE:', whereClause);
        
        const searchResponse = await xeroClient.accountingApi.getItems(
            tenantId,
            null,
            whereClause
        );

        console.log('📥 [findOrCreateItem] Search response:', { 
            itemsFound: searchResponse.body?.Items?.length,
            items: searchResponse.body?.Items?.map(i => ({ code: i.Code, name: i.Name }))
        });

        if (searchResponse.body?.Items && Array.isArray(searchResponse.body.Items) && searchResponse.body.Items.length > 0) {
            console.log('✅ [findOrCreateItem] Existing item found:', { 
                ItemID: searchResponse.body.Items[0].ItemID,
                Code: searchResponse.body.Items[0].Code,
                Name: searchResponse.body.Items[0].Name
            });
            return searchResponse.body.Items[0];
        }

        console.log('⚠️ [findOrCreateItem] Item not found, creating new item...');
        
        const newItem = {
            Code: itemCode.trim(),
            Name: itemName.trim(),
        };

        console.log('📤 [findOrCreateItem] Creating new item:', newItem);
        
        const createResponse = await xeroClient.accountingApi.createItems(
            tenantId,
            { Items: [newItem] }
        );

        console.log('📥 [findOrCreateItem] Create response:', { 
            itemsCreated: createResponse.body?.Items?.length,
            itemID: createResponse.body?.Items?.[0]?.ItemID
        });

        if (!createResponse.body?.Items || !Array.isArray(createResponse.body.Items) || createResponse.body.Items.length === 0) {
            console.error('🔴 [findOrCreateItem] Invalid response - no items returned');
            throw new Error('Invalid response from Xero API: No items returned');
        }

        console.log('✅ [findOrCreateItem] Item created successfully');
        return createResponse.body.Items[0];

    } catch (err) {
        console.error('🔴 [findOrCreateItem] Error caught:', { 
            message: err.message, 
            statusCode: err.response?.statusCode,
            itemCode,
            itemName
        });
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

        throw new Error(`Item operation failed: ${err.message}`);;
    }
}

export async function createQuote(quote) {
    console.log('🔵 [createQuote] Starting quote creation');
    console.log('📋 [createQuote] Quote object:', JSON.stringify({
        quoteNumber: quote?.QuoteNumber,
        status: quote?.Status,
        lineItemsCount: quote?.LineItems?.length,
        contactID: quote?.Contact?.ContactID,
        expiryDate: quote?.ExpiryDate,
        deliveryDate: quote?.DeliveryDate
    }, null, 2));
    
    try {
        if (!quote) {
            console.error('🔴 [createQuote] Quote object is required');
            throw new Error('Quote object is required');
        }

        console.log('🔄 [createQuote] Creating/retrieving token...');
        const { xeroTenantId } = await createToken();
        console.log('✅ [createQuote] Token retrieved, TenantID:', xeroTenantId);

        const quoteData = {
            Quotes: [quote],
        };

        console.log('📤 [createQuote] Sending to Xero API:', JSON.stringify(quoteData, null, 2));
        const response = await xeroClient.accountingApi.updateOrCreateQuotes(
            xeroTenantId,
            quoteData,
            true // true for upsert
        );

        console.log('📥 [createQuote] Response received:', { 
            quotesCount: response.body?.Quotes?.length,
            quoteID: response.body?.Quotes?.[0]?.QuoteID,
            status: response.body?.Quotes?.[0]?.Status
        });

        if (!response.body?.Quotes || !Array.isArray(response.body.Quotes) || response.body.Quotes.length === 0) {
            console.error('🔴 [createQuote] Invalid response - no quotes returned');
            throw new Error('Invalid response from Xero API: No quotes returned');
        }

        console.log('✅ [createQuote] Quote created successfully');
        return response.body.Quotes[0];
    } catch (err) {
        console.error('🔴 [createQuote] Error caught:', { 
            message: err.message, 
            statusCode: err.response?.statusCode,
            errorType: err.response?.body?.Type,
            validationErrors: err.response?.body?.Elements
        });
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
    console.log('🔵 [createPurchaseOrder] Starting purchase order creation');
    console.log('📋 [createPurchaseOrder] Purchase order object:', JSON.stringify({
        purchaseOrderNumber: purchaseOrder?.PurchaseOrderNumber,
        status: purchaseOrder?.Status,
        lineItemsCount: purchaseOrder?.LineItems?.length,
        contactID: purchaseOrder?.Contact?.ContactID,
        deliveryDate: purchaseOrder?.DeliveryDate
    }, null, 2));
    
    try {
        if (!purchaseOrder) {
            console.error('🔴 [createPurchaseOrder] Purchase order object is required');
            throw new Error('Purchase order object is required');
        }

        console.log('🔄 [createPurchaseOrder] Creating/retrieving token...');
        const { xeroTenantId } = await createToken();
        console.log('✅ [createPurchaseOrder] Token retrieved, TenantID:', xeroTenantId);

        const poData = {
            PurchaseOrders: [purchaseOrder],
        };

        console.log('📤 [createPurchaseOrder] Sending to Xero API:', JSON.stringify(poData, null, 2));
        const response = await xeroClient.accountingApi.createPurchaseOrders(
            xeroTenantId,
            poData
        );

        console.log('📥 [createPurchaseOrder] Response received:', { 
            poCount: response.body?.PurchaseOrders?.length,
            purchaseOrderID: response.body?.PurchaseOrders?.[0]?.PurchaseOrderID,
            status: response.body?.PurchaseOrders?.[0]?.Status
        });

        if (!response.body?.PurchaseOrders || !Array.isArray(response.body.PurchaseOrders) || response.body.PurchaseOrders.length === 0) {
            console.error('🔴 [createPurchaseOrder] Invalid response - no purchase orders returned');
            throw new Error('Invalid response from Xero API: No purchase orders returned');
        }

        console.log('✅ [createPurchaseOrder] Purchase order created successfully');
        return response.body.PurchaseOrders[0];
    } catch (err) {
        console.error('🔴 [createPurchaseOrder] Error caught:', { 
            message: err.message, 
            statusCode: err.response?.statusCode,
            errorType: err.response?.body?.Type,
            validationErrors: err.response?.body?.Elements
        });
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
    console.log('🔵 [getAccounts] Starting account retrieval');
    console.log('📋 [getAccounts] WorkspaceID:', workspaceId);
    
    try {
        if (!isValidWorkspaceId(workspaceId)) {
            console.error('🔴 [getAccounts] Invalid workspace ID');
            throw new Error('Invalid workspace Id');
        }
        
        console.log('🔄 [getAccounts] Configuring Xero client...');
        await configure();
        
        console.log('🔄 [getAccounts] Ensuring authentication for workspace...');
        await ensureAuthenticated(workspaceId);

        console.log('🔄 [getAccounts] Updating tenants...');
        await xeroClient.updateTenants();
        if (!xeroClient.tenants?.length) {
            console.error('🔴 [getAccounts] No organizations connected');
            throw new Error('No organizations connected');
        }
        const tenantId = xeroClient.tenants[0].tenantId;
        console.log('✅ [getAccounts] Tenant ID:', tenantId);

        console.log('📤 [getAccounts] Retrieving accounts from Xero API...');
        const response = await xeroClient.accountingApi.getAccounts(tenantId);
        
        console.log('📥 [getAccounts] Response received:', { 
            accountsCount: response.body?.Accounts?.length,
            accountTypes: response.body?.Accounts?.map(a => a.Type)?.filter((v, i, a) => a.indexOf(v) === i)
        });
        
        if (!response.body?.Accounts || !Array.isArray(response.body.Accounts)) {
            console.error('🔴 [getAccounts] Invalid response - no accounts returned');
            throw new Error('Invalid response from Xero API: No accounts returned');
        }
        
        console.log('✅ [getAccounts] Successfully retrieved', response.body.Accounts.length, 'accounts');
        return response.body.Accounts;
    } catch (err) {
        console.error('🔴 [getAccounts] Error caught:', { 
            message: err.message, 
            statusCode: err.response?.statusCode,
            workspaceId
        });
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