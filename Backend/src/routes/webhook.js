import express from 'express';
import { info, error, warn } from '../utils/logger.js';
import fs from 'fs/promises';
import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';
import path from 'path';
import { fileURLToPath } from 'url';
import Business from '../models/Business.js';
import PDFLink from '../models/PDFLink.js';
import Item from '../models/Item.js';
import InvoiceNumber from '../models/InvoiceNumber.js';
import Board from '../models/Board.js';
import { getS3File, uploadFileToS3, getS3FileUrl } from '../utils/uploadS3.js';
import { isEmpty } from '../utils/helpers.js';
import { applyTemplateTextDefaultsToPages } from '../utils/webhookTemplateHelpers.js';
import { paginatePdfmeTemplateTableByRows } from '../utils/webhookPdfPaginationHelpers.js';
import { processWebhookNdisQuotePdfItem, processWebhookNdisInvoicePdfItem } from '../utils/webhookNdisPdfHandlers.js';
import { handleParticipantTaxInvoiceRoute } from '../utils/webhookParticipantTaxPdfHelpers.js';
import { handleMonthlyStatementRoute, buildMonthlyStatementDeps } from '../utils/webhookMonthlyStatementPdfHelpers.js';
import { mongoEq } from '../utils/securityHelpers.js';

import {
    enrichNumericAggregateFields,
    enrichLabelAggregateFields,
} from '../utils/webhookAggregateHelpers.js';
import {
    validateItemBelongsToTenant,
    setIntegrationMessage,
    getJobReportingReferencedItems,
    getJobPlanningReferencedItems,
    getQuoteReferencedItems,
    getPurchaseOrderReferencedItems,
    setGeneratedField,
    setPDFLinkAttribute,
    getQuoteNDISReferencedItems,
    getNDISMasterPlanReferencedItems,
    getItemValues
} from '../services/isoplus.js';
import { logAuditTrail } from '../utils/auditLogger.js';
import { fetchBudgetItems, fetchServiceItems } from '../services/monthlyStatementData.js';
import {
    NDIS_MASTERPLAN_ATTR as NDIS_MASTERPLAN_ATTR_DB,
    buildNdisMasterPlanServiceRows,
    buildNdisSupportCatalogueForServicePlan,
    extractRefId as extractNdisRefId,
    formatDdMmYyyy,
    formatDateInValueZone,
    formatDateTimeInValueZone,
} from '../utils/ndisServiceRecords.js';
import { resolveNdisPricingRuleForServicePlan } from '../utils/ndisPricingRules.js';
import {
    getNdisInvoiceGeneratorContextFromMasterItems,
    fetchParticipantProfileItemForMasterPlan,
    prepareParticipantForInvoiceGenerator,
} from '../utils/ndisInvoiceGeneratorInvoicing.js';
import {
    buildMasterItemsMap,
    buildNdisInvoicePdfClientDetails,
    enrichNdisInvoiceGeneratorRows,
} from '../utils/ndisInvoiceGeneratorOutput.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

function enableRepeatHeadOnTables(template) {
    if (!template || !Array.isArray(template.schemas)) {
        return;
    }
    for (const pageSchemas of template.schemas) {
        if (!Array.isArray(pageSchemas)) {
            continue;
        }
        for (const schema of pageSchemas) {
            if (schema && schema.type === 'table') {
                schema.repeatHead = true;
            }
        }
    }
}

// Attribute names constants (matching items.js)
const ATTRIBUTE_NAMES = {
    SCHEDULED_START: 'Scheduled Shift Start Date & Time',
    ACTUAL_START: 'Actual Shift Start Date & Time',
    ACTUAL_END: 'Actual Shift End Date & Time',
    PARTICIPANT_FULL_NAME: 'Participant Full Name',
    WORKER_PLANNER: 'Worker/Planner',
    DELIVERED_BY: 'Delivered by',
    ASSOCIATED_PROVIDER: 'Associated Provider (If Applicable)',
    SERVICE_PROVIDER: 'Service Provider',
    UNIT: 'Unit',
    QUANTITY: 'Quantity',
    UNIT_PRICE: 'Unit Price ($)',
    TOTAL_AMOUNT: 'Total Amount ($)',
    GOV_SUBSIDY: 'Government Subsidy ($)',
    PARTICIPANT_CONTRIBUTION: 'Participant Contribution ($)',
    SERVICE_PLAN: 'Service Plan',
    SERVICE_PLAN_ID: 'Service Plan ID',
    SERVICE_CATEGORY: 'Service Category',
    TASK_NAME: 'Task Name',
    ADDITIONAL_NOTES: 'Additional Notes',
    TRANSACTION_STATUS: 'Transaction Status',
    FUNDING_SOURCE: 'Funding Source',
    PARTICIPANT_PROFILE: 'Participant Profile',
    FULL_NAME: 'Full Name/Preferred Name',
    ADDRESS: 'Address',
    SUBURB: 'Suburb',
    POSTCODE: 'Postcode',
    POST_CODE: 'Post Code',
    STATE: 'State'
};

async function getValidatedBusiness(workspaceId) {
    const business = await Business.findOne({ workspaceId: mongoEq(workspaceId.toString()) });
    if (!business) {
        throw new Error('Business not found');
    }
    return business;
}

async function handlePDFError(err, workspaceId, boardId, itemId, action, req, res) {
    const errorMessage = (err && err.message) ? err.message : 'Server error: An unknown error occurred. Please contact support via ISO+™ Portal.';
    await setIntegrationMessage(workspaceId, boardId, itemId, errorMessage);
    error('Webhook-Service', 'PDF generation error', { err, errorMessage, workspaceId, boardId, itemId, action }, req);
    logAuditTrail({
        workspaceId,
        action,
        detail: `Resource ID: ${itemId}, Error: ${errorMessage}`,
        req
    });
    return res.status(200).json({ message: errorMessage });
}

async function getLogoData(business, req = null) {
    const logoKey = business.defaultLogo;
    if (!logoKey) return '';

    const buffer = await getS3File(logoKey, false);
    if (!buffer) throw new Error('Failed to retrieve logo from S3');

    info('Webhook-Service', 'Embedding default logo for PDF generation', {
      workspaceId: business?.workspaceId,
      hasDefaultLogo: !!business?.defaultLogo
    }, req ?? null);
    const type = logoKey.split('.').pop();
    return `data:image/${type};base64,${buffer.toString('base64')}`;
}

async function fetchImageUrlAsBase64(url) {
    if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        return '';
    }
    try {
        const response = await fetch(url);
        if (!response.ok) return '';
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || '';
        const type = contentType.includes('png') ? 'png' : 'jpeg';
        return `data:image/${type};base64,${Buffer.from(buffer).toString('base64')}`;
    } catch (e) {
        console.warn('[fetchImageUrlAsBase64]', url, e.message);
        return '';
    }
}

async function processPageImageSchemas(pageSchemas, templateInputs) {
    if (!Array.isArray(pageSchemas)) return;
    for (const schema of pageSchemas) {
        if (schema.type !== 'image' || !schema.name) continue;
        const content = schema.content;
        if (typeof content === 'string' && (content.startsWith('http://') || content.startsWith('https://'))) {
            const base64 = await fetchImageUrlAsBase64(content);
            if (base64) templateInputs[schema.name] = base64;
        }
    }
}

async function resolveTemplateImageUrls(template, templateInputs) {
    const pages = template.schemas;
    if (!Array.isArray(pages)) return;
    for (const pageSchemas of pages) {
        await processPageImageSchemas(pageSchemas, templateInputs);
    }
}

function applyTemplateTextDefaults(template, templateInputs) {
    applyTemplateTextDefaultsToPages(template?.schemas, templateInputs);
}

function getTemplateImageContentByName(template, schemaName) {
    const pages = template?.schemas;
    if (!Array.isArray(pages)) return '';
    for (const pageSchemas of pages) {
        if (!Array.isArray(pageSchemas)) continue;
        const match = pageSchemas.find((s) => s?.type === 'image' && s?.name === schemaName);
        if (match && typeof match.content === 'string' && match.content.length > 0) {
            return match.content;
        }
    }
    return '';
}

function ensureMonthlyStatementHeaderFromPage2(template) {
    const pages = template?.schemas;
    if (!Array.isArray(pages) || pages.length < 2) return;

    const headerTextSchemaBase = {
        type: 'text',
        content: 'Monthly Statement',
        position: { x: 20, y: 13.8 },
        width: 120,
        height: 6,
        rotate: 0,
        alignment: 'left',
        verticalAlignment: 'middle',
        fontSize: 20,
        lineHeight: 1,
        characterSpacing: 0,
        fontColor: '#000000',
        backgroundColor: '',
        opacity: 1,
        strikethrough: false,
        underline: false,
        required: false,
        readOnly: true,
        fontName: 'Roboto'
    };

    const logoHeaderSchemaBase = {
        type: 'image',
        content: '',
        position: { x: 174, y: 8 },
        width: 16,
        height: 15.53,
        rotate: 0,
        opacity: 1,
        required: false,
        readOnly: false
    };

    for (let pageIndex = 1; pageIndex < pages.length; pageIndex++) {
        const pageSchemas = pages[pageIndex];
        if (!Array.isArray(pageSchemas)) continue;

        const pageNo = pageIndex + 1;
        const headerName = `headerMonthlyStatement_p${pageNo}`;
        const logoName = `logoHeader_p${pageNo}`;

        const filtered = pageSchemas.filter((s) => s?.name !== headerName && s?.name !== logoName);
        filtered.push(
            { ...headerTextSchemaBase, name: headerName },
            { ...logoHeaderSchemaBase, name: logoName }
        );
        pages[pageIndex] = filtered;
    }
}

