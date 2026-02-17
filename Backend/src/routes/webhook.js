import express from 'express';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
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
import { getS3FileUrl, uploadFileToS3 } from '../utils/uploadS3.js';
import { isEmpty } from '../utils/helpers.js';
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
    const business = await Business.findOne({ workspaceId: workspaceId.toString() });
    if (!business) {
        throw new Error('Business not found');
    }
    return business;
}

async function handlePDFError(err, workspaceId, boardId, itemId, action, req, res) {
    const errorMessage = (err && err.message) ? err.message : 'Server error: An unknown error occurred. Please contact support via ISO+™ Portal.';
    await setIntegrationMessage(workspaceId, boardId, itemId, errorMessage);
    error('Webhook-Service', 'Server error', { message: errorMessage }, extractContextFromReq(req));
    logAuditTrail({
        workspaceId,
        action,
        detail: `Resource ID: ${itemId}, Error: ${errorMessage}`,
        req
    });
    return res.status(200).json({ message: errorMessage });
}

async function getLogoData(business) {
    const logoKey = business.defaultLogo;
    if (!logoKey) return '';

    const logoUrl = await getS3FileUrl(logoKey, 3600, false);
    if (!logoUrl) throw new Error('Failed to retrieve logo from S3');

    const response = await fetch(logoUrl);
    if (!response.ok) throw new Error('Failed to fetch logo from URL');

    const buffer = await response.arrayBuffer();
    console.log(business.defaultLogo)
    const type = business.defaultLogo.split('.').pop();
    return `data:image/${type};base64,${Buffer.from(buffer).toString('base64')}`;
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

async function resolveTemplateImageUrls(template, templateInputs) {
    const pages = template.schemas;
    if (!Array.isArray(pages)) return;
    for (const pageSchemas of pages) {
        if (!Array.isArray(pageSchemas)) continue;
        for (const schema of pageSchemas) {
            if (schema.type !== 'image' || !schema.name) continue;
            const content = schema.content;
            if (typeof content === 'string' && (content.startsWith('http://') || content.startsWith('https://'))) {
                const base64 = await fetchImageUrlAsBase64(content);
                if (base64) templateInputs[schema.name] = base64;
            }
        }
    }
}

function applyTemplateTextDefaults(template, templateInputs) {
    const pages = template?.schemas;
    if (!Array.isArray(pages)) return;
    for (const pageSchemas of pages) {
        if (!Array.isArray(pageSchemas)) continue;
        for (const schema of pageSchemas) {
            if (!schema?.name) continue;
            if (templateInputs[schema.name] !== undefined) continue;
            if (schema.type === 'text') {
                templateInputs[schema.name] = typeof schema.content === 'string' ? schema.content : '';
            }
            if (schema.type === 'multiVariableText') {
                templateInputs[schema.name] = typeof schema.content === 'string' ? schema.content : '{}';
            }
        }
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
    const uniqueIds = [...new Set(itemIds.filter(Boolean).map(id => {
        if (typeof id === 'object' && id.id) return id.id.toString();
        if (typeof id === 'object' && id) return id.toString();
        return id?.toString();
    }).filter(Boolean))];

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

    console.log(`[Webhook] Bulk fetch: requested=${uniqueIds.length}, found=${itemMap.size}`);
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
        }).filter(Boolean).join(', ');
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

    // Enrich same-named numeric fields
    for (const [aggKey, catKey] of Object.entries(numericFields)) {
        if (Math.abs(aggregate[aggKey] || 0) < 0.001) {
            const catVal = parseNumberValue(category[catKey]);
            if (Math.abs(catVal) >= 0.001) {
                aggregate[aggKey] = catVal;
            }
        }
    }

    // Enrich mapped fields (different names between category and aggregate)
    for (const { aggField, catFields } of mappedFields) {
        if (Math.abs(aggregate[aggField] || 0) < 0.001) {
            for (const catField of catFields) {
                const catVal = parseNumberValue(category[catField]);
                if (Math.abs(catVal) >= 0.001) {
                    aggregate[aggField] = catVal;
                    break;
                }
            }
        }
    }

    // Enrich label/date fields
    if (!aggregate.primarySupplementLabel) {
        aggregate.primarySupplementLabel = safeString(category.primarySupplementLabel) || '';
    }
    if (!aggregate.fund) {
        aggregate.fund = safeString(category.fund) || '';
    }
    if (!aggregate.fundClassification) {
        aggregate.fundClassification = safeString(category.fundClassification) || '';
    }
    if (!aggregate.fundingStartDate && category.fundingStartDate) {
        aggregate.fundingStartDate = category.fundingStartDate;
    }
    if (!aggregate.fundingEndDate && category.fundingEndDate) {
        aggregate.fundingEndDate = category.fundingEndDate;
    }
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
    const source = (service.fundingSource || '').toString().toLowerCase();
    if (source.includes('home support')) return 'HSQ';
    if (source.includes('restorative')) return 'RCP';
    if (source.includes('end-of-life') || source.includes('end of life')) return 'EOL';
    if (source.includes('assistive') && source.includes('short')) return 'ATS';
    if (source.includes('assistive') && source.includes('ongoing')) return 'ATO';
    if (source.includes('modification')) return 'HMB';

    const category = (service.serviceCategory || '').toString().toLowerCase();
    if (category.includes('restorative')) return 'RCP';
    if (category.includes('end-of-life') || category.includes('end of life')) return 'EOL';
    if (category.includes('short')) return 'ATS';
    if (category.includes('ongoing')) return 'ATO';
    if (category.includes('modification')) return 'HMB';

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
    return value.toString().replace(/<[^>]*>/g, '').trim();
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
        return value.map((entry) => normalizeTableCell(entry)).filter(Boolean).join(', ');
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
            tableName: 'Table P10-2 copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P10-4 copy', '$P10-5 copy', '$P10-6 copy'],
            rowType: 'committed'
        },
        committed: {
            tableName: 'Table P10-3 copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P10-7 copy', '$P10-8 copy', '$P10-9 copy'],
            rowType: 'adjustment'
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
            tableName: 'Table P11-2 copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P11-4 copy', '$P11-5 copy', '$P11-6 copy'],
            rowType: 'committed'
        },
        committed: {
            tableName: 'Table P11-3  copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P11-7  copy', '$P11-8 copy', '$P11-9 1 copy'],
            rowType: 'adjustment'
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
            tableName: 'Table P11-2 copy copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-4  copy', '$P11-5 copy copy', '$P11-6  copy'],
            rowType: 'committed'
        },
        committed: {
            tableName: 'Table P12-3  copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-7  copy', '$P11-8 copy copy', '$P11-9 1 copy copy'],
            rowType: 'adjustment'
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
            const name = service.service || service.taskName || cleanRichText(service.notes) || 'Service';
            const providerName = isDeliveredByAssociatedProviders(service) ? resolveServiceProviderName(service, business) : '';
            const enrichedName = providerName ? `${name}, by ${providerName}` : name;
            return truncateText(enrichedName, 60);
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

function applyBudgetMapping(templateInputs, aggregate, mappings = []) {
    mappings.forEach((entry) => {
        const value = typeof entry.value === 'function' ? entry.value(aggregate) : entry.value;
        const fields = Array.isArray(entry.field) ? entry.field : [entry.field];
        if (entry.type === 'currency') {
            fields.forEach((f) => setCurrencyField(templateInputs, f, value));
        } else if (entry.type === 'multi') {
            fields.forEach((f) => setMultiValueField(templateInputs, f, value));
        }
    });
}

function validateRequestParams(req) {
    const { workspaceId, boardId } = req.params;
    if (!req.body.items?.length) {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, extractContextFromReq(req));
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
    info('Webhook-Service', `Successfully generating PDF ${docType.toLowerCase()}`, { link: fileUrl }, extractContextFromReq(req));
    return res.json({ pdfUrl: fileUrl });
}