// Attribute names for referenced item types
const REF_ATTRIBUTE_NAMES = {
    // Participant Profile attributes
    PROFILE_FULL_NAME: 'Full Name/Preferred Name',
    PROFILE_PREFERRED_NAME: 'Preferred Name',
    PROFILE_FIRST_NAME: 'First Name',
    PROFILE_LAST_NAME: 'Last Name',
    PROFILE_EMAIL: 'Email',
    PROFILE_PRIMARY_PHONE: 'Primary Phone Number',
    PROFILE_MY_AGED_CARE_ID: 'My Aged Care ID Number',
    PROFILE_MY_AGED_CARE_ID_ALT: 'My Aged Care ID',
    PROFILE_ADDRESS: 'Address',
    PROFILE_SUBURB: 'Suburb',
    PROFILE_STATE: 'State',
    PROFILE_POSTCODE: 'Postcode',
    PROFILE_POST_CODE: 'Post Code',
    PROFILE_BILLING_CONTACT: 'Billing Contact',
    PROFILE_BILLING_ADDRESS: 'Billing Address',

    // Client/Contractor attributes
    CLIENT: 'Client',
    CLIENT_EMAIL: 'Email Address',
    CLIENT_PHONE: 'Phone Number',
    CLIENT_ADDRESS: 'Address',
    CLIENT_SUBURB: 'Suburb',
    CLIENT_STATE: 'State',
    CLIENT_POSTCODE: 'Postcode',
    CLIENT_CONTACT_FIRST_NAME: 'Contact Person\'s First Name',
    CLIENT_CONTACT_LAST_NAME: 'Contact Person\'s Last Name',
    CLIENT_UPDATED_AT: 'Updated At',
    CONTRACTOR: 'Contractor',

    // Job Planning/Type attributes
    JOB_NUMBER: 'Job Number',
    JOB_TITLE: 'Job Title',
    JOB_TYPE: 'Job Type',
    JOB_CODE: 'Job Code',
    CLIENT_ORDER_NUMBER: 'Client\'s Order Number',

    // Service Fee Type attributes
    FEE_TYPE: 'Fee Type',
    RATE_GST_EXCL: 'Rate($) - GST Excl.',

    // Service Plan attributes
    SERVICE_PLAN_ID: 'Service Plan ID',
    SERVICE_ID_ITEM_ID: 'Service ID /  Item ID',
    SERVICE_ID_ITEM_ID_ALT: 'Service ID/Item ID',
    SERVICE: 'Service',
    SERVICE_TYPE: 'Service Type',
    UNIT_TYPE: 'Unit Type',
    UNIT: 'Unit',
    PRICE: 'Price ($)',
    AGREED_UNIT_PRICE: 'Agreed Unit Price ($)',
    PARTICIPANT_CONTRIBUTION: 'Participant Contribution (%)',
    PARTICIPANT_CONTRIBUTION_GUIDELINE: 'Participant Contribution Guideline (%)',

    // Item attributes
    ITEM_DESCRIPTION_CODE: 'Item Description Code',
    ITEM_ID: 'Item ID',
    ITEM_DESCRIPTION: 'Item Description',
    ITEM: 'Item',

    // Wraparound attributes
    WRAPAROUND: 'Wraparound',
    WRAPAROUND_DESCRIPTION_CODE: 'Wraparound Description Code',
    WRAPAROUND_ITEM_ID: 'Wraparound Item ID',
    WRAPAROUND_DESCRIPTION: 'Wraparound Description',

    // Health Professional attributes
    HEALTH_PROFESSIONAL_TYPE_CODE: 'Health Professional Type Code',
    HEALTH_PROFESSIONAL_TYPE_OTHER: 'Health Professional Type',

    // NDIS Support Item attributes
    SUPPORT_ITEM_NUMBER: 'Support Item Number',
    SUPPORT_ITEM_NAME: 'Support Item Name',
    SHORT_NOTICE_CANCELLATIONS: 'Short Notice Cancellations',
    LABOUR_TRAVEL_TIME_COSTS: 'Labour Travel Time Costs',

    // NDIS State-based pricing attributes
    ACT_PRICE: 'ACT($)',
    NSW_PRICE: 'NSW($)',
    NT_PRICE: 'NT($)',
    QLD_PRICE: 'QLD($)',
    SA_PRICE: 'SA($)',
    TAS_PRICE: 'TAS($)',
    VIC_PRICE: 'VIC($)',
    WA_PRICE: 'WA($)',
    REMOTE_PRICE: 'Remote($)',
    VERY_REMOTE_PRICE: 'Very Remote($)',

    // NDIS Service Area attributes
    SERVICE_AREA: 'Service Area',

    // NDIS Service Plan specific attributes
    UNIT_DIRECT_SUPPORT: 'Unit (Direct Support)',
    AGREED_PRICE_DIRECT_SUPPORT: 'Agreed Unit Price for Direct Support ($)',
    UNIT_NON_LABOUR_TRAVEL: 'Unit (Provider Travel - Non-Labour Cost)',
    AGREED_PRICE_NON_LABOUR_TRAVEL: 'Agreed Unit Price for Non-Labour Travel ($)',
    UNIT_ACTIVITY_TRANSPORT: 'Unit (Activity Based Transport)',
    AGREED_PRICE_ACTIVITY_TRANSPORT: 'Agreed Price for Activity Based Transport ($)',
    UNIT_CENTRE_CAPITAL: 'Unit (Centre Capital Costs)',
    AGREED_PRICE_CENTRE_CAPITAL: 'Agreed Unit Price for Centre Capital Costs($)',
    UNIT_LABOUR_TRAVEL_TIME: 'Unit (Labour Travel Time)',
    AGREED_PRICE_LABOUR_TRAVEL_TIME: 'Agreed Unit Price for Labour Travel Time ($)',
    UNIT_ALLOWANCES: 'Unit (Allowances)',
    AGREED_PRICE_ALLOWANCES: 'Agreed Price for Allowances($)',
    UNIT_NON_FACE_TO_FACE: 'Unit (Non-Face-to-Face Support)',
    AGREED_PRICE_NON_FACE_TO_FACE: 'Agreed Unit Price for Non-Face-to-Face Support($)',

    // Cancellation Type attributes
    CANCELLATION_DEFINITION: 'Definition',
    BILLABLE_TO_CLIENT: 'Billable to Client %',
    PAYABLE_TO_WORKER: 'Payable to Worker %',

    // Fund attributes
    FUND_AMOUNT: 'Fund Amount($)',
    PREVIOUSLY_USED: 'Previously Used ($)',
    INVOICED_AND_RECEIVED: 'Invoiced and Received Amount($)',

    // Participation Type attributes
    PARTICIPATION_TYPE: 'Participation Type',
    PARTICIPATION_DEFINITION: 'Definition',

    // Aged Care Budget attributes
    TOTAL_BUDGET_HOME_SUPPORT: 'Total Available Budget for Home Support ($)',
    REMAINING_HOME_SUPPORT: 'Remaining Home Support Balance as at the End of the Month ($)',
    TOTAL_BUDGET_RESTORATIVE: 'Total Available Budget for Restorative Care ($)',
    REMAINING_RESTORATIVE: 'Remaining Balance for Allocation Period ($)',
    TOTAL_BUDGET_END_OF_LIFE: 'Total Available Budget for End-of-Life Care ($)',
    TOTAL_BUDGET_AT_SHORT_TERM: 'Total Available Budget for Assistive Technology - Short-term ($)',
    REMAINING_AT_SHORT_TERM: 'Remaining AT - Short-term Balance for Allocation Period ($)',
    COMMITTED_AT_SHORT_TERM: 'Committed AT Short-term Funds - to be delivered ($-)',
    TOTAL_BUDGET_AT_ONGOING: 'Total Available Budget for Assistive Technology - Ongoing ($)',
    REMAINING_AT_ONGOING: 'Remaining AT - Ongoing Balance for Allocation Period ($)',
    COMMITTED_AT_ONGOING: 'Committed AT Ongoing Funds - to be delivered ($-)',
    TOTAL_BUDGET_HOME_MOD: 'Total Available Budget for Home Modification ($)',
    REMAINING_HOME_MOD: 'Remaining HM Balance for Allocation Period ($)',
    COMMITTED_HOME_MOD: 'Committed HM Funds - to be delivered ($-)',
    FUNDING_END_DATE: 'Funding End Date',

    // Funding Source attributes
    FS_NAME: 'Funding Stream',
    FS_DEFINITION: 'Definition'
};

async function bulkFetchReferenceItemsFromDB(workspaceId, boardId, itemIds) {
    if (!itemIds || itemIds.length === 0) return new Map();

    // Remove duplicates and nulls
    const uniqueIds = [...new Set(itemIds.filter((id) => Boolean(id)).map(id => {
        if (typeof id === 'object' && id.id) return id.id.toString();
        if (typeof id === 'object' && id) return id.toString();
        return id?.toString();
    }).filter((id) => Boolean(id)))];

    if (uniqueIds.length === 0) return new Map();

    // First try to fetch from the same board
    let items = await Item.find({
        workspaceId,
        boardId,
        itemId: { $in: uniqueIds }
    }).lean();

    // Build lookup map
    const itemMap = new Map();
    for (const item of items) {
        itemMap.set(item.itemId, item);
    }

    // Check if we're missing any items - they might be in other boards
    const foundIds = new Set(items.map(i => i.itemId));
    const missingIds = uniqueIds.filter(id => !foundIds.has(id));

    if (missingIds.length > 0) {
        // Fetch missing items from ANY board in the workspace
        const crossBoardItems = await Item.find({
            workspaceId,
            itemId: { $in: missingIds }
        }).lean();

        for (const item of crossBoardItems) {
            if (!itemMap.has(item.itemId)) {
                itemMap.set(item.itemId, item);
            }
        }

        // Log items that are still missing after cross-board search
        const stillMissingIds = missingIds.filter(id => !itemMap.has(id));
        if (stillMissingIds.length > 0) {
            console.warn(`[Webhook] ${stillMissingIds.length} reference items not found in database`);
        }
    }

    info('Webhook-Service', 'Bulk fetch reference items (webhook)', {
      requested: uniqueIds.length,
      found: itemMap.size
    });
    return itemMap;
}

function extractRefId(value) {
    if (!value) return null;
    if (Array.isArray(value) && value.length > 0) {
        const first = value[0];
        if (typeof first === 'object' && first.id) return first.id.toString();
        if (typeof first === 'string') return first;
        return first?.toString();
    }
    if (typeof value === 'object' && value.id) return value.id.toString();
    if (typeof value === 'string') return value;
    return value?.toString();
}

function getValueFromFlatData(item, attributeName) {
    if (!item?.data) return null;

    // Handle array of attribute names (try each until one is found)
    const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];

    for (const attrName of attributeNames) {
        // Check flat format (data.key)
        if (item.data[attrName] !== undefined && item.data[attrName] !== null) {
            return item.data[attrName];
        }
    }

    // Check values array format (data.values) - for older format support
    if (Array.isArray(item.data.values)) {
        for (const attrName of attributeNames) {
            const entry = item.data.values.find(v => v.attribute?.name === attrName);
            if (entry?.data !== undefined && entry?.data !== null) {
                return entry.data;
            }
        }
    }

    return null;
}

function getParticipantNameFromProfile(profileItem) {
    if (!profileItem) return null;

    // Try different name attributes
    const nameAttrs = [
        REF_ATTRIBUTE_NAMES.PROFILE_PREFERRED_NAME,
        REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME,
        'Full Name',
        'Preferred Name',
        'Name'
    ];

    const name = getValueFromFlatData(profileItem, nameAttrs);
    if (!name) return null;

    // Handle object format
    if (typeof name === 'object' && name.name) return name.name;
    return String(name);
}

function getAddressFromProfile(profileItem) {
    if (!profileItem) return { address: '', suburb: '', state: '', postcode: '' };

    const address = getValueFromFlatData(profileItem, [
        REF_ATTRIBUTE_NAMES.PROFILE_ADDRESS,
        'Address'
    ]) || '';

    const suburb = getValueFromFlatData(profileItem, [
        REF_ATTRIBUTE_NAMES.PROFILE_SUBURB,
        'Suburb'
    ]) || '';

    const stateValue = getValueFromFlatData(profileItem, [
        REF_ATTRIBUTE_NAMES.PROFILE_STATE,
        'State'
    ]);
    const state = stateValue ? (typeof stateValue === 'object' && stateValue.name ? stateValue.name : String(stateValue)) : '';

    const postcode = getValueFromFlatData(profileItem, [
        REF_ATTRIBUTE_NAMES.PROFILE_POSTCODE,
        REF_ATTRIBUTE_NAMES.PROFILE_POST_CODE,
        'Postcode',
        'Post Code'
    ]) || '';

    return { address, suburb, state, postcode };
}

function getServiceFromServicePlan(servicePlanItem) {
    if (!servicePlanItem) return null;

    const servicePlanIdValue = getValueFromFlatData(servicePlanItem, REF_ATTRIBUTE_NAMES.SERVICE_PLAN_ID);
    if (!servicePlanIdValue) return null;

    const servicePlanIdStr = String(servicePlanIdValue).trim();
    if (servicePlanIdStr.includes(' - ')) {
        const parts = servicePlanIdStr.split(' - ');
        return parts.length >= 2 ? parts[1].trim() : servicePlanIdStr;
    } else if (servicePlanIdStr.includes('-')) {
        const parts = servicePlanIdStr.split('-');
        return parts.length >= 2 ? parts.slice(1).join('-').trim() : servicePlanIdStr;
    }
    return servicePlanIdStr;
}

function formatLabelValue(value, labels = []) {
    if (!value) return '';
    if (Array.isArray(value) && value.length > 0) {
        return value.map(id => {
            if (typeof id === 'object' && id.name) return id.name;
            const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
            return label ? label.name : (typeof id === 'object' ? id.name : String(id));
        }).filter((name) => Boolean(name)).join(', ');
    }
    if (typeof value === 'object' && value.name) return value.name;
    if (typeof value === 'object' && value.id) {
        const label = labels.find(l => l.id === value.id);
        return label ? label.name : (value.name || String(value.id));
    }
    if (typeof value === 'string') {
        const label = labels.find(l => l.id === value);
        return label ? label.name : value;
    }
    return String(value);
}

async function saveInvoiceNumber(workspaceId, boardId, itemId, invoiceNumber, type, pdfLink = null) {
    try {
        await InvoiceNumber.findOneAndUpdate(
            {
                itemId: itemId,
                workspaceId: workspaceId,
                boardId: boardId,
                type: type
            },
            {
                $set: {
                    itemId: itemId,
                    workspaceId: workspaceId,
                    boardId: boardId,
                    invoiceNumber: invoiceNumber,
                    type: type,
                    pdfLink: pdfLink,
                    updatedAt: new Date()
                },
                $setOnInsert: {
                    createdAt: new Date()
                }
            },
            {
                upsert: true,
                new: true
            }
        );
    } catch (err) {
        // Log error but don't fail the invoice generation if saving fails
        warn('Webhook-Service', 'Failed to save invoice number to database', {
            workspaceId,
            boardId,
            itemId,
            invoiceNumber,
            type,
            error: err.message
        }, {});
    }
}

function formatValue(val) {
    const num = Number(val);
    if (!isNaN(num)) {
        const factor = Math.pow(10, 2);
        const result = Math.round(num * factor) / factor;

        return result.toFixed(2);
    } else {
        return val;
    }
}

function parseNumberValue(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const stringValue = value.toString();
    if (!stringValue) return 0;
    let s = stringValue.trim();
    if (!s) return 0;

    // Normalize unicode minus to ASCII hyphen-minus.
    s = s.replace(/[\u2212\u2012\u2013\u2014]/g, '-');

    let negative = false;
    // Parentheses mean negative in many exports.
    if (/\(.*\)/.test(s)) {
        negative = true;
        s = s.replace(/[()]/g, '');
    }
    // Trailing minus means negative.
    if (/-\s*$/.test(s)) {
        negative = true;
        s = s.replace(/-\s*$/, '');
    }

    const cleaned = s.replace(/[^0-9.+-]/g, '');
    const parsed = parseFloat(cleaned);
    if (!Number.isFinite(parsed)) return 0;
    if (negative && parsed > 0) return -Math.abs(parsed);
    return parsed;
}

function formatCurrencyValue(value) {
    const num = parseNumberValue(value);
    const formatted = formatValue(num);
    return num < 0 ? `-$${formatted.replace(/^-/, '')}` : `$${formatted}`;
}

function formatDateToAU(value, timezone) {
    if (!value) return '';
    // If the value is already a dd/MM/yyyy formatted string, return it as-is
    if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value.trim())) {
        return value.trim();
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    const effectiveTimezone = timezone || 'Australia/Sydney';
    const options = {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: effectiveTimezone
    };
    return new Intl.DateTimeFormat('en-AU', options).format(date);
}

function formatDateNumericAU(value, timeZone) {
    if (!value) return new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric', timeZone: timeZone || 'Australia/Sydney' });
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric', timeZone: timeZone || 'Australia/Sydney' });
}

function safeString(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return value.name || value.id || '';
    return String(value);
}

function initializeBudgetAggregate() {
    return {
        availableFundStart: 0,
        quarterlyAdjustment: 0,
        primarySupplementAmount: 0,
        carryoverFunding: 0,
        unspentReturned: 0,
        commonwealthUnspent: 0,
        providerUnspent: 0,
        participantUnspent: 0,
        previousMonthSpending: 0,
        totalAvailableBudget: 0,
        deliveredAmount: 0,
        adjustmentAmount: 0,
        remainingBalance: 0,
        committedFunds: 0,
        remainingBalanceEndOfMonth: 0,
        remainingBalanceAllocationPeriod: 0,
        fundAmount: 0,
        additionalAmountApproved: 0,
        govSubsidyAmount: 0,
        participantContributionAmount: 0,
        fund: '',
        fundClassification: '',
        primarySupplementLabel: '',
        quarterLabel: '',
        months: new Set(),
        fundingStartDate: null,
        fundingEndDate: null,
        hscmTotalAllocatedTime: 0,
        hscmTotalReceivedAmount: 0,
        hscmTotalAllocatedAmount: 0,
        hscmItemCount: 0
    };
}