router.post('/:workspaceId/:boardId/invoice', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [jobPlanningValues, serviceFeeTypeValues] = await getJobReportingReferencedItems(workspaceId, boardId, item.id);
                if (!jobPlanningValues) {
                    throw new Error("Job planning information is required. Job reporting is missing a job planning reference.");
                }
                if (!serviceFeeTypeValues) {
                    throw new Error("Service fee type information is required. Job reporting is missing a service fee type reference.");
                }

                const [contactValues] = await getJobPlanningReferencedItems(workspaceId, boardId, jobPlanningValues.id);
                if (!contactValues) {
                    throw new Error("Client information is required. Job planning is missing a client reference.");
                }

                const templatePath = path.join(__dirname, '..', 'assets', 'invoice.json');
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                enableRepeatHeadOnTables(template);

                const logoBase64 = await getLogoData(business);

                const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;

                const invoiceValues = item.values;
                const invoiceDate = invoiceValues["Issue Date"] ? invoiceValues["Issue Date"].replace('Z', '') : "";
                const dueDate = invoiceValues["Due Date"] ? invoiceValues["Due Date"].replace('Z', '') : "";
                let subTotal = 0;
                let gst = invoiceValues["GST"] == "10%" ? "10%" : "0%";
                let invoiceDescription = `[["${jobPlanningValues.jobTitle}-${serviceFeeTypeValues.feeType}-${formatValue(invoiceValues["Job Duration (Hrs.)"])}Hrs.", "1", "${formatValue(invoiceValues["Payable Service Fee($) - GST Excl."])}", "${gst == "10%" ? "10%" : "GST Free"}", "${formatValue(invoiceValues["Payable Service Fee($) - GST Excl."])}"]`;
                subTotal += parseFloat(invoiceValues["Payable Service Fee($) - GST Excl."]);

                if (invoiceValues["Payable Material Fee($) - GST Excl."] > 0) {
                    invoiceDescription += `,["Used Material/Part", "1", "${formatValue(invoiceValues["Payable Material Fee($) - GST Excl."])}", "${gst == "10%" ? "10%" : "GST Free"}", "${formatValue(invoiceValues["Payable Material Fee($) - GST Excl."])}"]`;
                    subTotal += parseFloat(invoiceValues["Payable Material Fee($) - GST Excl."]);
                }

                if (invoiceValues["Other Payable Fee($) - GST Excl."] > 0) {
                    invoiceDescription += `,["Other Payable Fee", "1", "${formatValue(invoiceValues["Other Payable Fee($) - GST Excl."])}", "${gst == "10%" ? "10%" : "GST Free"}", "${formatValue(invoiceValues["Other Payable Fee($) - GST Excl."])}"]`;
                    subTotal += parseFloat(invoiceValues["Other Payable Fee($) - GST Excl."]);
                }

                invoiceDescription += "]";

                subTotal = formatValue(subTotal);
                const gstTotal = formatValue((subTotal * parseFloat(gst) / 100));
                const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

                const clientDetails = {
                    Address: contactValues.address,
                    Suburb: contactValues.suburb,
                    State: contactValues.state,
                    Postcode: contactValues.postcode,
                    Client: contactValues.client
                };

                const pdfBytes = await generate({
                    template: template,
                    inputs: [
                        {
                            logo: logoBase64,
                            subtotal: subTotal,
                            totalGST: gstTotal,
                            total: total,
                            clientDetails: JSON.stringify(clientDetails),
                            invoiceDetails: JSON.stringify({
                                Date: invoiceDate && invoiceDate != "" ? new Date(invoiceDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                                "Invoice Number": invoiceNumber
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
                            orders: invoiceDescription,
                            "dueDate": dueDate && dueDate != "" ? new Date(dueDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                            "Bank Details": JSON.stringify({
                                "Account Name": business.bankDetails.accountName,
                                "Bank Name": business.bankDetails.bankName,
                                BSB: business.bankDetails.bsb,
                                "Account Number": business.bankDetails.accountNumber,
                                "invoice Number": invoiceNumber
                            })
                        }
                    ],
                    plugins: { text, image, line, table, multiVariableText }
                });

                const filename = `output/${workspaceId}/${boardId}/invoices/${invoiceNumber + '-ISO+™-' + item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);

                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename);
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'Invoice', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`);
                    await saveInvoiceNumber(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`, 'PDF', fileUrl);
                    business.documentNumbering.invoice.nextNumber += 1;
                    await business.save();
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF Invoice', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, extractContextFromReq(req));
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
                        "Issue Date": issueDate && issueDate != "" ? new Date(issueDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                        "expiry Date": deliveryDate && deliveryDate != "" ? new Date(deliveryDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
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
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);

                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename);
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
        error('Webhook-Service', 'Server error', { message: err.message }, extractContextFromReq(req));
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
                                "Issue Date": issueDate && issueDate != "" ? new Date(issueDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                                "expiry Date": expiryDate && expiryDate != "" ? new Date(expiryDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
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
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);

                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename);
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
        error('Webhook-Service', 'Server error', { message: err.message }, extractContextFromReq(req));
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/quotendis', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);
        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues, providerTravelLabourTravelTime] = await getQuoteNDISReferencedItems(workspaceId, boardId, item.id);
                if (!serviceAreaValues) throw new Error("Service Area value is required.");

                const templatePath = path.join(__dirname, '..', 'assets', `NDISquote.json`);
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                enableRepeatHeadOnTables(template);

                const logoBase64 = await getLogoData(business);

                const quoteNumber = business.documentNumbering.quote.prefix + business.documentNumbering.quote.nextNumber;

                const NDISQuoteValues = item.values;

                let gst = "0%";
                const gstLabel = "GST Free";
                const issueDate = NDISQuoteValues['Issue Date'] ? NDISQuoteValues['Issue Date'].replace('Z', '') : "";
                const expiryDate = NDISQuoteValues['Expiry Date'] ? NDISQuoteValues['Expiry Date'].replace('Z', '') : "";
                const fromDate = NDISQuoteValues['From Date'] ? NDISQuoteValues['From Date'].replace('Z', '') : "";
                const toDate = NDISQuoteValues['To Date'] ? NDISQuoteValues['To Date'].replace('Z', '') : "";
                const daysOfWeek = Array.isArray(NDISQuoteValues["Days of the Week"]) && NDISQuoteValues["Days of the Week"].length > 0 ? NDISQuoteValues["Days of the Week"].join(', ') : " ";
                let ordersArr = [];
                let subTotal = 0;

                const clientDetails = {
                    Address: NDISQuoteValues['Recipient Address'] || ' ',
                    Suburb: NDISQuoteValues['Suburb'] || ' ',
                    State: NDISQuoteValues['State'] || ' ',
                    Postcode: NDISQuoteValues['Postcode'] || ' ',
                    Client: NDISQuoteValues['Recipient of the Quote'] || ' '
                };

                // 1. Direct Support
                if (NDISQuoteValues['Quantity (Direct Support)'] && NDISQuoteValues['Unit Price for Direct Support($)']) {
                    const desc = `${NDISQuoteValues['Direct Support Item Number'] || ''}${directSupportValues && directSupportValues.itemName ? '-' + directSupportValues.itemName : ''}`;
                    const qty = Number(NDISQuoteValues['Quantity (Direct Support)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Direct Support($)']) || 0;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Direct Support',
                        NDISQuoteValues['Unit (Direct Support)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 2. Provider Travel - Non-Labour Cost
                if (NDISQuoteValues['Quantity (Provider Travel)'] && NDISQuoteValues['Unit Price for Provider Travel($)']) {
                    const desc = `${NDISQuoteValues['Provider Travel - Non-Labour Cost Item Number'] || ''}${providerTravelValues && providerTravelValues.itemName ? '-' + providerTravelValues.itemName : ''}`;
                    const qty = Number(NDISQuoteValues['Quantity (Provider Travel)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Provider Travel($)']) || 0;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Provider Travel - Non-Labour Cost',
                        NDISQuoteValues['Unit (Provider Travel - Non-Labour Cost)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 3. Activity Based Transport
                if (NDISQuoteValues['Quantity (Activity Based Transport)'] && NDISQuoteValues['Unit Price for Activity Based Transport($)']) {
                    const desc = `${NDISQuoteValues['Activity Based Transport Item Number'] || ''}${activityBasedTransportValues && activityBasedTransportValues.itemName ? '-' + activityBasedTransportValues.itemName : ''}`;
                    const qty = Number(NDISQuoteValues['Quantity (Activity Based Transport)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Activity Based Transport($)']) || 0;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Activity Based Transport',
                        NDISQuoteValues['Unit (Activity Based Transport)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 4. Centre Capital Costs
                if (NDISQuoteValues['Quantity (Centre Capital Costs)'] && NDISQuoteValues['Unit Price for Centre Capital Costs($)']) {
                    const desc = `${NDISQuoteValues['Centre Capital Costs Item'] || ''}${centreCapitalCostsValues && centreCapitalCostsValues.itemName ? '-' + centreCapitalCostsValues.itemName : ''}`;
                    const qty = Number(NDISQuoteValues['Quantity (Centre Capital Costs)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Centre Capital Costs($)']) || 0;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Centre Capital Costs',
                        NDISQuoteValues['Unit (Centre Capital Costs)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 5. Provider Travel - Labour Travel Time Costs
                if (NDISQuoteValues['Quantity (Labour Travel Time)']) {
                    const desc = 'Provider Travel - Labour Travel Time Costs' + (providerTravelLabourTravelTime && providerTravelLabourTravelTime.itemName ? '-' + providerTravelLabourTravelTime.itemName : '');
                    const qty = Number(NDISQuoteValues['Quantity (Labour Travel Time)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Labour Travel Time ($)']) || 1;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Provider Travel - Labour Travel Time Costs',
                        NDISQuoteValues['Unit (Labour Travel Time)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 6. Allowances
                if (NDISQuoteValues['Allowances'] && NDISQuoteValues['Allowances Amount($)']) {
                    const desc = isEmpty(NDISQuoteValues['Allowances']) ? 'Allowances' : `Allowances - ${NDISQuoteValues['Allowances']}`;
                    const qty = 1;
                    const unitPrice = Number(NDISQuoteValues['Allowances Amount($)']) || 0;
                    const amount = unitPrice;
                    ordersArr.push([
                        desc,
                        NDISQuoteValues['Unit (Allowances)'] || ' ',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 7. Non-Face-to-Face Support
                if (NDISQuoteValues['Non-Face-to-Face Supports'] && NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) {
                    const desc = isEmpty(NDISQuoteValues['Non-Face-to-Face Supports']) ? 'Non-Face-to-Face Support' : `Non-Face-to-Face Support - ${NDISQuoteValues['Non-Face-to-Face Supports']}`;
                    const qty = Number(NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Non-Face-to-Face Support ($)']) || 1;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc,
                        NDISQuoteValues['Unit (Non-Face-to-Face Support)'] || ' ',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }

                const orders = JSON.stringify(ordersArr);
                subTotal = formatValue(subTotal);
                const gstTotal = formatValue((parseFloat(subTotal) * parseFloat(gst) / 100));
                const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

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
                                "Issue Date": issueDate && issueDate != "" ? new Date(issueDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                                "expiry Date": expiryDate && expiryDate != "" ? new Date(expiryDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
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
                            orders: orders,
                            termsInputs: JSON.stringify({
                                "Accounts Receivable Payment Terms": `${business.bankDetails.accountsReceivableTerms ? business.bankDetails.accountsReceivableTerms : ' '}`
                            }),
                            field17: JSON.stringify({
                                "From Date": fromDate && fromDate != "" ? new Date(fromDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                                "To Date": toDate && toDate != "" ? new Date(toDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                                "Days of the week": daysOfWeek
                            })
                        }
                    ],
                    plugins: { text, image, line, table, multiVariableText }
                });

                const filename = `output/${workspaceId}/${boardId}/NDIS-quote/${quoteNumber + '-ISO+™-' + item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename);
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'NDIS Quote', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${quoteNumber} (ISO+™)`);
                    business.documentNumbering.quote.nextNumber += 1;
                    await business.save();
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF NDIS Quote', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, extractContextFromReq(req));
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/invoicendis', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [servicePlanValues, cancellationTypeValues, fundValues, participantProfileValues] = await getNDISMasterPlanReferencedItems(workspaceId, boardId, item.id);
                if (!participantProfileValues || !servicePlanValues) {
                    throw new Error("Participant Profile and Service Plan information is required.");
                }

                const templatePath = path.join(__dirname, '..', 'assets', 'NDISinvoice.json');
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                enableRepeatHeadOnTables(template);

                const logoBase64 = await getLogoData(business);

                const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;

                const invoiceValues = item.values;
                const invoiceDate = invoiceValues["Invoice Date"] ? invoiceValues["Invoice Date"].replace('Z', '') : "";
                const dueDate = invoiceValues["Due Date"] ? invoiceValues["Due Date"].replace('Z', '') : "";

                let ordersArr = [];
                let subTotal = 0;
                const groupSize = Number(invoiceValues['Group Size']) || 1;
                const gst = "0%";
                const gstLabel = "GST Free";

                if (invoiceValues['Job Status'] !== 'Cancelled') {
                    // Line 1: Direct Support - Hour based
                    if (servicePlanValues?.directSupportUnit === "Hour(H)") {
                        const unitPrice1 = Number(servicePlanValues?.directSupportUnitPrice) / groupSize || 0;
                        const itemNumber1 = servicePlanValues?.directSupportItemNumber || '';
                        const itemName1 = servicePlanValues?.directSupportItemName || '';
                        const startTime1 = invoiceValues["Actual Shift Start Date and Time"] ? new Date(invoiceValues["Actual Shift Start Date and Time"]).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                        const endTime1 = invoiceValues["Actual Shift End Date and Time"] ? new Date(invoiceValues["Actual Shift End Date and Time"]).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                        let qty1 = 0;
                        let actualShiftDuration1 = Number(invoiceValues["Actual Shift Duration(Hr.)"]);
                        if (typeof actualShiftDuration1 === 'number' && !isNaN(actualShiftDuration1)) {
                            qty1 = Number(actualShiftDuration1.toFixed(1));
                        }
                        const amountValue1 = formatValue(Number(invoiceValues["Direct Support Value($) - Time Based Support"])) || 0;
                        const amount1 = formatValue(qty1 * unitPrice1);

                        if (amountValue1 > 0) {
                            let desc1 = itemName1;
                            if (itemNumber1) {
                                desc1 += ` - ${itemNumber1}`;
                            }
                            if (startTime1 && endTime1) {
                                desc1 += ` - from ${startTime1} to ${endTime1}`;
                            }
                            if (desc1 == '') {
                                desc1 = 'Direct Support - Hour based';
                            }
                            if (groupSize !== 1) {
                                desc1 += ` - Group Size: ${groupSize}`;
                            }

                            if (parseFloat(formatValue(amountValue1)) != parseFloat(formatValue(amount1))) {
                                setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                                throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            }

                            ordersArr.push([
                                desc1,
                                servicePlanValues?.directSupportUnit || ' ',
                                formatValue(qty1),
                                formatValue(unitPrice1),
                                gstLabel,
                                formatValue(amount1)
                            ]);
                            subTotal += Number(amount1);
                        }
                    }

                    // Line 2: Direct Support - Non Hour based
                    if (servicePlanValues?.directSupportUnit !== "Hour(H)") {
                        const unitPrice2 = Number(servicePlanValues?.directSupportUnitPrice) || 0;
                        const itemNumber2 = servicePlanValues?.directSupportItemNumber || '';
                        const itemName2 = servicePlanValues?.directSupportItemName || '';
                        const quantity2 = invoiceValues["Quantity (Direct Support - Non Time Based Support)"] || 0;
                        const unit2 = servicePlanValues?.directSupportUnit || '';
                        const qty2 = Number(quantity2) || 0;
                        const amountValue2 = formatValue(Number(invoiceValues["Direct Support Value($) - Non Time Based Support"])) || 0;
                        const amount2 = formatValue(qty2 * unitPrice2);

                        if (amountValue2 > 0) {
                            let desc2 = itemName2;
                            if (itemNumber2) {
                                desc2 += ` - ${itemNumber2}`;
                            }
                            if (quantity2 && unit2) {
                                desc2 += ` - ${quantity2} ${unit2}`;
                            }
                            if (desc2 == '') {
                                desc2 = 'Direct Support - NOT Hour based';
                            }

                            if (parseFloat(formatValue(amountValue2)) != parseFloat(formatValue(amount2))) {
                                setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                                throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            }

                            ordersArr.push([
                                desc2,
                                unit2 || ' ',
                                formatValue(qty2),
                                formatValue(unitPrice2),
                                gstLabel,
                                formatValue(amount2)
                            ]);
                            subTotal += Number(amount2);
                        }
                    }

                    // Line 3: Provider Travel - Non-Labour Cost
                    const unitPrice3 = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
                    const mileage3 = invoiceValues["Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a Vehicle is Used."] || '';
                    const others3 = invoiceValues["Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied."] || '';
                    const itemName3 = servicePlanValues?.providerTravelItemName || '';
                    const itemNumber3 = servicePlanValues?.providerTravelItemNumber || '';
                    const qty3 = Number(invoiceValues["Provider Travel - Non-Labour Cost Amount($)"]) || 0;
                    const amountValue3 = formatValue(Number(invoiceValues["Provider Travel - Non-Labour Cost Amount($)"]) * unitPrice3) || 0;
                    const amount3 = formatValue(qty3 * unitPrice3);

                    if (amountValue3 > 0) {
                        let desc3 = itemName3;
                        if (itemNumber3) {
                            desc3 += ` - ${itemNumber3}`;
                        }
                        if (mileage3) {
                            desc3 += ` - ${mileage3}km`;
                        }
                        if (others3) {
                            desc3 += ` - Others: ${others3}`;
                        }
                        if (desc3 == '') {
                            desc3 = 'Provider Travel - Non-Labour Cost Item';
                        }

                        if (parseFloat(formatValue(amountValue3)) != parseFloat(formatValue(amount3))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc3,
                            servicePlanValues?.nonLabourTravelUnit || ' ',
                            formatValue(qty3),
                            formatValue(unitPrice3),
                            gstLabel,
                            formatValue(amount3)
                        ]);
                        subTotal += Number(amount3);
                    }

                    // Line 4: Activity Based Transport
                    const unitPrice4 = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
                    const mileage4 = invoiceValues["Activity Base Transport Mileage(Kms) as per the Service Plan, if a Vehicle is Used."] || '';
                    const others4 = invoiceValues["Activity Base Transport Costs as per the Service Plan, if other costs are applied."] || '';
                    const itemName4 = servicePlanValues?.activityBasedTransportItemName || '';
                    const itemNumber4 = servicePlanValues?.activityBasedTransportItemNumber || '';
                    const qty4 = Number(invoiceValues["Activity Base Transport Amount($)"]) || 0;
                    const amountValue4 = formatValue(Number(invoiceValues["Activity Base Transport Amount($)"]) * unitPrice4) || 0;
                    const amount4 = formatValue(qty4 * unitPrice4);

                    if (amountValue4 > 0) {
                        let desc4 = itemName4;
                        if (itemNumber4) {
                            desc4 += ` - ${itemNumber4}`;
                        }
                        if (mileage4) {
                            desc4 += ` - ${mileage4}km`;
                        }
                        if (others4) {
                            desc4 += ` - Others: ${others4}`;
                        }
                        if (desc4 == '') {
                            desc4 = 'Activity Based Transport Item';
                        }

                        if (parseFloat(formatValue(amountValue4)) != parseFloat(formatValue(amount4))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc4,
                            servicePlanValues?.activityBasedTransportUnit || ' ',
                            formatValue(qty4),
                            formatValue(unitPrice4),
                            gstLabel,
                            formatValue(amount4)
                        ]);
                        subTotal += Number(amount4);
                    }

                    // Line 5: Centre Capital Costs
                    const unitPrice5 = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
                    const itemName5 = servicePlanValues?.centreCapitalCostsItemName || '';
                    const itemNumber5 = servicePlanValues?.centreCapitalCostsItemNumber || '';
                    let qty5 = 0;
                    let actualShiftDuration5 = Number(invoiceValues["Actual Shift Duration(Hr.)"]);
                    if (typeof actualShiftDuration5 === 'number' && !isNaN(actualShiftDuration5)) {
                        qty5 = Number(actualShiftDuration5.toFixed(1));
                    }
                    const amountValue5 = formatValue(Number(invoiceValues["Centre Capital Costs Amount($)"])) || 0;
                    const amount5 = formatValue(qty5 * unitPrice5);

                    if (amountValue5 > 0) {
                        let desc5 = itemName5;
                        if (itemNumber5) {
                            desc5 += ` - ${itemNumber5}`;
                        }
                        if (desc5 == '') {
                            desc5 = 'Centre Capital Costs Item';
                        }

                        if (parseFloat(formatValue(amountValue5)) != parseFloat(formatValue(amount5))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc5,
                            servicePlanValues?.centreCapitalCostsUnit || ' ',
                            formatValue(qty5),
                            formatValue(unitPrice5),
                            gstLabel,
                            formatValue(amount5)
                        ]);
                        subTotal += Number(amount5);
                    }

                    // Line 6: Labour Travel Time
                    const unitPrice6 = Number(servicePlanValues?.labourTravelTimeUnitPrice) || 0;
                    const qty6 = Number(invoiceValues["Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable."]) || 0;
                    const amountValue6 = formatValue(Number(invoiceValues["Labour Travel Time Amount($)"])) || 0;
                    const amount6 = formatValue(qty6 * unitPrice6);

                    if (amountValue6 > 0) {
                        const desc6 = 'Provider Travel - Labour Travel Time Costs';

                        if (parseFloat(formatValue(amountValue6)) != parseFloat(formatValue(amount6))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc6,
                            servicePlanValues?.labourTravelTimeUnit || ' ',
                            formatValue(qty6),
                            formatValue(unitPrice6),
                            gstLabel,
                            formatValue(amount6)
                        ]);
                        subTotal += Number(amount6);
                    }

                    // Line 7: Allowances
                    const unitPrice7 = Number(invoiceValues['Used Allowance Amount($) as per the Service Plan']) || 0;
                    const qty7 = 1;
                    const amountValue7 = formatValue(Number(invoiceValues["Allowances Amount($)"])) || 0;
                    const amount7 = formatValue(unitPrice7);

                    if (amountValue7 > 0) {
                        const desc7 = `Allowances - ${invoiceValues["Allowances"]}`;

                        if (parseFloat(formatValue(amountValue7)) != parseFloat(formatValue(amount7))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc7,
                            servicePlanValues?.usedAllowanceUnit || ' ',
                            formatValue(qty7),
                            formatValue(unitPrice7),
                            gstLabel,
                            formatValue(amount7)
                        ]);
                        subTotal += Number(amount7);
                    }

                    // Line 8: Non-Face-to-Face Support
                    const unitPrice8 = Number(servicePlanValues?.nonFaceToFaceSupportUnitPrice) || 0;
                    const qty8 = Number(invoiceValues["Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)"]) || 0;
                    const amountValue8 = formatValue(Number(invoiceValues["Non-Face-to-Face Amount($)"])) || 0;
                    const amount8 = formatValue(qty8 * unitPrice8);

                    if (amountValue8 > 0) {
                        const desc8 = `Non-Face-to-Face Support - ${invoiceValues["Non-Face-to-Face Supports"]}`;

                        if (parseFloat(formatValue(amountValue8)) != parseFloat(formatValue(amount8))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc8,
                            servicePlanValues?.nonFaceToFaceSupportUnit || ' ',
                            formatValue(qty8),
                            formatValue(unitPrice8),
                            gstLabel,
                            formatValue(amount8)
                        ]);
                        subTotal += Number(amount8);
                    }
                } else {
                    if (!cancellationTypeValues) {
                        setIntegrationMessage(workspaceId, boardId, item.id, "Cancellation Type Item not found");
                        throw new Error("Cancellation Type Item not found");
                    }
                    const cancellationPercentage1 = Number(cancellationTypeValues?.billableToClient) || 0;
                    const scheduledShiftDuration = (invoiceValues['Scheduled Shift Duration(Hr.)'] > 0)
                        ? Number(invoiceValues['Scheduled Shift Duration(Hr.)']).toFixed(1)
                        : 0;
                    let totalCancellationFee = 0;
                    const amountValue1 = formatValue(Number(invoiceValues["Cancellation Fee($)"])) || 0;
                    if (servicePlanValues?.directSupportShortNoticeCancellations === 'Y') {
                        // Line 1: Direct Support - Hour based (Cancelled)
                        const baseUnitPrice1 = groupSize > 0 ? Number(servicePlanValues?.directSupportUnitPrice) / groupSize : 0;
                        const itemName1 = servicePlanValues?.directSupportItemName || '';
                        const itemNumber1 = servicePlanValues?.directSupportItemNumber || '';
                        let unitPrice1, amount1;
                        let qty1 = scheduledShiftDuration;
                        if (servicePlanValues?.directSupportUnit === "Hour(H)") {
                            unitPrice1 = Number(formatValue(baseUnitPrice1 * (cancellationPercentage1 / 100)));
                        } else {
                            const nonTimeBasedValue = Number(servicePlanValues.directSupportUnitPrice) || 0;
                            unitPrice1 = Number(formatValue(nonTimeBasedValue * (cancellationPercentage1 / 100)));
                            qty1 = Number(invoiceValues["Quantity (Direct Support - Non Time Based Support)"]) || 0;
                        }

                        amount1 = formatValue(qty1 * unitPrice1);

                        if (amountValue1 > 0) {
                            let desc1 = 'Cancellation Fee';
                            if (itemName1) {
                                desc1 += ` - ${itemName1}`;
                            }
                            if (itemNumber1) {
                                desc1 += ` - ${itemNumber1}`;
                            }
                            desc1 += ` - ${cancellationPercentage1}%`;
                            if (groupSize !== 1) {
                                desc1 += ` - Group Size: ${groupSize}`;
                            }

                            ordersArr.push([
                                desc1,
                                servicePlanValues?.directSupportUnit || ' ',
                                formatValue(qty1),
                                formatValue(unitPrice1),
                                gstLabel,
                                formatValue(amount1)
                            ]);
                            subTotal += Number(amount1);
                            totalCancellationFee += Number(amount1);
                        }
                    }
                    if (servicePlanValues?.providerTravelShortNoticeCancellations === 'Y') {
                        // Line 3: Provider Travel - Non-Labour Cost
                        const baseUnitPrice3 = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
                        const itemName3 = servicePlanValues?.providerTravelItemName || '';
                        const itemNumber3 = servicePlanValues?.providerTravelItemNumber || '';
                        const qty3 = scheduledShiftDuration;
                        const unitPrice3 = Number(formatValue(baseUnitPrice3 * (cancellationPercentage1 / 100)));
                        const amount3 = formatValue(qty3 * unitPrice3);

                        if (amount3 > 0) {
                            let desc3 = 'Cancellation Fee';
                            if (itemName3) {
                                desc3 += ` - ${itemName3}`;
                            }
                            if (itemNumber3) {
                                desc3 += ` - ${itemNumber3}`;
                            }
                            desc3 += ` - ${cancellationPercentage1}%`;

                            ordersArr.push([
                                desc3,
                                servicePlanValues?.nonLabourTravelUnit || ' ',
                                formatValue(qty3),
                                formatValue(unitPrice3),
                                gstLabel,
                                formatValue(amount3)
                            ]);
                            subTotal += Number(amount3);
                            totalCancellationFee += Number(amount3);
                        }
                    }
                    if (servicePlanValues?.activityBasedTransportShortNoticeCancellations === 'Y') {
                        // Line 4: Activity Based Transport
                        const baseUnitPrice4 = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
                        const itemName4 = servicePlanValues?.activityBasedTransportItemName || '';
                        const itemNumber4 = servicePlanValues?.activityBasedTransportItemNumber || '';
                        const qty4 = scheduledShiftDuration;
                        const unitPrice4 = Number(formatValue(baseUnitPrice4 * (cancellationPercentage1 / 100)));
                        const amount4 = formatValue(qty4 * unitPrice4);
                        if (amount4 > 0) {
                            let desc4 = 'Cancellation Fee';
                            if (itemName4) {
                                desc4 += ` - ${itemName4}`;
                            }
                            if (itemNumber4) {
                                desc4 += ` - ${itemNumber4}`;
                            }
                            desc4 += ` - ${cancellationPercentage1}%`;

                            ordersArr.push([
                                desc4,
                                servicePlanValues?.activityBasedTransportUnit || ' ',
                                formatValue(qty4),
                                formatValue(unitPrice4),
                                gstLabel,
                                formatValue(amount4)
                            ]);
                            subTotal += Number(amount4);
                            totalCancellationFee += Number(amount4);
                        }
                    }
                    if (servicePlanValues?.centreCapitalCostsShortNoticeCancellations === 'Y') {
                        // Line 5: Centre Capital Costs
                        const baseUnitPrice5 = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
                        const itemName5 = servicePlanValues?.centreCapitalCostsItemName || '';
                        const itemNumber5 = servicePlanValues?.centreCapitalCostsItemNumber || '';
                        let qty5 = scheduledShiftDuration;
                        const unitPrice5 = Number(formatValue(baseUnitPrice5 * (cancellationPercentage1 / 100)));
                        const amount5 = formatValue(qty5 * unitPrice5);
                        if (baseUnitPrice5 > 0 && amount5 > 0) {
                            let desc5 = 'Cancellation Fee';
                            if (itemName5) {
                                desc5 += ` - ${itemName5}`;
                            }
                            if (itemNumber5) {
                                desc5 += ` - ${itemNumber5}`;
                            }
                            desc5 += ` - ${cancellationPercentage1}%`;

                            ordersArr.push([
                                desc5,
                                servicePlanValues?.centreCapitalCostsUnit || ' ',
                                formatValue(qty5),
                                formatValue(unitPrice5),
                                gstLabel,
                                formatValue(amount5)
                            ]);
                            subTotal += Number(amount5);
                            totalCancellationFee += Number(amount5);
                        }
                    }
                    if (parseFloat(formatValue(amountValue1)) != parseFloat(formatValue(totalCancellationFee))) {
                        setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                    }
                }

                if (ordersArr.length === 0) {
                    await setIntegrationMessage(workspaceId, boardId, item.id, "There is nothing to invoice!");
                    return res.status(200).json({ message: "There is nothing to invoice!" });
                }

                const orders = JSON.stringify(ordersArr);
                subTotal = formatValue(subTotal);
                const gstTotal = formatValue((parseFloat(subTotal) * parseFloat(gst) / 100));
                const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

                const clientDetails = {
                    Contact: participantProfileValues.billingContact || ' ',
                    Address: participantProfileValues.billingAddress || ' '
                };

                const pdfBytes = await generate({
                    template: template,
                    inputs: [
                        {
                            logo: logoBase64,
                            subtotal: subTotal,
                            totalGST: gstTotal,
                            total: total,
                            clientDetails: JSON.stringify(clientDetails),
                            invoiceDetails: JSON.stringify({
                                Date: invoiceDate && invoiceDate != "" ? new Date(invoiceDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                                "Invoice Number": invoiceNumber
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
                            orders: orders,
                            "dueDate": dueDate && dueDate != "" ? new Date(dueDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                            "Bank Details": JSON.stringify({
                                "Account Name": business.bankDetails.accountName,
                                "Bank Name": business.bankDetails.bankName,
                                BSB: business.bankDetails.bsb,
                                "Account Number": business.bankDetails.accountNumber,
                                "invoice Number": invoiceNumber
                            })
                        }
                    ],
                    plugins: { text, image, line, table, multiVariableText }
                });

                const filename = `output/${workspaceId}/${boardId}/NDIS-invoices/${invoiceNumber + '-ISO+™-' + item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);

                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename);
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'NDIS Invoice', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`);
                    await saveInvoiceNumber(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`, 'PDF', fileUrl);
                    business.documentNumbering.invoice.nextNumber += 1;
                    await business.save();
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF NDIS Invoice', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, extractContextFromReq(req));
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/invoiceparticipanttax', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        const itemIds = req.body.items?.map(item => item.id || item) || req.body.itemIds || [];

        if (!itemIds || itemIds.length === 0) {
            return res.status(400).json({ message: "No items provided for invoice generation." });
        }

        // Check if this is a Low-Cat board
        const isLowCat = req.body?.isLowCat || false;
        let boardLabel = '';
        if (!isLowCat) {
            // Check board label from database
            const board = await Board.findOne({ boardId: boardId.toString() }).lean();
            if (board?.label === 'Care Management - SaH - Low Cat') {
                boardLabel = board.label;
            }
        }
        const isLowCatBoard = isLowCat || boardLabel === 'Care Management - SaH - Low Cat';

        // Validate all items belong to the workspace/board and fetch from database
        const dbItems = [];
        for (const itemId of itemIds) {
            await validateItemBelongsToTenant(workspaceId, boardId, itemId);
            const dbItem = await Item.findOne({ workspaceId, boardId, itemId: itemId.toString() }).lean();
            if (!dbItem) {
                throw new Error(`Item ${itemId} not found`);
            }
            dbItems.push(dbItem);
        }

        try {
            const templatePath = isLowCatBoard ? path.join(__dirname, '..', 'assets', 'taxInvoiceAG.json') : path.join(__dirname, '..', 'assets', 'participantTaxInvoiceAG.json');
            const templateData = await fs.readFile(templatePath, 'utf8');
            const template = JSON.parse(templateData);
            enableRepeatHeadOnTables(template);

            const logoBase64 = await getLogoData(business);

            const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;

            let ordersArr = [];
            let totalParticipantContribution = 0;
            let totalAmountSum = 0; 
            const gstLabel = "GST Free";

            // Get dates from request or use defaults
            let invoiceDate = req.body?.invoiceDate || new Date().toISOString();
            let dueDate = req.body?.dueDate || '';

            if (!dueDate) {
                const d = new Date(invoiceDate);
                d.setDate(d.getDate() + 14);
                dueDate = d.toISOString();
            }

            // Helper functions
            const dateFmt = (d) => d ? new Date(d).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
            const toNumber = (v) => typeof v === 'number' ? v : Number(v || 0);
            const fmt = (v) => formatValue(toNumber(v));

            // OPTIMIZED: Collect all reference IDs first, then bulk fetch from database
            const participantProfileIds = new Set();
            const servicePlanIds = new Set();

            // Extract all reference IDs from items
            for (const dbItem of dbItems) {
                const getValue = (attributeName) => getValueFromFlatData(dbItem, attributeName);

                // Get participant profile ID
                const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
                const participantProfileId = extractRefId(participantProfileValue);
                if (participantProfileId) participantProfileIds.add(participantProfileId);

                // Get service plan ID
                const servicePlanValue = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
                const servicePlanId = extractRefId(servicePlanValue);
                if (servicePlanId) servicePlanIds.add(servicePlanId);
            }

            // Bulk fetch all reference items from MongoDB (NO API calls!)
            const allRefIds = [...participantProfileIds, ...servicePlanIds];
            const refItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, allRefIds);

            info('Webhook-Service', 'Bulk fetched reference items from DB', {
                participantProfiles: participantProfileIds.size,
                servicePlans: servicePlanIds.size,
                foundItems: refItemsMap.size
            }, extractContextFromReq(req));

            // Fetch participant profile details from first item using database lookup
            let participantName = ' ';
            let receiverName = ' ';
            let receiverAddress = ' ';

            if (dbItems.length > 0) {
                const firstItem = dbItems[0];
                const getValue = (attributeName) => getValueFromFlatData(firstItem, attributeName);

                // Get Participant Profile reference from DB lookup map
                const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
                const participantProfileId = extractRefId(participantProfileValue);

                if (participantProfileId) {
                    const participantProfileItem = refItemsMap.get(participantProfileId);
                    if (participantProfileItem) {
                        // Use helper functions to get participant profile data
                        const profileName = getParticipantNameFromProfile(participantProfileItem);
                        participantName = profileName || ' ';

                        // Always try to get billing contact and billing address from participant profile
                        // These are the preferred fields for the PDF template
                        receiverName = getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_CONTACT) || ' ';
                        const billingAddressBase = getValueFromFlatData(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_BILLING_ADDRESS) || ' ';
                        receiverAddress = billingAddressBase.trim() || ' ';
                    }
                }
            }

            // Process all items and add them to the orders array using database lookups
            for (const dbItem of dbItems) {
                const getValue = (attributeName) => getValueFromFlatData(dbItem, attributeName);

                // Get Transaction Status and format it
                const transactionStatusValue = getValue(ATTRIBUTE_NAMES.TRANSACTION_STATUS);
                const transactionStatus = formatLabelValue(transactionStatusValue);

                // Date: If Transaction Status is "Delivered - To be claimed and invoiced.", use Actual Shift End Date & Time, otherwise Scheduled Shift Start Date & Time
                let rowDate = ' ';
                const isDelivered = transactionStatus && transactionStatus === 'Delivered - To be claimed and invoiced.';

                if (isDelivered) {
                    const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END);
                    if (actualEnd) {
                        rowDate = dateFmt(actualEnd);
                    }
                } else {
                    const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START);
                    if (scheduledStart) {
                        rowDate = dateFmt(scheduledStart);
                    }
                }

                // Description: Service name from Service Plan using helper function
                let description = '';
                const servicePlanValue = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
                const servicePlanId = extractRefId(servicePlanValue);

                if (servicePlanId) {
                    const servicePlanItem = refItemsMap.get(servicePlanId);
                    description = getServiceFromServicePlan(servicePlanItem) || '';
                }

                if (!description) {
                    description = 'Service';
                }

                // For Adjustment transactions (Adjustment (Charge) or Adjustment (Refund)), append Additional Notes
                const isAdjustment = transactionStatus && (
                    transactionStatus === 'Adjustment (Charge) - To be claimed and invoiced.' ||
                    transactionStatus === 'Adjustment (Refund) - To be claimed and invoiced.'
                );
                if (isAdjustment) {
                    const notes = getValue(ATTRIBUTE_NAMES.ADDITIONAL_NOTES);
                    if (notes) {
                        const cleanNotes = (typeof notes === 'string') ? notes.replace(/<[^>]*>/g, '').trim() : '';
                        if (cleanNotes) {
                            description = `${description} - ${cleanNotes}`;
                        }
                    }
                }

                // Get other fields
                const unit = getValue(ATTRIBUTE_NAMES.UNIT) || ' ';
                const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;
                const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
                const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
                const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;

                let rowParticipantName = participantName;
                if (isLowCatBoard) {
                    const itemParticipantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
                    const itemParticipantProfileId = extractRefId(itemParticipantProfileValue);
                    if (itemParticipantProfileId) {
                        const itemParticipantProfileItem = refItemsMap.get(itemParticipantProfileId);
                        if (itemParticipantProfileItem) {
                            const itemProfileName = getParticipantNameFromProfile(itemParticipantProfileItem);
                            rowParticipantName = itemProfileName || participantName;
                        }
                    }
                }

                if (isLowCatBoard) {
                    ordersArr.push([
                        rowParticipantName,
                        rowDate,
                        description,
                        unit,
                        fmt(quantity),
                        formatCurrencyValue(unitPrice),
                        gstLabel,
                        formatCurrencyValue(totalAmount)
                    ]);
                    totalAmountSum += totalAmount;
                } else {
                    ordersArr.push([
                        rowDate,
                        description,
                        unit,
                        fmt(quantity),
                        formatCurrencyValue(unitPrice),
                        gstLabel,
                        formatCurrencyValue(totalAmount),
                        formatCurrencyValue(participantContribution)
                    ]);
                    totalParticipantContribution += participantContribution;
                }
            }

            if (ordersArr.length === 0) {
                await Promise.all(dbItems.map(item =>
                    setIntegrationMessage(workspaceId, boardId, item.itemId, "There is nothing to invoice!")
                ));
                return res.status(400).json({ message: "There is nothing to invoice!" });
            }

            const orders = JSON.stringify(ordersArr);
            
            let subtotalValue, totalAUDValue;
            if (isLowCatBoard) {
                subtotalValue = formatCurrencyValue(totalAmountSum);
                totalAUDValue = formatCurrencyValue(totalAmountSum);
            } else {
                subtotalValue = formatCurrencyValue(totalParticipantContribution);
                totalAUDValue = formatCurrencyValue(totalParticipantContribution);
            }
            const gstTotal = formatValue(0); // Total GST: $ 0.00

            // Map client details to match template - both templates expect "Billing Contact" and "Billing Address"
            // Use billing contact/address from profile if available, otherwise fall back to participant name and address
            let billingContact = (receiverName && receiverName.trim() !== '' && receiverName.trim() !== ' ') 
                ? receiverName.trim() 
                : (participantName && participantName.trim() !== '' && participantName.trim() !== ' ' 
                    ? participantName.trim() 
                    : ' ');
            
            let billingAddress = (receiverAddress && receiverAddress.trim() !== '' && receiverAddress.trim() !== ' ') 
                ? receiverAddress.trim() 
                : ' ';

            // Generate the PDF with all items
            const pdfBytes = await generate({
                template: template,
                inputs: [
                    {
                        logo: logoBase64,
                        subtotal: subtotalValue,
                        totalGST: formatCurrencyValue(0),
                        total: totalAUDValue,
                        clientDetails: JSON.stringify({
                            "Billing Contact": billingContact,
                            "Billing Address": billingAddress
                        }),
                        invoiceDetails: JSON.stringify({
                            Date: new Date(invoiceDate).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }),
                            "Invoice Number": invoiceNumber
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
                        orders: orders,
                        "dueDate": new Date(dueDate).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }),
                        "Bank Details": JSON.stringify({
                            "Account Name": business.bankDetails.accountName,
                            "Bank Name": business.bankDetails.bankName,
                            BSB: business.bankDetails.bsb,
                            "Account Number": business.bankDetails.accountNumber,
                            "invoice Number": invoiceNumber
                        })
                    }
                ],
                plugins: { text, image, line, table, multiVariableText }
            });

            // Upload the single PDF for all items
            const filename = `output/${workspaceId}/${boardId}/Participant-invoices/${invoiceNumber + '-ISO+™-' + participantName.replace(/\s+/g, '-')}.pdf`;
            const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);

            if (uploadResult['$metadata'].httpStatusCode === 200) {
                const fileUrl = await getS3FileUrl(filename);

                // Update integration messages and generated fields for all items
                await Promise.all(dbItems.map(async (item) => {
                    await setIntegrationMessage(workspaceId, boardId, item.itemId, "Invoice generated successfully");
                    await setGeneratedField(workspaceId, boardId, item.itemId, `${invoiceNumber} (ISO+™)`);
                    await saveInvoiceNumber(workspaceId, boardId, item.itemId, `${invoiceNumber} (ISO+™)`, 'PDF', fileUrl);
                }));

                // Increment invoice number only once
                business.documentNumbering.invoice.nextNumber += 1;
                await business.save();

                logAuditTrail({
                    workspaceId,
                    action: "Generate PDF Participant Tax Invoice",
                    detail: `Invoice generated successfully, invoice number: ${invoiceNumber} (ISO+™), participant: ${participantName}, items: ${dbItems.length}, fileUrl: ${fileUrl}`,
                    req
                });

                return res.status(200).json({
                    message: "Participant Tax Invoice generated successfully",
                    invoiceNumber: `${invoiceNumber} (ISO+™)`,
                    fileUrl: fileUrl,
                    itemCount: dbItems.length
                });
            } else {
                throw new Error('Upload of PDF failed, please provide correct information.');
            }
        } catch (err) {
            // Do not call per-item error responder; log and send a single error response
            const errorMessage = (err && err.message) ? err.message : 'Server error: An unknown error occurred. Please contact support via ISO+™ Portal.';
            error('Webhook-Service', 'Server error', { message: errorMessage }, extractContextFromReq(req));
            return res.status(500).json({ message: errorMessage });
        }
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, extractContextFromReq(req));
        return res.status(500).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/monthly-statement', async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const { statementData, businessDetails, chartImage, timezone } = req.body;

        if (!statementData) {
            return res.status(400).json({ message: "No statement data provided." });
        }

        const business = await getValidatedBusiness(workspaceId);

        try {
            // Use the monthlyStatement.json template
            const templatePath = path.join(__dirname, '..', 'assets', 'monthlyStatement.json');
            const templateData = await fs.readFile(templatePath, 'utf8');
            const template = JSON.parse(templateData);
            enableRepeatHeadOnTables(template);

            const logoBase64 = await getLogoData(business);

            const safeBusinessDetails = {
                companyName: businessDetails?.companyName || business.name || 'Service Provider',
                companyRegistrationId: businessDetails?.companyRegistrationId || business.companyRegistrationId || '',
                phoneNumber: businessDetails?.phoneNumber || business.phone || '',
                businessEmail: businessDetails?.businessEmail || business.email || '',
                address: businessDetails?.address || business.address?.street || '',
                suburb: businessDetails?.suburb || business.address?.suburb || '',
                state: businessDetails?.state || business.address?.state || '',
                postcode: businessDetails?.postcode || business.address?.postcode || ''
            };

            const participant = statementData.participant || statementData.participantProfile || '';
            const monthNum = statementData.monthNumber || '';
            const yearVal = statementData.year || '';
            let startDate, endDate;
            if (monthNum && yearVal) {
                const mi = Number(monthNum) - 1, yi = Number(yearVal);
                if (!isNaN(mi) && !isNaN(yi)) {
                    startDate = new Date(Date.UTC(yi, mi, 1)).toISOString();
                    endDate = new Date(Date.UTC(yi, mi + 1, 0, 23, 59, 59, 999)).toISOString();
                }
            }

            const [budgetItems, services] = await Promise.all([
                fetchBudgetItems(workspaceId, boardId, { participant, month: monthNum, year: yearVal }),
                fetchServiceItems(workspaceId, boardId, { participant, startDate, endDate })
            ]);

            info('Webhook-Service', 'Monthly statement PDF: fetched ISO+ data', {
                budgetCount: budgetItems.length, serviceCount: services.length, participant
            }, extractContextFromReq(req));

            const budgetAggregates = calculateBudgetAggregates(budgetItems);

            const monthNumber = statementData.monthNumber || '1';
            const yearValue = statementData.year || new Date().getFullYear().toString();
            const firstAggregate = Object.values(budgetAggregates)[0] || {};
            const quarterLabel = statementData.summary?.quarter || firstAggregate.quarterLabel || '';
            const quarterMeta = getQuarterMetadata(monthNumber, yearValue, quarterLabel, timezone);

            const subtitlePayload = {
                'Month No.': quarterMeta.monthNo.toString(),
                'Quarter No': quarterMeta.quarterLabel,
                'First Day': quarterMeta.firstDay,
                'Last Day': quarterMeta.lastDay
            };

            const templateInputs = {};
            await resolveTemplateImageUrls(template, templateInputs);
            templateInputs.logo = logoBase64 || templateInputs.logo || '';

            // Summary Table: use chart image from frontend when provided; hide if all values $0.00; else mini-chart
            const hasChartFromFrontend = chartImage && typeof chartImage === 'string' && chartImage.length > 50;
            const chartBudgetCats = statementData.budgetCategories || [];
            const allCategoriesZero = chartBudgetCats.length === 0 || chartBudgetCats.every((c) => {
                const avail = Number(c.availableFunds ?? 0);
                const rem = Number(c.remainingBudget ?? 0);
                const del = Number(c.serviceDeliveredAmount ?? 0);
                return avail === 0 && rem === 0 && del === 0;
            });
            if (hasChartFromFrontend) {
                templateInputs['Summary Table'] = chartImage.startsWith('data:') ? chartImage : `data:image/png;base64,${chartImage}`;
                info('Webhook-Service', 'Monthly statement PDF: using chart image from frontend', { sizeChars: chartImage.length }, extractContextFromReq(req));
            } else if (!hasChartFromFrontend && allCategoriesZero) {
                // Hide bar chart section when not applicable (all values $0.00)
                templateInputs['Summary Table'] = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            } else {
                const miniChartPath = path.join(__dirname, '..', 'assets', 'mini-chart.png');
                try {
                    const miniChartBuffer = await fs.readFile(miniChartPath);
                    templateInputs['Summary Table'] = `data:image/png;base64,${miniChartBuffer.toString('base64')}`;
                } catch (miniChartErr) {
                    warn('Webhook-Service', 'Monthly statement mini-chart not found, using template default for Summary Table', { path: miniChartPath }, extractContextFromReq(req));
                }
            }

            const footerImagePath = path.join(__dirname, '..', 'assets', 'monthly-statement-footer.png');
            try {
                const footerBuffer = await fs.readFile(footerImagePath);
                templateInputs['Image 13-1'] = `data:image/png;base64,${footerBuffer.toString('base64')}`;
            } catch (footerErr) {
                warn('Webhook-Service', 'Monthly statement footer image not found, using template default', { path: footerImagePath }, extractContextFromReq(req));
            }

            setMultiValueField(templateInputs, 'companyName', { 'Company Name': safeBusinessDetails.companyName });

            const participantName = statementData.participant || statementData.participantProfile || 'Participant';
            const participantAddress = statementData.participantAddress || '';
            const participantSuburb = statementData.participantSuburb || '';
            const participantState = statementData.participantState || '';
            const participantPostcode = statementData.participantPostcode || '';

            // Organisation block: Provider ID = Company Registration ID, Location = Street Address (Business Details)
            setMultiValueField(templateInputs, 'Organisation', {
                'Participant': participantName,
                'My Aged Care ID Number': statementData.myAgedCareIdNumber || '',
                'Provider ID': statementData.providerId || safeBusinessDetails.companyRegistrationId || '',
                'Address': safeBusinessDetails.address || '',
                'Suburb': safeBusinessDetails.suburb || '',
                'Post Code': safeBusinessDetails.postcode || '',
                'State': safeBusinessDetails.state || ''
            });

            setMultiValueField(templateInputs, 'Recipient', {
                'Participant': participantName,
                'Address': participantAddress,
                'Suburb': participantSuburb,
                'State': participantState,
                'Post Code': participantPostcode
            });

            setMultiValueField(templateInputs, 'Text title', {
                month: statementData.month || '',
                year: yearValue
            });

            // Populate all subtitle fields in the template with quarter metadata
            const allSubtitleFields = [
                'P2 Subtitle',
                'P3 Subtitle', 'P3 Subtitle copy',
                'P4 Subtitle copy',
                'P5 Subtitle copy',
                'P7 Subtitle 1 copy', 'P7 Subtitle  2 copy', 'P7 Subtitle  2 copy 2', 'P7 Subtitle  2 copy copy',
                'P8 Subtitle  copy',
                'P9 Subtitle', 'P9 Subtitle copy', 'P9 Subtitle-2',
                'P10 Subtitle copy', 'P10 Subtitle-2 copy',
                'P11 Subtitle copy', 'P11 Subtitle-2 copy',
                'P12 Subtitle  copy', 'P12 Subtitle-2  copy', 'P12 Subtitle-2  copy copy'
            ];
            allSubtitleFields.forEach((field) => {
                setMultiValueField(templateInputs, field, subtitlePayload);
            });

            // Page 1 and Page 14 contact: Phone Number and Business Email from Business Details (ISO+ Portal)
            const businessContactPayload = {
                'Phone Number': safeBusinessDetails.phoneNumber || '',
                'Business Email': safeBusinessDetails.businessEmail || ''
            };
            setMultiValueField(templateInputs, 'Disclaimer 2a', businessContactPayload);
            setMultiValueField(templateInputs, 'Text 13-', businessContactPayload);

            const firstDayPayload = { 'first day': quarterMeta.firstDay };
            const lastDayPayload = { 'last day': quarterMeta.lastDay };
            [
                'P2-10', 'P2-11',
                'P2-11 copy',
                'P4-8 copy',
                'P4-20 copy',
                'P5-7 copy',
                'P5-8', 'P5-20',
                'P3-7',
                'P3-17 copy'
            ].forEach((f) => setMultiValueField(templateInputs, f, firstDayPayload));
            [
                'P2-14', 'P2-14 copy',
                'P4-11 copy',
                'P4-23 copy',
                'P5-10 copy',
                'P5-11', 'P5-23',
                'P3-10',
                'P3-20 copy'
            ].forEach((f) => setMultiValueField(templateInputs, f, lastDayPayload));

            const homeSupportAggregate = budgetAggregates.HSQ ? { ...budgetAggregates.HSQ } : initializeBudgetAggregate();
            homeSupportAggregate.primarySupplementLabel = safeString(homeSupportAggregate.primarySupplementLabel) || safeString(homeSupportAggregate.fund) || safeString(homeSupportAggregate.fundClassification) || '';

            applyBudgetMapping(templateInputs, homeSupportAggregate, [
                { type: 'multi', field: 'P2-3', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P2-1', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P2-2', value: (agg) => agg.quarterlyAdjustment },
                { type: 'currency', field: '$P2-3', value: (agg) => (agg.primarySupplementAmount ?? 0) },
                { type: 'currency', field: '$P2-4', value: (agg) => agg.carryoverFunding + agg.unspentReturned },
                { type: 'currency', field: '$P2-6', value: (agg) => agg.commonwealthUnspent + agg.providerUnspent + agg.participantUnspent },
                { type: 'currency', field: ['$P2-6 copy copy', '$P4-8'], value: (agg) => agg.commonwealthUnspent },
                { type: 'currency', field: ['$P2-7 copy copy', '$P4-9'], value: (agg) => agg.providerUnspent },
                { type: 'currency', field: ['$P2-8 copy copy', '$P4-10'], value: (agg) => agg.participantUnspent },
                { type: 'currency', field: '$P2-9', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P2-10', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P2-11', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P2-12', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P2-13', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P2-14', value: (agg) => agg.remainingBalance },
                { type: 'currency', field: ['$P2-14 copy', '$P4-11'], value: (agg) => agg.commonwealthUnspent + agg.providerUnspent + agg.participantUnspent },
                { type: 'currency', field: ['$P7-4 copy', '$P4-5'], value: (agg) => agg.carryoverFunding },
                { type: 'currency', field: ['$P7-5 copy', '$P4-6'], value: (agg) => agg.unspentReturned },
                { type: 'currency', field: ['$P7-6 copy', '$P4-7'], value: (agg) => agg.carryoverFunding + agg.unspentReturned }
            ]);

            const restorativeAggregate = budgetAggregates.RCP ? { ...budgetAggregates.RCP } : initializeBudgetAggregate();
            restorativeAggregate.primarySupplementLabel = safeString(restorativeAggregate.primarySupplementLabel) || safeString(restorativeAggregate.fund) || safeString(restorativeAggregate.fundClassification) || '';

            applyBudgetMapping(templateInputs, restorativeAggregate, [
                { type: 'multi', field: 'P3-2', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P3-1', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P3-2', value: (agg) => (agg.primarySupplementAmount ?? 0) },
                { type: 'currency', field: '$P3-6', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P3-7', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P3-8', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P3-9', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P3-10', value: (agg) => agg.remainingBalance }
            ]);

            setMultiValueField(templateInputs, 'P3 Subtitle', {
                ' Funding Start Date': formatDateToAU(restorativeAggregate.fundingStartDate, timezone) || 'N/A',
                ' Funding end date': formatDateToAU(restorativeAggregate.fundingEndDate, timezone) || 'N/A'
            });

            const endOfLifeAggregate = budgetAggregates.EOL ? { ...budgetAggregates.EOL } : initializeBudgetAggregate();
            endOfLifeAggregate.primarySupplementLabel = safeString(endOfLifeAggregate.primarySupplementLabel) || safeString(endOfLifeAggregate.fund) || safeString(endOfLifeAggregate.fundClassification) || '';

            applyBudgetMapping(templateInputs, endOfLifeAggregate, [
                { type: 'multi', field: 'P3-12 copy', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P3-11 copy', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P3-12 copy', value: (agg) => (agg.primarySupplementAmount ?? 0) },
                { type: 'currency', field: '$P3-16 copy', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P3-17 copy', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P3-18 copy', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P3-19 copy', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P3-20 copy', value: (agg) => agg.remainingBalance }
            ]);

            // Explicitly set EOL subtitle variables (template uses different var names than generic subtitle)
            setMultiValueField(templateInputs, 'P3 Subtitle copy', {
                ' Funding Start Date': formatDateToAU(endOfLifeAggregate.fundingStartDate, timezone) || 'N/A',
                ' Funding end date': formatDateToAU(endOfLifeAggregate.fundingEndDate, timezone) || 'N/A'
            });

            const assistiveShortAggregate = budgetAggregates.ATS ? { ...budgetAggregates.ATS } : initializeBudgetAggregate();
            assistiveShortAggregate.primarySupplementLabel = safeString(assistiveShortAggregate.primarySupplementLabel) || safeString(assistiveShortAggregate.fund) || safeString(assistiveShortAggregate.fundClassification) || '';

            applyBudgetMapping(templateInputs, assistiveShortAggregate, [
                { type: 'multi', field: 'P4-2 copy', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: ['$P4-1  copy', '$P5-1'], value: (agg) => agg.availableFundStart },
                { type: 'currency', field: ['$P4-2 copy', '$P5-2'], value: (agg) => (agg.primarySupplementAmount ?? 0) },
                { type: 'currency', field: ['$P4-3 copy', '$P5-3'], value: (agg) => (agg.additionalAmountApproved ?? agg.fundAmount ?? 0) },
                { type: 'currency', field: ['$P4-7 copy', '$P5-7'], value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: ['$P4-8 copy', '$P5-8'], value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: ['$P4-9 copy', '$P5-9'], value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: ['$P4-10 copy', '$P5-10'], value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: ['$P4-11 copy', '$P5-11'], value: (agg) => agg.remainingBalanceEndOfMonth ?? 0},
                { type: 'currency', field: ['$P4-12 copy', '$P5-12'], value: (agg) => agg.committedFunds },
                { type: 'currency', field: ['$P4-13 copy', '$P5-13'], value: (agg) => (agg.remainingBalanceAllocationPeriod ?? 0) },
                { type: 'multi', field: 'P4 Footer 1 copy', value: (agg) => ({ 'Funding End Date': formatDateToAU(agg.fundingEndDate, timezone) || 'N/A' }) }
            ]);

            const assistiveOngoingAggregate = budgetAggregates.ATO ? { ...budgetAggregates.ATO } : initializeBudgetAggregate();
            assistiveOngoingAggregate.primarySupplementLabel = safeString(assistiveOngoingAggregate.primarySupplementLabel) || safeString(assistiveOngoingAggregate.fund) || safeString(assistiveOngoingAggregate.fundClassification) || '';

            applyBudgetMapping(templateInputs, assistiveOngoingAggregate, [
                { type: 'multi', field: 'P4-15 copy', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: ['$P4-14 copy', '$P5-14'], value: (agg) => agg.availableFundStart },
                { type: 'currency', field: ['$P4-15 copy', '$P5-15'], value: (agg) => (agg.primarySupplementAmount ?? 0) },
                { type: 'currency', field: ['$P4-19 copy', '$P5-19'], value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: ['$P4-20 copy', '$P5-20'], value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: ['$P4-21 copy', '$P5-21'], value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: ['$P4-22 copy', '$P5-22'], value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: ['$P4-23 copy', '$P5-23'], value: (agg) => agg.remainingBalanceEndOfMonth ?? 0},
                { type: 'currency', field: ['$P4-24 copy', '$P5-24'], value: (agg) => agg.committedFunds },
                { type: 'currency', field: ['$P4-25 copy', '$P5-25'], value: (agg) => (agg.remainingBalanceAllocationPeriod ?? 0) },
                { type: 'multi', field: 'P4 Footer 2 copy', value: (agg) => ({ 'Funding End Date': formatDateToAU(agg.fundingEndDate, timezone) || 'N/A' }) }
            ]);

            const homeModificationAggregate = budgetAggregates.HMB ? { ...budgetAggregates.HMB } : initializeBudgetAggregate();
            homeModificationAggregate.primarySupplementLabel = safeString(homeModificationAggregate.primarySupplementLabel) || safeString(homeModificationAggregate.fund) || safeString(homeModificationAggregate.fundClassification) || '';

            applyBudgetMapping(templateInputs, homeModificationAggregate, [
                { type: 'multi', field: 'P5- copy', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P5-1 copy', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P5-2 copy', value: (agg) => (agg.primarySupplementAmount ?? 0) },
                { type: 'currency', field: '$P5-6 copy', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P5-7 copy', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P5-8 copy', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P5-9 copy', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P5-10 copy', value: (agg) => agg.remainingBalanceEndOfMonth ?? agg.remainingBalance },
                { type: 'currency', field: '$P5-11 copy', value: (agg) => agg.committedFunds },
                { type: 'currency', field: '$P5-12 copy', value: (agg) => (agg.remainingBalanceAllocationPeriod ?? 0) },
                { type: 'multi', field: 'P4 Footer 2 copy copy', value: (agg) => ({ 'Funding End Date': formatDateToAU(agg.fundingEndDate, timezone) || 'N/A' }) }
            ]);

            // Pre-initialize ALL template tables with empty rows to prevent pdfme errors
            // These are all table field names from monthlyStatement.json
            const allTemplateTables = [
                { name: 'Table P6-1 copy', columns: 8 },
                { name: 'Table P6-1 copy copy copy', columns: 3 },
                { name: 'Table P7-1 copy', columns: 8 },
                { name: 'Table P9-1', columns: 8 },
                { name: 'Table P9-2', columns: 8 },
                { name: 'Table P10-1  copy', columns: 8 },
                { name: 'Table P10-2 copy', columns: 8 },
                { name: 'Table P10-3 copy', columns: 8 },
                { name: 'Table P11-1  copy', columns: 8 },
                { name: 'Table P11-2 copy', columns: 8 },
                { name: 'Table P11-3  copy', columns: 8 },
                { name: 'Table P12-1  copy', columns: 8 },
                { name: 'Table P12-3  copy', columns: 8 },
                { name: 'Table P11-2 copy copy', columns: 8 },
                { name: 'Table P12-1  copy copy', columns: 8 },
                { name: 'Table P12-3  copy copy', columns: 8 }
            ];

            allTemplateTables.forEach(({ name, columns }) => {
                const emptyRow = Array(columns).fill('');
                if (columns === 3) {
                    emptyRow[0] = '';
                    emptyRow[1] = 'No services recorded for this period';
                    emptyRow[2] = '';
                } else {
                    emptyRow[1] = 'No services recorded for this period';
                }
                templateInputs[name] = JSON.stringify([emptyRow]);
            });

            // Fill Table P6-1 copy copy copy (Care Management table - Table 3-1) with HSCM budget data
            // Aggregate all HSCM items into a single row with total hours for the month
            const hscmBudgetItems = budgetItems.filter(item => item.categoryCode === 'HSCM');
            if (hscmBudgetItems.length > 0) {
                // Table has 3 columns: Care Management (service name), Unit, Quantity
                const totalAllocatedTime = hscmBudgetItems.reduce((sum, item) =>
                    sum + parseNumberValue(item.hscmAllocatedTime || 0), 0);
                const hscmRows = [['Care Management', 'Hours', totalAllocatedTime !== 0 ? totalAllocatedTime.toFixed(1) : '0.0']];
                templateInputs['Table P6-1 copy copy copy'] = JSON.stringify(hscmRows);
            } else {
                // No HSCM items - show empty message
                templateInputs['Table P6-1 copy copy copy'] = JSON.stringify([['', 'No services recorded for this period', '']]);
            }

            const serviceBuckets = createServiceBuckets();
            services.forEach((service) => {
                const code = determineFundingCode(service);
                const bucket = serviceBuckets[code];
                if (!bucket) {
                    return;
                }

                const status = normalizeStatus(service.transactionStatus);
                const isCommitted = !!service.committedAtHmForDelivery;
                const hasCommittedBucket = isCommitted && Array.isArray(bucket.committed);
                const isAdjustment = (status.includes('adjust') || status.includes('refund') || status.includes('charge')) && Array.isArray(bucket.adjustment);
                const isDelivered = (status.includes('delivered') || status.includes('cancelled')) && Array.isArray(bucket.delivered);
                const canRecordDelivery = Array.isArray(bucket.delivered);

                if (hasCommittedBucket) {
                    bucket.committed.push(service);
                    return;
                }

                if (isAdjustment) {
                    bucket.adjustment.push(service);
                    return;
                }

                if (isDelivered) {
                    bucket.delivered.push(service);
                    return;
                }

                if (!status && canRecordDelivery) {
                    bucket.delivered.push(service);
                }
            });

            // For codes with committed buckets (ATS, ATO, HMB), merge adjustment/refund rows
            // into the delivered table so they appear at the bottom of the delivered section
            ['ATS', 'ATO', 'HMB'].forEach(code => {
                const bucket = serviceBuckets[code];
                if (bucket?.adjustment?.length > 0 && bucket?.delivered) {
                    bucket.delivered.push(...bucket.adjustment);
                    bucket.adjustment = [];
                }
            });

            const tableColumnCounts = {};

            Object.entries(SERVICE_TABLE_CONFIG).forEach(([code, tableConfig]) => {
                const bucket = serviceBuckets[code];
                if (!bucket) return;

                Object.values(tableConfig).forEach((config) => {
                    const sourceServices = bucket[config.rowType] || [];
                    const tableData = buildServiceTableRows(sourceServices, config, business, timezone);
                    templateInputs[config.tableName] = JSON.stringify(tableData.rows);
                    tableColumnCounts[config.tableName] = config.columns.length;

                    const totalValues = [tableData.totals.amount, tableData.totals.gov, tableData.totals.participant];
                    config.totals.forEach((fieldName, index) => {
                        const value = totalValues[Math.min(index, totalValues.length - 1)] || 0;
                        if (Array.isArray(fieldName)) {
                            fieldName.forEach((f) => setCurrencyField(templateInputs, f, value));
                        } else {
                            setCurrencyField(templateInputs, fieldName, value);
                        }
                    });
                });
            });

            // Sanitize all table inputs to ensure pdfme compatibility
            Object.entries(templateInputs).forEach(([key, value]) => {
                if (typeof key === 'string' && key.startsWith('Table ')) {
                    try {
                        let parsed;
                        if (typeof value === 'string') {
                            parsed = JSON.parse(value);
                        } else if (Array.isArray(value)) {
                            parsed = value;
                        } else {
                            parsed = [];
                        }

                        const columnCount = tableColumnCounts[key]
                            ?? (Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0].length : 8);

                        // Ensure we have at least one row with empty cells
                        if (!Array.isArray(parsed) || parsed.length === 0) {
                            const emptyRow = Array(columnCount).fill('');
                            emptyRow[1] = 'No services recorded for this period'; // Service column
                            parsed = [emptyRow];
                        }

                        const sanitized = parsed.map((row) => {
                            const baseRow = Array.isArray(row) ? row : [];
                            const padded = [...baseRow];
                            while (padded.length < columnCount) {
                                padded.push('');
                            }
                            if (columnCount > 0) {
                                padded.length = columnCount;
                            }
                            // Ensure every cell is a valid string
                            return padded.map((cell) => {
                                const normalized = normalizeTableCell(cell);
                                // Double-check: pdfme requires strings that can be split
                                return typeof normalized === 'string' ? normalized : '';
                            });
                        });
                        templateInputs[key] = JSON.stringify(sanitized);
                    } catch (e) {
                        // Fallback: create an empty row with default column count
                        const defaultColumnCount = tableColumnCounts[key] || 8;
                        const emptyRow = Array(defaultColumnCount).fill('');
                        emptyRow[1] = 'No data available';
                        templateInputs[key] = JSON.stringify([emptyRow]);
                    }
                }
            });

            applyTemplateTextDefaults(template, templateInputs);

            const pdfBytes = await generate({
                template,
                inputs: [templateInputs],
                plugins: { text, image, line, table, multiVariableText }
            });

            // Upload the PDF
            const participantSlug = participantName.replace(/[^a-zA-Z0-9]/g, '-');
            const monthYear = `${statementData.month || 'Month'}_${yearValue || 'Year'}`.replace(/\s+/g, '_');
            const filename = `output/${workspaceId}/${boardId}/monthly-statements/${participantSlug}_${monthYear}_Statement.pdf`;
            const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);

            if (uploadResult['$metadata'].httpStatusCode === 200) {
                const fileUrl = await getS3FileUrl(filename);

                info('Webhook-Service', 'Monthly statement PDF generated successfully', {
                    participant: participantName,
                    month: statementData.month,
                    year: statementData.year,
                    servicesCount: services.length,
                    budgetItemsCount: budgetItems.length,
                    fileUrl
                }, extractContextFromReq(req));

                return res.status(200).json({
                    message: 'Monthly statement PDF generated successfully',
                    fileUrl,
                    filename: `${participantSlug}_${monthYear}_Statement.pdf`
                });
            } else {
                throw new Error('Upload of PDF failed, please provide correct information.');
            }
        } catch (err) {
            const errorMessage = (err && err.message) ? err.message : 'Server error: An unknown error occurred. Please contact support via ISO+™ Portal.';
            error('Webhook-Service', 'Error generating monthly statement PDF', {
                message: errorMessage,
                stack: err.stack
            }, extractContextFromReq(req));
            return res.status(500).json({ message: errorMessage, error: err.message });
        }
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message, stack: err.stack }, extractContextFromReq(req));
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
        error('Webhook-Service', 'Error downloading file', { message: err.message }, extractContextFromReq(req));
        res.status(404).json({ message: 'File not found in ISO+™ Portal.' });
    }
});

export default router;