function calculateBudgetAggregates(items = []) {
    const getItemTime = (item) => {
        const v = item?.updatedAt || item?.createdAt || null;
        if (!v) return 0;
        const d = v instanceof Date ? v : new Date(v);
        const t = d.getTime();
        return Number.isFinite(t) ? t : 0;
    };

    const latestByCode = {};
    items.forEach((item) => {
        const code = item?.categoryCode || 'HSQ';
        const t = getItemTime(item);
        if (!latestByCode[code] || t >= latestByCode[code].t) {
            latestByCode[code] = { t, item };
        }
    });

    const aggregates = {};
    Object.entries(latestByCode).forEach(([code, entry]) => {
        const item = entry?.item || {};
        const aggregate = initializeBudgetAggregate();

        aggregate.availableFundStart = parseNumberValue(item.availableFundStart);
        aggregate.quarterlyAdjustment = parseNumberValue(item.quarterlyAdjustment);
        aggregate.primarySupplementAmount = parseNumberValue(item.primarySupplementAmount);
        aggregate.carryoverFunding = parseNumberValue(item.carryoverFunding);
        aggregate.unspentReturned = parseNumberValue(item.unspentReturned);
        aggregate.commonwealthUnspent = parseNumberValue(item.commonwealthUnspent);
        aggregate.providerUnspent = parseNumberValue(item.providerUnspent);
        aggregate.participantUnspent = parseNumberValue(item.participantUnspent);
        aggregate.previousMonthSpending = parseNumberValue(item.previousMonthSpending);
        aggregate.totalAvailableBudget = parseNumberValue(item.totalAvailableBudget);
        aggregate.deliveredAmount = parseNumberValue(item.deliveredAmount);
        aggregate.adjustmentAmount = parseNumberValue(item.adjustmentAmount);
        aggregate.remainingBalance = parseNumberValue(item.remainingBalance);
        aggregate.committedFunds = parseNumberValue(item.committedFunds);
        aggregate.remainingBalanceEndOfMonth = parseNumberValue(item.remainingBalanceEndOfMonth);
        aggregate.remainingBalanceAllocationPeriod = parseNumberValue(item.remainingBalanceAllocationPeriod);
        aggregate.fundAmount = parseNumberValue(item.fundAmount);
        aggregate.additionalAmountApproved = parseNumberValue(item.additionalAmountApproved);
        aggregate.govSubsidyAmount = parseNumberValue(item.govSubsidyAmount);
        aggregate.participantContributionAmount = parseNumberValue(item.participantContributionAmount);

        // Track HSCM-specific snapshot fields (not summed)
        if (code === 'HSCM') {
            aggregate.hscmTotalAllocatedTime = parseNumberValue(item.hscmAllocatedTime);
            aggregate.hscmTotalReceivedAmount = parseNumberValue(item.hscmReceivedAmount);
            aggregate.hscmTotalAllocatedAmount = parseNumberValue(item.hscmAllocatedAmount);
            aggregate.hscmItemCount = 1;
        }

        aggregate.primarySupplementLabel =
            safeString(item.primarySupplementLabel) || safeString(item.fundClassification) || safeString(item.fund) || '';
        aggregate.fund = safeString(item.fund) || '';
        aggregate.fundClassification = safeString(item.fundClassification) || '';
        aggregate.quarterLabel = item.quarter ? safeString(item.quarter) : '';

        aggregate.fundingStartDate = item.fundingStartDate || null;
        aggregate.fundingEndDate = item.fundingEndDate || null;

        aggregates[code] = aggregate;
    });

    return aggregates;
}

/**
 * Enrich a budget aggregate with values from a frontend budgetCategory object.
 * The budgetCategories (from the items endpoint) include profile-data fallbacks,
 * so they always reflect the correct values shown on the web page.
 * For each numeric field, if the aggregate value is 0, the category value is used.
 * For label/date fields, the category value is used if the aggregate value is empty.
 */
function enrichAggregateFromCategory(aggregate, category) {
    if (!category || !aggregate) return;

    const numericFields = {
        availableFundStart: 'availableFundStart',
        quarterlyAdjustment: 'quarterlyAdjustment',
        primarySupplementAmount: 'primarySupplementAmount',
        carryoverFunding: 'carryoverFunding',
        unspentReturned: 'unspentReturned',
        commonwealthUnspent: 'commonwealthUnspent',
        providerUnspent: 'providerUnspent',
        participantUnspent: 'participantUnspent',
        previousMonthSpending: 'previousMonthSpending',
        fundAmount: 'fundAmount',
        additionalAmountApproved: 'additionalAmountApproved',
        adjustmentAmount: 'adjustmentAmount',
        committedFunds: 'committedFunds',
        govSubsidyAmount: 'govSubsidyAmount',
        participantContributionAmount: 'participantContributionAmount',
        remainingBalanceAllocationPeriod: 'remainingBalanceAllocationPeriod'
    };

    // Fields with different names between category and aggregate
    const mappedFields = [
        { aggField: 'totalAvailableBudget', catFields: ['totalAvailableBudget', 'availableFunds'] },
        { aggField: 'deliveredAmount', catFields: ['deliveredAmount', 'serviceDeliveredAmount'] },
        { aggField: 'remainingBalance', catFields: ['remainingBalance', 'remainingBudget'] }
    ];

    enrichNumericAggregateFields(aggregate, category, numericFields, mappedFields, parseNumberValue);
    enrichLabelAggregateFields(aggregate, category, safeString);
}

function getQuarterMetadata(monthNumber, year, fallbackQuarterLabel, timezone) {
    const monthIndex = Number(monthNumber) || 1;
    const effectiveYear = Number(year) || new Date().getFullYear();
    const monthNo = ((monthIndex - 1) % 3) + 1;
    const quarterNumber = Math.floor((monthIndex - 1) / 3) + 1;
    const firstDay = new Date(Date.UTC(effectiveYear, monthIndex - 1, 1));
    const lastDay = new Date(Date.UTC(effectiveYear, monthIndex, 0));

    return {
        monthNo,
        quarterLabel: fallbackQuarterLabel || `Q${quarterNumber}`,
        firstDay: formatDateToAU(firstDay, timezone),
        lastDay: formatDateToAU(lastDay, timezone)
    };
}

const SERVICE_BUCKET_TEMPLATES = {
    HSQ: { delivered: [], adjustment: [] },
    RCP: { delivered: [], adjustment: [] },
    EOL: { delivered: [], adjustment: [] },
    ATS: { delivered: [], adjustment: [], committed: [] },
    ATO: { delivered: [], adjustment: [], committed: [] },
    HMB: { delivered: [], adjustment: [], committed: [] }
};

function determineFundingCode(service = {}) {
    const source = (service.fundingSource || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
    const category = (service.serviceCategory || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
    const notes = (service.notes || service.taskName || service.service || '').toString().toLowerCase();

    const hasHmToken = (s) => /(^|[^a-z])hm([^a-z]|$)/.test(s) || s.includes('(hm)') || s.includes('home mod');
    const isAtShort = (s) =>
        ((s.includes('assistive') || /(^|[^a-z])at([^a-z]|$)/.test(s)) && (s.includes('short-term') || s.includes('short term') || s.includes('short'))) ||
        (s.includes('at - short') || s.includes('at short'));
    const isAtOngoing = (s) =>
        ((s.includes('assistive') || /(^|[^a-z])at([^a-z]|$)/.test(s)) && s.includes('ongoing')) ||
        (s.includes('at - ongoing') || s.includes('at ongoing'));
    const isHomeModification = (s) =>
        s.includes('home modification') || s.includes('modification') || hasHmToken(s);

    if (source.includes('home support')) return 'HSQ';
    if (source.includes('restorative')) return 'RCP';
    if (source.includes('end-of-life') || source.includes('end of life')) return 'EOL';
    if (isAtShort(source)) return 'ATS';
    if (isAtOngoing(source)) return 'ATO';
    if (isHomeModification(source)) return 'HMB';

    if (category.includes('home support')) return 'HSQ';
    if (category.includes('restorative')) return 'RCP';
    if (category.includes('end-of-life') || category.includes('end of life')) return 'EOL';
    if (isAtShort(category)) return 'ATS';
    if (isAtOngoing(category)) return 'ATO';
    if (isHomeModification(category)) return 'HMB';

    if (isAtShort(notes)) return 'ATS';
    if (isAtOngoing(notes)) return 'ATO';
    if (isHomeModification(notes)) return 'HMB';

    return 'HSQ';
}

function createServiceBuckets() {
    return {
        HSQ: { delivered: [], adjustment: [] },
        RCP: { delivered: [], adjustment: [] },
        EOL: { delivered: [], adjustment: [] },
        ATS: { delivered: [], adjustment: [], committed: [] },
        ATO: { delivered: [], adjustment: [], committed: [] },
        HMB: { delivered: [], adjustment: [], committed: [] }
    };
}

function truncateText(text, length) {
    if (!text) return '';
    const stringValue = text.toString();
    return stringValue.length > length ? `${stringValue.substring(0, length)}` : stringValue;
}

function setCurrencyField(target, fieldName, value) {
    if (!fieldName) return;
    target[fieldName] = formatCurrencyValue(value);
}

function setMultiValueField(target, fieldName, payload) {
    if (!fieldName || payload === undefined) return;
    target[fieldName] = JSON.stringify(payload);
}

function cleanRichText(value) {
    if (!value) return '';
    // Convert common HTML formatting into plain text with sensible spacing/line breaks.
    // This is used for PDF output (pdfme) where HTML cannot be rendered.
    return value
        .toString()
        .replace(/\r\n|\r/g, '\n')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
        .replace(/<\s*li\s*>/gi, '• ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeTableCell(value) {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    if (typeof value === 'string') {
        // Ensure it's a valid string that pdfme can handle
        return value.trim();
    }
    if (typeof value === 'number') {
        return value.toString();
    }
    if (typeof value === 'boolean') {
        return value ? 'Yes' : 'No';
    }
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeTableCell(entry)).filter((entry) => Boolean(entry)).join(', ');
    }
    if (typeof value === 'object' && value !== null) {
        const normalized = Object.values(value)
            .map((entry) => normalizeTableCell(entry))
            .filter((entry) => entry)
            .join(', ');
        return normalized || '';
    }
    // Fallback for any other type
    try {
        return String(value) || '';
    } catch {
        return '';
    }
}

// SERVICE_TABLE_CONFIG: Maps funding codes to template table field names (must match monthlyStatement.json exactly)
const SERVICE_TABLE_CONFIG = {
    HSQ: {
        delivered: {
            tableName: 'Table P6-1 copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: [['$P6-1  copy', '$P3-3'], ['$P6-2 copy', '$P3-4'], ['$P6-3 copy', '$P3-5']],
            rowType: 'delivered'
        },
        adjustment: {
            tableName: 'Table P7-1 copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P7-1 copy', '$P7-2 copy', '$P7-3 copy'],
            rowType: 'adjustment'
        }
    },
    RCP: {
        // RCP uses Table P12-1 copy copy and Table P12-3 copy copy in the template for service tables
        delivered: {
            tableName: 'Table P12-1  copy copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-1  copy copy', '$P11-3   copy copy', '$P12-3  copy copy'],
            rowType: 'delivered'
        },
        adjustment: {
            tableName: 'Table P12-3  copy copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-7  copy copy', '$P11-8 copy copy copy', '$P11-9 1 copy copy copy'],
            rowType: 'adjustment'
        }
    },
    EOL: {
        delivered: {
            tableName: 'Table P9-1',
            // Provider column removed per spec; ", by {Associated Provider}" is shown in Service when Delivered by = Associated Providers
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P9-1', '$P9-2', '$P9-3'],
            rowType: 'delivered'
        },
        adjustment: {
            tableName: 'Table P9-2',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P9-4', '$P9-5', '$P9-6'],
            rowType: 'adjustment'
        }
    },
    ATS: {
        delivered: {
            tableName: 'Table P10-1  copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P10-1  copy', '$P10-3 copy', '$P10-3  copy'],
            rowType: 'delivered'
        },
        adjustment: {
            tableName: 'Table P10-3 copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P10-7 copy', '$P10-8 copy', '$P10-9 copy'],
            rowType: 'adjustment'
        },
        committed: {
            tableName: 'Table P10-2 copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P10-4 copy', '$P10-5 copy', '$P10-6 copy'],
            rowType: 'committed'
        }
    },
    ATO: {
        delivered: {
            tableName: 'Table P11-1  copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P11-1 copy', '$P11-3  copy', '$P11-3 copy'],
            rowType: 'delivered'
        },
        adjustment: {
            tableName: 'Table P11-3  copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P11-7  copy', '$P11-8 copy', '$P11-9 1 copy'],
            rowType: 'adjustment'
        },
        committed: {
            tableName: 'Table P11-2 copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P11-4 copy', '$P11-5 copy', '$P11-6 copy'],
            rowType: 'committed'
        }
    },
    HMB: {
        delivered: {
            tableName: 'Table P12-1  copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-1  copy', '$P11-3   copy', '$P12-3  copy'],
            rowType: 'delivered'
        },
        adjustment: {
            tableName: 'Table P12-3  copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-7  copy', '$P11-8 copy copy', '$P11-9 1 copy copy'],
            rowType: 'adjustment'
        },
        committed: {
            tableName: 'Table P11-2 copy copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-4  copy', '$P11-5 copy copy', '$P11-6  copy'],
            rowType: 'committed'
        }
    }
};

const SERVICE_TABLE_TOTAL_ORDER = ['amount', 'gov', 'participant'];

function normalizeStatus(value) {
    if (!value) return '';
    if (typeof value === 'string') {
        return value.toLowerCase();
    }
    if (typeof value === 'object' && value !== null) {
        return (value.name || value.toString()).toLowerCase();
    }
    return value.toString().toLowerCase();
}

function resolveServiceProviderName(service = {}, business) {
    const deliveredByStr = (service.deliveredBy || '').toString().toLowerCase();
    if (deliveredByStr.includes('associated')) {
        return service.serviceProvider || service.associatedProvider || '';
    }
    if (deliveredByStr.includes('company workforce')) {
        return business?.name || service.serviceProvider || '';
    }
    return '';
}

/** Only append ", by {Associated Provider}" when Delivered by is Associated Providers (per spec; provider column removed). */
function isDeliveredByAssociatedProviders(service = {}) {
    const deliveredByStr = (service.deliveredBy || '').toString().toLowerCase();
    return deliveredByStr.includes('associated');
}

function resolveServiceDateValue(service = {}, rowType = 'delivered', timezone) {
    if (rowType === 'committed') {
        return 'To be delivered';
    }
    const status = normalizeStatus(service.transactionStatus);
    if (status.includes('adjust') || status.includes('refund') || status.includes('charge')) {
        const appliedAt = service.updatedAt || service.createdAt || service.serviceDeliveryDate || service.actualEnd || service.scheduledStart;
        return formatDateToAU(appliedAt, timezone);
    }
    if (status.includes('cancelled')) {
        return formatDateToAU(service.scheduledServiceDate || service.scheduledStart || service.scheduledShiftStart, timezone);
    }
    return formatDateToAU(
        service.serviceDeliveryDate ||
        service.actualEnd ||
        service.actualStart ||
        service.scheduledServiceDate ||
        service.scheduledStart,
        timezone
    );
}

function mapServiceColumnValue(service, column, rowType, business, timezone) {
    switch (column) {
        case 'date': {
            return resolveServiceDateValue(service, rowType, timezone);
        }
        case 'provider': {
            const provider = resolveServiceProviderName(service, business) || service.worker || business?.name || '';
            return truncateText(provider, 20);
        }
        case 'service': {
            const baseName = (service.service || service.taskName || '').toString().trim();
            const notesText = cleanRichText(service.notes);
            const providerName = isDeliveredByAssociatedProviders(service) ? resolveServiceProviderName(service, business) : '';
            if (!baseName && notesText) {
                return truncateText(notesText, 2000);
            }

            const serviceLine = baseName
                ? (providerName ? `${baseName}, by ${providerName}` : baseName)
                : 'Service';

            const baseLower = baseName.toLowerCase();
            const notesLower = notesText.toLowerCase();
            const shouldAppendNotes = !!notesText && (!baseName || !baseLower.includes(notesLower));
            const enrichedName = shouldAppendNotes ? `${serviceLine}\n${notesText}` : serviceLine;
            return truncateText(enrichedName, 2000);
        }
        case 'unit':
            return service.unit || 'Unit';
        case 'quantity': {
            const quantity = parseNumberValue(service.quantity);
            return formatValue(quantity);
        }
        case 'unitPrice': {
            const unitPrice = parseNumberValue(service.unitPrice);
            return formatCurrencyValue(unitPrice);
        }
        case 'totalAmount': {
            const totalAmount = parseNumberValue(service.totalAmount);
            return formatCurrencyValue(totalAmount);
        }
        case 'govSubsidy': {
            const gov = parseNumberValue(service.govSubsidy);
            return formatCurrencyValue(gov);
        }
        case 'participantContribution': {
            const participant = parseNumberValue(service.participantContribution);
            return formatCurrencyValue(participant);
        }
        default:
            return '';
    }
}

function createPlaceholderRow(columns, rowType) {
    return columns.map((column) => {
        if (column === 'service') {
            return rowType === 'committed' ? 'No committed services for this period' : 'No services recorded for this period';
        }
        if (column === 'date' && rowType === 'committed') {
            return 'To be delivered';
        }
        if (['totalAmount', 'govSubsidy', 'participantContribution', 'unitPrice'].includes(column)) {
            return '$0.00';
        }
        if (column === 'quantity') {
            return '0.00';
        }
        return '';
    });
}

function getServiceSortDate(service, rowType = 'delivered') {
    if (rowType === 'committed') return null;
    const status = normalizeStatus(service.transactionStatus);
    if (status.includes('adjust') || status.includes('refund') || status.includes('charge')) {
        const raw = service.updatedAt || service.createdAt || service.serviceDeliveryDate || service.actualEnd || service.scheduledStart;
        if (!raw) return null;
        const d = raw instanceof Date ? raw : new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    const dateStr = status.includes('cancelled')
        ? (service.scheduledServiceDate || service.scheduledStart || service.scheduledShiftStart)
        : (service.serviceDeliveryDate || service.actualEnd || service.actualStart || service.scheduledServiceDate || service.scheduledStart);
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return Number.isNaN(d.getTime()) ? null : d;
}

function buildServiceTableRows(services = [], config = {}, business, timezone) {
    const { columns = [], rowType = 'delivered' } = config;
    const totals = { amount: 0, gov: 0, participant: 0 };

    const sortedServices = [...services].sort((a, b) => {
        const dateA = getServiceSortDate(a, rowType);
        const dateB = getServiceSortDate(b, rowType);
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateA.getTime() - dateB.getTime();
    });

    const rawRows = sortedServices.map((service) => {
        const totalAmount = parseNumberValue(service.totalAmount);
        const gov = parseNumberValue(service.govSubsidy);
        const participant = parseNumberValue(service.participantContribution);

        totals.amount += totalAmount;
        totals.gov += gov;
        totals.participant += participant;

        return columns.map((column) => mapServiceColumnValue(service, column, rowType, business, timezone));
    });

    const baseRows = rawRows.length > 0 ? rawRows : [createPlaceholderRow(columns, rowType)];

    const rows = baseRows.map((row) =>
        columns.map((_, colIndex) => normalizeTableCell(row?.[colIndex]))
    );

    return { rows, totals };
}

function applyBudgetMappingEntry(templateInputs, entry, aggregate, setCurrencyField, setMultiValueField) {
  const value = typeof entry.value === 'function' ? entry.value(aggregate) : entry.value;
  const fields = Array.isArray(entry.field) ? entry.field : [entry.field];
  if (entry.type === 'currency') {
    for (let i = 0; i < fields.length; i++) {
      setCurrencyField(templateInputs, fields[i], value);
    }
    return;
  }
  if (entry.type === 'multi') {
    for (let i = 0; i < fields.length; i++) {
      setMultiValueField(templateInputs, fields[i], value);
    }
  }
}

function applyBudgetMapping(templateInputs, aggregate, mappings = []) {
    for (let i = 0; i < mappings.length; i++) {
        applyBudgetMappingEntry(templateInputs, mappings[i], aggregate, setCurrencyField, setMultiValueField);
    }
}

function validateRequestParams(req) {
    const { workspaceId, boardId } = req.params;
    if (!req.body.items?.length) {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, req ?? null);
        throw new Error('No items found in the payload');
    }
    return { workspaceId, boardId };
}

async function handlePDFSuccess(workspaceId, boardId, itemId, fileUrl, docType, req, res) {
    await setIntegrationMessage(workspaceId, boardId, itemId, `Your ${docType} has been successfully created.\n`);
    await setPDFLinkAttribute(workspaceId, boardId, itemId, fileUrl, docType);
    logAuditTrail({
        workspaceId,
        action: `Generate PDF ${docType}`,
        detail: `Resource ID: ${itemId}, Link: ${fileUrl}`,
        req
    });
    await PDFLink.insertOne({
        workspaceId,
        itemId,
        type: docType,
        pdfLink: fileUrl,
        createdBy: "",
        isDeleted: false,
        SignatureStatus: "Unsigned"
    });
    info('Webhook-Service', `Successfully generating PDF ${docType.toLowerCase()}`, { link: fileUrl }, req ?? null);
    return res.json({ pdfUrl: fileUrl });
}

function appendInvoiceLine(description, label, amount, gst) {
    const gstLabel = gst === '10%' ? '10%' : 'GST Free';
    return {
        description: `${description},["${label}", "1", "${formatValue(amount)}", "${gstLabel}", "${formatValue(amount)}"]`,
        subTotalDelta: parseFloat(amount),
    };
}

function buildStandardInvoiceDescription(invoiceValues, jobPlanningValues, serviceFeeTypeValues) {
    const gst = invoiceValues.GST === '10%' ? '10%' : '0%';
    const serviceFee = invoiceValues['Payable Service Fee($) - GST Excl.'];
    let invoiceDescription = `[["${jobPlanningValues.jobTitle}-${serviceFeeTypeValues.feeType}-${formatValue(invoiceValues['Job Duration (Hrs.)'])}Hrs.", "1", "${formatValue(serviceFee)}", "${gst === '10%' ? '10%' : 'GST Free'}", "${formatValue(serviceFee)}"]`;
    let subTotal = parseFloat(serviceFee);

    if (invoiceValues['Payable Material Fee($) - GST Excl.'] > 0) {
        const line = appendInvoiceLine(invoiceDescription, 'Used Material/Part', invoiceValues['Payable Material Fee($) - GST Excl.'], gst);
        invoiceDescription = line.description;
        subTotal += line.subTotalDelta;
    }

    if (invoiceValues['Other Payable Fee($) - GST Excl.'] > 0) {
        const line = appendInvoiceLine(invoiceDescription, 'Other Payable Fee', invoiceValues['Other Payable Fee($) - GST Excl.'], gst);
        invoiceDescription = line.description;
        subTotal += line.subTotalDelta;
    }

    return { invoiceDescription: `${invoiceDescription}]`, subTotal, gst };
}

async function processWebhookInvoiceItem(req, res, workspaceId, boardId, business, item) {
    await validateItemBelongsToTenant(workspaceId, boardId, item.id);
    await setIntegrationMessage(workspaceId, boardId, item.id, 'Running...');

    const [jobPlanningValues, serviceFeeTypeValues] = await getJobReportingReferencedItems(workspaceId, boardId, item.id);
    if (!jobPlanningValues) {
        throw new Error('Job planning information is required. Job reporting is missing a job planning reference.');
    }
    if (!serviceFeeTypeValues) {
        throw new Error('Service fee type information is required. Job reporting is missing a service fee type reference.');
    }

    const [contactValues] = await getJobPlanningReferencedItems(workspaceId, boardId, jobPlanningValues.id);
    if (!contactValues) {
        throw new Error('Client information is required. Job planning is missing a client reference.');
    }

    const templatePath = path.join(__dirname, '..', 'assets', 'invoice.json');
    const templateData = await fs.readFile(templatePath, 'utf8');
    const template = JSON.parse(templateData);
    enableRepeatHeadOnTables(template);

    const logoBase64 = await getLogoData(business);
    const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;
    const invoiceValues = item.values;
    const invoiceDate = invoiceValues['Issue Date'] ? invoiceValues['Issue Date'].replace('Z', '') : '';
    const dueDate = invoiceValues['Due Date'] ? invoiceValues['Due Date'].replace('Z', '') : '';
    const { invoiceDescription, subTotal: subTotalRaw, gst } = buildStandardInvoiceDescription(
        invoiceValues, jobPlanningValues, serviceFeeTypeValues
    );

    const subTotal = formatValue(subTotalRaw);
    const gstTotal = formatValue((subTotal * parseFloat(gst) / 100));
    const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

    const clientDetails = {
        Address: contactValues.address,
        Suburb: contactValues.suburb,
        State: contactValues.state,
        Postcode: contactValues.postcode,
        Client: contactValues.client,
    };

    const pdfBytes = await generate({
        template,
        inputs: [
            {
                logo: logoBase64,
                subtotal: subTotal,
                totalGST: gstTotal,
                total,
                clientDetails: JSON.stringify(clientDetails),
                invoiceDetails: JSON.stringify({
                    Date: formatDateNumericAU(invoiceDate || null, business?.headOfficeTimezone),
                    'Invoice Number': invoiceNumber,
                }),
                companyName: JSON.stringify({ 'Company Name': business.name }),
                companyDetails: JSON.stringify({
                    ABN: business.abn,
                    'Street Address': business.address.street,
                    Suburb: business.address.suburb,
                    State: business.address.state,
                    Postcode: business.address.postcode,
                    Country: business.address.country,
                }),
                orders: invoiceDescription,
                dueDate: formatDateNumericAU(dueDate || null, business?.headOfficeTimezone),
                'Bank Details': JSON.stringify({
                    'Account Name': business.bankDetails.accountName,
                    'Bank Name': business.bankDetails.bankName,
                    BSB: business.bankDetails.bsb,
                    'Account Number': business.bankDetails.accountNumber,
                    'invoice Number': invoiceNumber,
                }),
            },
        ],
        plugins: { text, image, line, table, multiVariableText },
    });

    const filename = `output/${workspaceId}/${boardId}/invoices/${invoiceNumber + '-ISO+™-' + item.id}.pdf`;
    const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, true);

    if (uploadResult['$metadata'].httpStatusCode !== 200) {
        throw new Error('Upload of PDF failed, please provide correct information.');
    }

    const fileUrl = await getS3FileUrl(filename, 3600, true);
    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'Invoice', req, res);
    await setGeneratedField(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`);
    await saveInvoiceNumber(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`, 'PDF', fileUrl);
    business.documentNumbering.invoice.nextNumber += 1;
    await business.save();
}

router.post('/:workspaceId/:boardId/invoice', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        await Promise.all(req.body.items.map(async (item) => {
            try {
                await processWebhookInvoiceItem(req, res, workspaceId, boardId, business, item);
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF Invoice', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/purchaseorder', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [contractorValues, jobTypeValues] = await getPurchaseOrderReferencedItems(workspaceId, boardId, item.id);
                if (!contractorValues) {
                    throw new Error("Contractor information is required. Purchase order is missing Contractor.");
                }
                if (!jobTypeValues) {
                    throw new Error("Job type information is required. Purchase order is missing Job Type.");
                }

                const templatePath = path.join(__dirname, '..', 'assets', 'purchaseorder.json');
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                enableRepeatHeadOnTables(template);

                const logoBase64 = await getLogoData(business);

                const purchaseOrderNumber = business.documentNumbering.purchaseOrder.prefix + business.documentNumbering.purchaseOrder.nextNumber;

                const clientDetails = {
                    Address: contractorValues.address,
                    Suburb: contractorValues.suburb,
                    State: contractorValues.state,
                    Postcode: contractorValues.postcode,
                    Supplier: contractorValues.contractor
                };

                const purchaseOrderValues = item.values;
                const gst = purchaseOrderValues["GST"] == "10%" ? "10%" : "0%";
                const issueDate = purchaseOrderValues["Issue Date"] ? purchaseOrderValues["Issue Date"].replace('Z', '') : "";
                const deliveryDate = purchaseOrderValues["Delivery Date"] ? purchaseOrderValues["Delivery Date"].replace('Z', '') : "";
                let subTotal = formatValue((purchaseOrderValues.Quantity || 1) * (purchaseOrderValues['Unit Price($) - GST Excl.'] || 1));
                let gstTotal = formatValue((subTotal * parseFloat(gst) / 100));
                let total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

                const inputs = {
                    logo: logoBase64,
                    subtotal: subTotal,
                    totalGST: gstTotal,
                    total: total,
                    clientDetails: JSON.stringify(clientDetails),
                    companyDetails: JSON.stringify({
                        ABN: business.abn,
                        "Street Address": business.address.street,
                        Suburb: business.address.suburb,
                        State: business.address.state,
                        Postcode: business.address.postcode,
                        Country: business.address.country
                    }),
                    quoteDetails: JSON.stringify({
                        "Issue Date": formatDateNumericAU(issueDate || null, business?.headOfficeTimezone),
                        "expiry Date": formatDateNumericAU(deliveryDate || null, business?.headOfficeTimezone),
                        "PO Number": purchaseOrderNumber
                    }),
                    companyName: JSON.stringify({ "Company Name": business.name }),
                    termsInput: JSON.stringify({
                        "Delivery Address": `${contractorValues.address} ${contractorValues.suburb} ${contractorValues.state} ${contractorValues.postcode}`,
                        "Additional Notes": `${purchaseOrderValues['Additional Notes'] && purchaseOrderValues['Additional Notes'].replace(/<[^>]*>/g, '') ? purchaseOrderValues['Additional Notes'].replace(/<[^>]*>/g, '') : ' '}`,
                        "Accounts Payable Payment Terms": `${business.bankDetails.accountsPayableTerms ? business.bankDetails.accountsPayableTerms : ' '}`
                    }),
                    orders: `[[
                        "${purchaseOrderValues['Job Title']}${purchaseOrderValues['Job Description'] ? ` - ${purchaseOrderValues['Job Description'].replace(/<[^>]*>/g, '')}` : ''}",
                        "${formatValue(purchaseOrderValues.Quantity || 1)}",
                        "${formatValue(purchaseOrderValues['Unit Price($) - GST Excl.'] || 1)}",
                        "${gst == "10%" ? "10%" : "GST Free"}", 
                        "${formatValue((purchaseOrderValues.Quantity || 1) * (purchaseOrderValues['Unit Price($) - GST Excl.'] || 1))}"
                    ]]`
                };

                const pdfBytes = await generate({
                    template: template,
                    inputs: [inputs],
                    plugins: { text, image, line, table, multiVariableText }
                });

                const filename = `output/${workspaceId}/${boardId}/purchaseorder/${purchaseOrderNumber + '-ISO+™-' + item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, true);

                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename, 3600, true);
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'Purchase Order', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${purchaseOrderNumber} (ISO+™)`);
                    business.documentNumbering.purchaseOrder.nextNumber += 1;
                    await business.save();
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF Purchase Order', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/quote', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [contactValues, jobTypeValues] = await getQuoteReferencedItems(workspaceId, boardId, item.id);
                if (!contactValues) {
                    throw new Error("Client information is required.");
                }
                if (!jobTypeValues) {
                    throw new Error("Job Type is required.");
                }

                const templatePath = path.join(__dirname, '..', 'assets', 'quote.json');
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                enableRepeatHeadOnTables(template);

                const logoBase64 = await getLogoData(business);

                const quoteNumber = business.documentNumbering.quote.prefix + business.documentNumbering.quote.nextNumber;

                const clientDetails = {
                    Address: contactValues.address,
                    Suburb: contactValues.suburb,
                    State: contactValues.state,
                    Postcode: contactValues.postcode,
                    Client: contactValues.client
                };

                const quoteValues = item.values;
                let gst = quoteValues["GST"] == "10%" ? "10%" : "0%";
                const issueDate = quoteValues['Issue Date'] ? quoteValues['Issue Date'].replace('Z', '') : "";
                const expiryDate = quoteValues['Expiry Date'] ? quoteValues['Expiry Date'].replace('Z', '') : "";
                let subTotal = formatValue((quoteValues.Quantity || 1) * (quoteValues['Unit Price($) - GST Excl.'] || 1));
                let gstTotal = formatValue((subTotal * parseFloat(gst) / 100));
                let total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

                const pdfBytes = await generate({
                    template: template,
                    inputs: [
                        {
                            logo: logoBase64,
                            subtotal: subTotal,
                            totalGST: gstTotal,
                            total: total,
                            clientDetails: JSON.stringify(clientDetails),
                            quoteDetails: JSON.stringify({
                                "Issue Date": formatDateNumericAU(issueDate || null, business?.headOfficeTimezone),
                                "expiry Date": formatDateNumericAU(expiryDate || null, business?.headOfficeTimezone),
                                "Quote Number": quoteNumber
                            }),
                            companyName: JSON.stringify({ "Company Name": business.name }),
                            companyDetails: JSON.stringify({
                                ABN: business.abn,
                                "Street Address": business.address.street,
                                Suburb: business.address.suburb,
                                State: business.address.state,
                                Postcode: business.address.postcode,
                                Country: business.address.country
                            }),
                            orders: `[["${quoteValues['Job Title']} - ${quoteValues['Job Description'] ? quoteValues['Job Description'].replace(/<[^>]*>/g, '') : ''}","${formatValue(quoteValues.Quantity || 1)}","${formatValue(quoteValues['Unit Price($) - GST Excl.'] || 1)}", "${gst == "10%" ? "10%" : "GST Free"}", "${formatValue((quoteValues.Quantity || 1) * (quoteValues['Unit Price($) - GST Excl.'] || 1))}"]]`,
                            termsInputs: JSON.stringify({
                                "Accounts Receivable Payment Terms": `${business.bankDetails.accountsReceivableTerms ? business.bankDetails.accountsReceivableTerms : ' '}`
                            })
                        }
                    ],
                    plugins: { text, image, line, table, multiVariableText }
                });

                const filename = `output/${workspaceId}/${boardId}/quote/${quoteNumber + '-ISO+™-' + item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, true);

                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename, 3600, true);
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'Quote', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${quoteNumber} (ISO+™)`);
                    business.documentNumbering.quote.nextNumber += 1;
                    await business.save();
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF Quote', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/quotendis', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);
        await Promise.all(req.body.items.map(async (item) => processWebhookNdisQuotePdfItem({
            req,
            res,
            workspaceId,
            boardId,
            business,
            item,
            getLogoData,
            enableRepeatHeadOnTables,
            formatValue,
            formatDateNumericAU,
            isEmpty,
            uploadFileToS3,
            getS3FileUrl,
            handlePDFSuccess,
            handlePDFError,
        })));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/invoicendis', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);
        await Promise.all(req.body.items.map(async (item) => processWebhookNdisInvoicePdfItem({
            req,
            res,
            workspaceId,
            boardId,
            business,
            item,
            getLogoData,
            enableRepeatHeadOnTables,
            formatValue,
            formatDateNumericAU,
            uploadFileToS3,
            getS3FileUrl,
            handlePDFSuccess,
            handlePDFError,
            saveInvoiceNumber,
        })));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        return res.status(200).json({ message: err.message });
    }
});

function parseMasterItemIdsFromBody(body) {
    const raw = Array.isArray(body?.itemIds)
        ? body.itemIds
        : (Array.isArray(body?.items) ? body.items : []);

    return [...new Set(raw.map((r) => {
        if (!r) return null;
        if (typeof r === 'string') return r;
        if (typeof r === 'object') {
            if (r.sourceItemId) return String(r.sourceItemId);
            if (r.id && String(r.id).includes(':')) return String(r.id).split(':')[0];
            if (r.id) return String(r.id);
        }
        return null;
    }).filter((r) => Boolean(r)).map((r) => String(r)))];
}

router.post('/:workspaceId/:boardId/invoicendis-invoice-generator', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        const masterItemIds = parseMasterItemIdsFromBody(req.body);

        const { masterItems, refItemsMap, participantProfileItem } =
            await getNdisInvoiceGeneratorContextFromMasterItems({
                workspaceId,
                boardId,
                masterItemIds,
            });

        const fallbackParticipantName =
            String(req.body?.participantName || '').trim() ||
            masterItems
                .map((m) => formatLabelValue(m?.data?.['Participant Full Name']).trim())
                .find(Boolean) ||
            '';

        const { participantProfile, participantProfileItem: profileItem, participantName } =
            await prepareParticipantForInvoiceGenerator({
                workspaceId,
                boardId,
                participantProfileItem,
                fallbackParticipantName,
            });

        const clientDetails = buildNdisInvoicePdfClientDetails({
            participantProfile,
            participantProfileItem: profileItem,
            fallbackParticipantName: participantName,
        });

        const invoiceDateRaw = req.body?.invoiceDate || new Date().toISOString();
        const dueDateRaw = req.body?.dueDate || '';
        const invoiceDate = invoiceDateRaw ? String(invoiceDateRaw).replace('Z', '') : '';
        let dueDate = dueDateRaw ? String(dueDateRaw).replace('Z', '') : '';
        if (!dueDate) {
            const d = new Date(invoiceDateRaw);
            d.setDate(d.getDate() + 14);
            dueDate = d.toISOString();
        }

        const templatePath = path.join(__dirname, '..', 'assets', 'NDISinvoice.json');
        const templateData = await fs.readFile(templatePath, 'utf8');
        const template = JSON.parse(templateData);
        enableRepeatHeadOnTables(template);

        const logoBase64 = await getLogoData(business);

        const invoiceNumberBase =
            business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;
        const invoiceNumber = `${invoiceNumberBase} (ISO+™)`;

        const allRows = [];
        for (const masterPlanItem of masterItems) {
            const spId = extractNdisRefId(masterPlanItem?.data?.[NDIS_MASTERPLAN_ATTR_DB.SERVICE_PLAN]);
            const servicePlanItem = spId ? refItemsMap.get(spId) : null;
            if (!servicePlanItem) {
                throw new Error(
                    'Master plan information is required. Master plan is missing a service plan reference.'
                );
            }

            const ctId = extractNdisRefId(masterPlanItem?.data?.['Cancellation Type']);
            const cancellationTypeItem = ctId ? refItemsMap.get(ctId) : null;

            const pricingRule = await resolveNdisPricingRuleForServicePlan(workspaceId, servicePlanItem, boardId);
            const supportCatalogue = buildNdisSupportCatalogueForServicePlan(servicePlanItem, refItemsMap, pricingRule);

            allRows.push(...buildNdisMasterPlanServiceRows({
                masterPlanItem,
                participantName,
                participantProfileItem: profileItem,
                servicePlanItem,
                supportCatalogue,
                cancellationTypeItem,
                invoiceNumber,
                invoicePdfLink: null,
                timeZone: business?.headOfficeTimezone || 'Australia/Sydney',
                pricingRule,
            }));
        }

        if (allRows.length === 0) {
            return res.status(200).json({ message: 'There is nothing to invoice!' });
        }

        const invoiceGenTz = business?.headOfficeTimezone || 'Australia/Sydney';
        const enrichedRows = enrichNdisInvoiceGeneratorRows(
            allRows,
            buildMasterItemsMap(masterItems),
            invoiceGenTz
        );

        const fmt2 = (val) => {
            const n = Number(val);
            if (!Number.isFinite(n)) return '0.00';
            return (Math.round(n * 100) / 100).toFixed(2);
        };

        let subTotalNum = 0;
        const gstLabel = 'GST Free';
        const ordersArr = enrichedRows.map((r) => {
            const jobStatus = (r.jobStatus || '').toString().trim().toLowerCase();
            const dateIso = jobStatus === 'cancelled'
                ? (r.scheduledServiceDate || r.serviceDeliveryDate || '')
                : (r.serviceDeliveryDate || r.scheduledServiceDate || '');
            const rowDate = formatDdMmYyyy(dateIso, invoiceGenTz) || ' ';

            subTotalNum += Number(r.totalAmount || 0);
            return [
                rowDate,
                (r.service || ' ').toString(),
                (r.unit || ' ').toString(),
                fmt2(r.quantity),
                fmt2(r.unitPrice),
                gstLabel,
                fmt2(r.totalAmount),
            ];
        });

        const subTotal = fmt2(subTotalNum);
        const gst = '0%';
        const gstTotal = fmt2((Number(subTotal) * parseFloat(gst)) / 100);
        const total = fmt2(Number(subTotal) + Number(gstTotal));

        const pdfBytes = await generate({
            template,
            inputs: [
                {
                    logo: logoBase64,
                    subtotal: subTotal,
                    totalGST: gstTotal,
                    total: total,
                    clientDetails: JSON.stringify(clientDetails),
                    invoiceDetails: JSON.stringify({
                        Date: formatDateNumericAU(invoiceDate || null, business?.headOfficeTimezone),
                        'Invoice Number': invoiceNumberBase,
                    }),
                    companyName: JSON.stringify({ 'Company Name': business.name }),
                    companyDetails: JSON.stringify({
                        ABN: business.abn,
                        'Street Address': business.address.street,
                        Suburb: business.address.suburb,
                        State: business.address.state,
                        Postcode: business.address.postcode,
                        Country: business.address.country,
                    }),
                    orders: JSON.stringify(ordersArr),
                    dueDate: formatDateNumericAU(dueDate || null, business?.headOfficeTimezone),
                    'Bank Details': JSON.stringify({
                        'Account Name': business.bankDetails.accountName,
                        'Bank Name': business.bankDetails.bankName,
                        BSB: business.bankDetails.bsb,
                        'Account Number': business.bankDetails.accountNumber,
                        'invoice Number': invoiceNumberBase,
                    }),
                },
            ],
            plugins: { text, image, line, table, multiVariableText },
        });

        const safeSuffix = (participantName || participantProfile.displayName || 'Multiple').replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 40);
        const filename = `output/${workspaceId}/${boardId}/NDIS-invoices/${invoiceNumberBase + '-ISO+™-' + safeSuffix}.pdf`;
        const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, true);
        if (uploadResult?.$metadata?.httpStatusCode !== 200) {
            throw new Error('Upload of PDF failed, please provide correct information.');
        }
        const fileUrl = await getS3FileUrl(filename, 3600, true);

        await Promise.all(masterItems.map(async (it) => {
            await saveInvoiceNumber(workspaceId, boardId, it.itemId, invoiceNumber, 'PDF', fileUrl);
        }));

        business.documentNumbering.invoice.nextNumber += 1;
        await business.save();

        return res.json({
            invoiceNumber,
            fileUrl,
            itemCount: masterItems.length,
            lineCount: ordersArr.length,
        });
    } catch (err) {
        error('Webhook-Service', 'Server error (NDIS invoice generator PDF)', { message: err.message, stack: err.stack }, req ?? null);
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/invoiceparticipanttax', async (req, res) => {
    try {
        return await handleParticipantTaxInvoiceRoute(req, res, {
            validateRequestParams,
            getValidatedBusiness,
            getLogoData,
            enableRepeatHeadOnTables,
            bulkFetchReferenceItemsFromDB,
            getValueFromFlatData,
            attributeNames: ATTRIBUTE_NAMES,
            refAttributeNames: REF_ATTRIBUTE_NAMES,
            getParticipantNameFromProfile,
            getServiceFromServicePlan,
            formatLabelValue,
            formatValue,
            formatCurrencyValue,
            uploadFileToS3,
            getS3FileUrl,
            saveInvoiceNumber,
            info,
            error,
        });
    } catch (err) {
        error('Webhook-Service', 'Server error', { err }, req);
        return res.status(500).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/monthly-statement', async (req, res) => {
    try {
        return await handleMonthlyStatementRoute(req, res, buildMonthlyStatementDeps({
            getValidatedBusiness,
            enableRepeatHeadOnTables,
            ensureMonthlyStatementHeaderFromPage2,
            getLogoData,
            resolveTemplateImageUrls,
            getTemplateImageContentByName,
            applyTemplateTextDefaults,
            calculateBudgetAggregates,
            enrichAggregateFromCategory,
            initializeBudgetAggregate,
            getQuarterMetadata,
            setMultiValueField,
            setCurrencyField,
            applyBudgetMapping,
            safeString,
            formatDateToAU,
            createServiceBuckets,
            determineFundingCode,
            normalizeStatus,
            buildServiceTableRows,
            normalizeTableCell,
            parseNumberValue,
            uploadFileToS3,
            getS3FileUrl,
            info,
            warn,
            error,
            fetchBudgetItems,
            fetchServiceItems,
            generate,
            text,
            image,
            line,
            table,
            multiVariableText,
            path,
            fs,
            fileURLToPath,
            SERVICE_TABLE_CONFIG,
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        return res.status(500).json({ message: err.message });
    }
});

router.get('/uploads/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const key = `pdfs/${filename}`;

        const fileUrl = await getS3FileUrl(key, 604800, true);

        if (fileUrl) {
            res.redirect(fileUrl);
        } else {
            throw new Error('Invalid file URL');
        }
    } catch (err) {
        error('Webhook-Service', 'Error downloading file', { message: err.message, stack: err.stack }, req ?? null);
        res.status(404).json({ message: 'File not found in ISO+™ Portal.' });
    }
});

export default router;
