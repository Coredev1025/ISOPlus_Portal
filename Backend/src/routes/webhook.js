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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

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
    const cleaned = stringValue.replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrencyValue(value) {
    return `$${formatValue(parseNumberValue(value))}`;
}

function formatDateToAU(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return new Intl.DateTimeFormat('en-AU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    }).format(date);
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
        fundAmount: 0,
        govSubsidyAmount: 0,
        participantContributionAmount: 0,
        fund: '',
        fundClassification: '',
        primarySupplementLabel: '',
        quarterLabel: '',
        months: new Set(),
        fundingStartDate: null,
        fundingEndDate: null
    };
}

function calculateBudgetAggregates(items = []) {
    const aggregates = {};

    items.forEach((item) => {
        const code = item?.categoryCode || 'HSQ';
        if (!aggregates[code]) {
            aggregates[code] = initializeBudgetAggregate();
        }
        const aggregate = aggregates[code];

        aggregate.availableFundStart += parseNumberValue(item.availableFundStart);
        aggregate.quarterlyAdjustment += parseNumberValue(item.quarterlyAdjustment);
        aggregate.primarySupplementAmount += parseNumberValue(item.primarySupplementAmount);
        aggregate.carryoverFunding += parseNumberValue(item.carryoverFunding);
        aggregate.unspentReturned += parseNumberValue(item.unspentReturned);
        aggregate.commonwealthUnspent += parseNumberValue(item.commonwealthUnspent);
        aggregate.providerUnspent += parseNumberValue(item.providerUnspent);
        aggregate.participantUnspent += parseNumberValue(item.participantUnspent);
        aggregate.previousMonthSpending += parseNumberValue(item.previousMonthSpending);
        aggregate.totalAvailableBudget += parseNumberValue(item.totalAvailableBudget);
        aggregate.deliveredAmount += parseNumberValue(item.deliveredAmount);
        aggregate.adjustmentAmount += parseNumberValue(item.adjustmentAmount);
        aggregate.remainingBalance += parseNumberValue(item.remainingBalance);
        aggregate.committedFunds += parseNumberValue(item.committedFunds);
        aggregate.fundAmount += parseNumberValue(item.fundAmount);
        aggregate.govSubsidyAmount += parseNumberValue(item.govSubsidyAmount);
        aggregate.participantContributionAmount += parseNumberValue(item.participantContributionAmount);

        if (!aggregate.primarySupplementLabel) {
            aggregate.primarySupplementLabel = item.fundClassification || item.fund || '';
        }
        if (!aggregate.fund) {
            aggregate.fund = item.fund || '';
        }
        if (!aggregate.quarterLabel && item.quarter) {
            aggregate.quarterLabel = item.quarter;
        }
        if (item.month && item.year && aggregate.months instanceof Set) {
            aggregate.months.add(`${item.month} ${item.year}`);
        }

        const startDate = item.fundingStartDate ? new Date(item.fundingStartDate) : null;
        if (startDate && !Number.isNaN(startDate.getTime())) {
            if (!aggregate.fundingStartDate || startDate < new Date(aggregate.fundingStartDate)) {
                aggregate.fundingStartDate = startDate.toISOString();
            }
        }
        const endDate = item.fundingEndDate ? new Date(item.fundingEndDate) : null;
        if (endDate && !Number.isNaN(endDate.getTime())) {
            if (!aggregate.fundingEndDate || endDate > new Date(aggregate.fundingEndDate)) {
                aggregate.fundingEndDate = endDate.toISOString();
            }
        }
    });

    return aggregates;
}

function getQuarterMetadata(monthNumber, year, fallbackQuarterLabel) {
    const monthIndex = Number(monthNumber) || 1;
    const effectiveYear = Number(year) || new Date().getFullYear();
    const monthNo = ((monthIndex - 1) % 3) + 1;
    const quarterNumber = Math.floor((monthIndex - 1) / 3) + 1;
    const firstDay = new Date(Date.UTC(effectiveYear, monthIndex - 1, 1));
    const lastDay = new Date(Date.UTC(effectiveYear, monthIndex, 0));

    return {
        monthNo,
        quarterLabel: fallbackQuarterLabel || `Q${quarterNumber}`,
        firstDay: formatDateToAU(firstDay),
        lastDay: formatDateToAU(lastDay)
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
    if (value === null || value === undefined) {
        return '';
    }
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeTableCell(entry)).join(', ');
    }
    if (typeof value === 'object' && value !== null) {
        const normalized = Object.values(value)
            .map((entry) => normalizeTableCell(entry))
            .filter((entry) => entry)
            .join(', ');
        return normalized || '';
    }
    return value.toString();
}

const SERVICE_TABLE_CONFIG = {
    HSQ: {
        delivered: {
            tableName: 'Table P6-1',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P6-1 ', '$P6-2', '$P6-3'],
            rowType: 'delivered'
        },
        adjustment: {
            tableName: 'Table P7-1',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P7-1', '$P7-2', '$P7-3'],
            rowType: 'adjustment'
        }
    },
    RCP: {
        delivered: {
            tableName: 'Table P8-1 ',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P8-1 ', '$P8-2', '$P8-3'],
            rowType: 'delivered'
        },
        adjustment: {
            tableName: 'Table P8-2',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P8-4', '$P8-5', '$P8-6'],
            rowType: 'adjustment'
        }
    },
    EOL: {
        delivered: {
            tableName: 'Table P9-1',
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
            tableName: 'Table P10-1 ',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P10-1 ', '$P10-3', '$P10-3 '],
            rowType: 'delivered'
        },
        committed: {
            tableName: 'Table P10-2',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P10-4', '$P10-5', '$P10-6'],
            rowType: 'committed'
        },
        adjustment: {
            tableName: 'Table P10-3',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P10-7', '$P10-8', '$P10-9'],
            rowType: 'adjustment'
        }
    },
    ATO: {
        delivered: {
            tableName: 'Table P11-1 ',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P11-1', '$P11-3 ', '$P11-3'],
            rowType: 'delivered'
        },
        committed: {
            tableName: 'Table P11-3 ',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P11-4', '$P11-5', '$P11-6'],
            rowType: 'committed'
        },
        adjustment: {
            tableName: 'Table P11-2',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P11-7 ', '$P11-8', '$P11-9 1'],
            rowType: 'adjustment'
        }
    },
    HMB: {
        delivered: {
            tableName: 'Table P12-1 ',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-1 ', '$P11-3  ', '$P12-3 '],
            rowType: 'delivered'
        },
        committed: {
            tableName: 'Table P12-3 ',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-4 ', '$P11-5 copy', '$P11-6 '],
            rowType: 'committed'
        },
        adjustment: {
            tableName: 'Table P11-2 copy',
            columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
            totals: ['$P12-7 ', '$P11-8 copy', '$P11-9 1 copy'],
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
    const deliveredByRaw = service.serviceProvider || service.deliveredBy;
    const deliveredBy = deliveredByRaw ? deliveredByRaw.toString().toLowerCase() : '';
    if (deliveredBy.includes('associated')) {
        return service.associatedProvider || service.loanedByOrganisationName || '';
    }
    if (deliveredBy.includes('company workforce')) {
        return business?.name || '';
    }
    return '';
}

function resolveServiceDateValue(service = {}, rowType = 'delivered') {
    if (rowType === 'committed') {
        return 'To be delivered';
    }
    const status = normalizeStatus(service.transactionStatus);
    if (status.includes('cancelled')) {
        return formatDateToAU(service.scheduledServiceDate || service.scheduledStart || service.scheduledShiftStart);
    }
    return formatDateToAU(
        service.serviceDeliveryDate ||
        service.actualEnd ||
        service.actualStart ||
        service.scheduledServiceDate ||
        service.scheduledStart
    );
}

function mapServiceColumnValue(service, column, rowType, business) {
    switch (column) {
        case 'date': {
            return resolveServiceDateValue(service, rowType);
        }
        case 'provider': {
            const provider = resolveServiceProviderName(service, business) || service.worker || business?.name || '';
            return truncateText(provider, 20);
        }
        case 'service': {
            const name = service.service || service.taskName || cleanRichText(service.notes) || 'Service';
            const providerName = resolveServiceProviderName(service, business);
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
            const unitPrice = rowType === 'committed'
                ? parseNumberValue(service.unitPrice || service.committedAtHmForDelivery)
                : parseNumberValue(service.unitPrice);
            return formatCurrencyValue(unitPrice);
        }
        case 'totalAmount': {
            const totalAmount = rowType === 'committed'
                ? parseNumberValue(service.committedAtHmForDelivery || service.totalAmount)
                : parseNumberValue(service.totalAmount);
            return formatCurrencyValue(totalAmount);
        }
        case 'govSubsidy': {
            const gov = rowType === 'committed' ? 0 : parseNumberValue(service.govSubsidy);
            return formatCurrencyValue(gov);
        }
        case 'participantContribution': {
            const participant = rowType === 'committed' ? 0 : parseNumberValue(service.participantContribution);
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

function buildServiceTableRows(services = [], config = {}, business) {
    const { columns = [], rowType = 'delivered' } = config;
    const totals = { amount: 0, gov: 0, participant: 0 };

    const rawRows = services.map((service) => {
        const totalAmount = rowType === 'committed'
            ? parseNumberValue(service.committedAtHmForDelivery || service.totalAmount)
            : parseNumberValue(service.totalAmount);
        const gov = rowType === 'committed' ? 0 : parseNumberValue(service.govSubsidy);
        const participant = rowType === 'committed' ? 0 : parseNumberValue(service.participantContribution);

        totals.amount += totalAmount;
        totals.gov += gov;
        totals.participant += participant;

        return columns.map((column) => mapServiceColumnValue(service, column, rowType, business));
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
        if (entry.type === 'currency') {
            setCurrencyField(templateInputs, entry.field, value);
        } else if (entry.type === 'multi') {
            setMultiValueField(templateInputs, entry.field, value);
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
            const templatePath = path.join(__dirname, '..', 'assets', 'participantTaxInvoiceAG.json');
            const templateData = await fs.readFile(templatePath, 'utf8');
            const template = JSON.parse(templateData);

            const logoBase64 = await getLogoData(business);

            const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;

            let ordersArr = [];
            let totalParticipantContribution = 0;
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
            const dateFmt = (d) => d ? new Date(d).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            const toNumber = (v) => typeof v === 'number' ? v : Number(v || 0);
            const fmt = (v) => formatValue(toNumber(v));

            // Fetch participant profile details from first item (following items.js pattern)
            let participantName = ' ';
            let participantAddress = ' ';
            let participantSuburb = ' ';
            let participantState = ' ';
            let participantPostcode = ' ';

            if (dbItems.length > 0) {
                const firstItem = dbItems[0];
                const getValue = (attributeName) => {
                    return firstItem.data.values.find(v => v.attribute.name === attributeName)?.data;
                };

                // Get Participant Profile reference
                const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
                if (participantProfileValue) {
                    try {
                        const participantProfileId = Array.isArray(participantProfileValue) 
                            ? participantProfileValue[0] 
                            : (typeof participantProfileValue === 'object' ? participantProfileValue.id : participantProfileValue);
                        
                        if (participantProfileId) {
                            const participantProfile = await getItemValues(workspaceId, boardId, participantProfileId.toString());
                            if (participantProfile && participantProfile.values) {
                                const getProfileValue = (attributeName) => {
                                    const entry = participantProfile.values.find(v => v.attribute.name === attributeName);
                                    if (!entry || entry.data === null || entry.data === undefined) {
                                        return '';
                                    }
                                    if (Array.isArray(entry.data) && entry.data.length > 0) {
                                        return typeof entry.data[0] === 'object' && entry.data[0].name 
                                            ? entry.data[0].name 
                                            : String(entry.data[0]);
                                    }
                                    return typeof entry.data === 'object' && entry.data.name 
                                        ? entry.data.name 
                                        : String(entry.data);
                                };

                                // Get Preferred Name first, then fallback to Full Name
                                const preferredName = getProfileValue('Preferred Name') || '';
                                const fullName = getProfileValue(ATTRIBUTE_NAMES.FULL_NAME) || '';
                                participantName = preferredName || fullName || ' ';
                                participantAddress = getProfileValue(ATTRIBUTE_NAMES.ADDRESS) || ' ';
                                participantSuburb = getProfileValue(ATTRIBUTE_NAMES.SUBURB) || ' ';
                                participantState = getProfileValue(ATTRIBUTE_NAMES.STATE) || ' ';
                                participantPostcode = getProfileValue(ATTRIBUTE_NAMES.POSTCODE) || getProfileValue(ATTRIBUTE_NAMES.POST_CODE) || ' ';
                            }
                        }
                    } catch (err) {
                        warn('Webhook-Service', 'Failed to fetch participant profile details', { 
                            error: err.message,
                            itemId: firstItem.itemId 
                        }, extractContextFromReq(req));
                    }
                }
            }

            // Process all items and add them to the orders array (following items.js pattern)
            for (const dbItem of dbItems) {
                const getValue = (attributeName) => {
                    return dbItem.data.values.find(v => v.attribute.name === attributeName)?.data;
                };

                // Get Transaction Status and format it (following items.js pattern)
                const transactionStatusValue = dbItem.data.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.TRANSACTION_STATUS);
                let transactionStatus = '';
                if (transactionStatusValue) {
                    const transactionStatusData = transactionStatusValue.data;
                    const labels = transactionStatusValue.attribute?.settings?.labels || [];
                    
                    if (Array.isArray(transactionStatusData) && transactionStatusData.length > 0) {
                        transactionStatus = transactionStatusData.map(id => {
                            const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
                            return label ? label.name : (typeof id === 'object' ? id.name : String(id));
                        }).join(', ');
                    } else if (transactionStatusData) {
                        if (typeof transactionStatusData === 'object' && transactionStatusData.id) {
                            const label = labels.find(l => l.id === transactionStatusData.id);
                            transactionStatus = label ? label.name : (transactionStatusData.name || String(transactionStatusData.id));
                        } else if (typeof transactionStatusData === 'string') {
                            const label = labels.find(l => l.id === transactionStatusData);
                            transactionStatus = label ? label.name : transactionStatusData;
                        } else {
                            transactionStatus = String(transactionStatusData);
                        }
                    }
                }

                // Date: If Transaction Status is "Delivered - To be claimed and invoiced.", use Actual Shift End Date & Time, otherwise Scheduled Shift Start Date & Time
                let rowDate = '';
                const isDelivered = transactionStatus && transactionStatus === 'Delivered - To be claimed and invoiced.';
                
                if (isDelivered) {
                    const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END);
                    if (actualEnd) {
                        rowDate = dateFmt(actualEnd);
                    }
                }
                
                if (!rowDate) {
                    const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START);
                    if (scheduledStart) {
                        rowDate = dateFmt(scheduledStart);
                    }
                }

                // Description: Second section after "-" of Service Plan ID (following items.js pattern)
                let description = '';
                const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
                if (servicePlanId) {
                    try {
                        const servicePlan = await getItemValues(workspaceId, boardId, servicePlanId.toString());
                        if (servicePlan && servicePlan.values) {
                            const servicePlanIdValue = servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_PLAN_ID)?.data?.toString().trim();
                            if (servicePlanIdValue && typeof servicePlanIdValue === 'string' && servicePlanIdValue.includes(' - ')) {
                                const parts = servicePlanIdValue.split(' - ');
                                description = parts[1].trim();
                            } else if (servicePlanIdValue && typeof servicePlanIdValue === 'string') {
                                description = servicePlanIdValue;
                            }
                        }
                    } catch (err) {
                        warn('Webhook-Service', 'Failed to fetch service plan', {
                            error: err.message,
                            itemId: dbItem.itemId
                        }, extractContextFromReq(req));
                    }
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

                // Get other fields (following items.js pattern)
                const unit = getValue(ATTRIBUTE_NAMES.UNIT) || ' ';
                const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;
                const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
                const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
                const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;

                ordersArr.push([
                    rowDate,
                    description,
                    unit,
                    fmt(quantity),
                    formatCurrencyValue(unitPrice), // $ {Unit Price ($)}
                    gstLabel,
                    formatCurrencyValue(totalAmount), // $ {Total Amount ($)}
                    formatCurrencyValue(participantContribution) // {Participant Contribution ($)}
                ]);
                
                // Subtotal uses Participant Contribution, not Total Amount
                totalParticipantContribution += participantContribution;
            }

            if (ordersArr.length === 0) {
                await Promise.all(dbItems.map(item =>
                    setIntegrationMessage(workspaceId, boardId, item.itemId, "There is nothing to invoice!")
                ));
                return res.status(400).json({ message: "There is nothing to invoice!" });
            }

            const orders = JSON.stringify(ordersArr);
            // Subtotal: Same as NDIS, but for Participant Contribution column
            const participantContributionTotal = formatValue(totalParticipantContribution);
            const gstTotal = formatValue(0); // Total GST: $ 0.00
            // Total AUD: Same as subtotal (participant contribution total)
            const totalAUD = participantContributionTotal;

            // Map client details to match template
            const clientDetails = {
                Participant: participantName,
                Address: participantAddress,
                Suburb: participantSuburb,
                State: participantState,
                Postcode: participantPostcode
            };

            // Generate the PDF with all items
            const pdfBytes = await generate({
                template: template,
                inputs: [
                    {
                        logo: logoBase64,
                        subtotal: formatCurrencyValue(totalParticipantContribution), // Subtotal: Participant Contribution total
                        totalGST: formatCurrencyValue(0), // Total GST: $ 0.00
                        total: formatCurrencyValue(totalParticipantContribution), // Total AUD: Same as subtotal
                        clientDetails: JSON.stringify(clientDetails),
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
                }));

                // Increment invoice number only once
                business.documentNumbering.invoice.nextNumber += 1;
                await business.save();

                logAuditTrail({
                    workspaceId,
                    action: "Generate PDF Participant Tax Invoice",
                    detail: `Invoice generated successfully, invoice number: ${invoiceNumber}, participant: ${participantName}, items: ${dbItems.length}, fileUrl: ${fileUrl}`,
                    req
                });

                return res.status(200).json({ 
                    message: "Participant Tax Invoice generated successfully",
                    invoiceNumber: invoiceNumber,
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
        const { statementData, businessDetails } = req.body;

        if (!statementData) {
            return res.status(400).json({ message: "No statement data provided." });
        }

        const business = await getValidatedBusiness(workspaceId);

        try {
            // Use the monthlyStatement.json template
            const templatePath = path.join(__dirname, '..', 'assets', 'monthlyStatement.json');
            const templateData = await fs.readFile(templatePath, 'utf8');
            const template = JSON.parse(templateData);

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

            const services = Array.isArray(statementData.serviceItems) && statementData.serviceItems.length
                ? statementData.serviceItems
                : Array.isArray(statementData.services)
                    ? statementData.services
                    : [];

            const budgetItems = Array.isArray(statementData.budgetItems) ? statementData.budgetItems : [];
            const budgetAggregates = calculateBudgetAggregates(budgetItems);

            const monthNumber = statementData.monthNumber || '1';
            const yearValue = statementData.year || new Date().getFullYear().toString();
            const firstAggregate = Object.values(budgetAggregates)[0] || {};
            const quarterLabel = statementData.summary?.quarter || firstAggregate.quarterLabel || '';
            const quarterMeta = getQuarterMetadata(monthNumber, yearValue, quarterLabel);

            const subtitlePayload = {
                'Month No.': quarterMeta.monthNo.toString(),
                'Quarter No': quarterMeta.quarterLabel,
                'First Day': quarterMeta.firstDay,
                'Last Day': quarterMeta.lastDay
            };

            const templateInputs = {};
            templateInputs.logo = logoBase64;

            setMultiValueField(templateInputs, 'companyName', { 'Company Name': safeBusinessDetails.companyName });

            const participantName = statementData.participant || statementData.participantProfile || 'Participant';
            const participantAddress = statementData.participantAddress || safeBusinessDetails.address || '';
            const participantSuburb = statementData.participantSuburb || safeBusinessDetails.suburb || '';
            const participantState = statementData.participantState || safeBusinessDetails.state || '';
            const participantPostcode = statementData.participantPostcode || safeBusinessDetails.postcode || '';

            setMultiValueField(templateInputs, 'Organisation', {
                'Participant': participantName,
                'My Aged Care ID Number': statementData.myAgedCareIdNumber || '',
                'Provider ID': statementData.providerId || '',
                'Address': participantAddress,
                'Suburb': participantSuburb,
                'Post Code': participantPostcode,
                'State': participantState
            });

            setMultiValueField(templateInputs, 'Recipient', {
                'Participant': participantName,
                'Address': participantAddress,
                'Suburb': participantSuburb,
                'Post Code': participantPostcode
            });

            setMultiValueField(templateInputs, 'Text title', {
                month: statementData.month || '',
                year: yearValue
            });

            ['P2 Subtitle', 'P3 Subtitle', 'P4 Subtitle', 'P5 Subtitle'].forEach((field) => {
                setMultiValueField(templateInputs, field, subtitlePayload);
            });

            const phoneLine = safeBusinessDetails.companyRegistrationId
                ? `${safeBusinessDetails.phoneNumber || ''}${safeBusinessDetails.phoneNumber ? ' | ' : ''}Reg ID: ${safeBusinessDetails.companyRegistrationId}`
                : (safeBusinessDetails.phoneNumber || '');

            setMultiValueField(templateInputs, 'Disclaimer 2a', {
                'Phone Number': phoneLine.trim(),
                'Business Email': safeBusinessDetails.businessEmail || ''
            });

            const homeSupportAggregate = budgetAggregates.HSQ ? { ...budgetAggregates.HSQ } : initializeBudgetAggregate();
            homeSupportAggregate.primarySupplementLabel = homeSupportAggregate.primarySupplementLabel || homeSupportAggregate.fund || homeSupportAggregate.fundClassification || '';

            applyBudgetMapping(templateInputs, homeSupportAggregate, [
                { type: 'multi', field: 'P2-3', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P2-1', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P2-2', value: (agg) => agg.quarterlyAdjustment },
                { type: 'currency', field: '$P2-3', value: (agg) => agg.primarySupplementAmount },
                { type: 'currency', field: '$P2-4', value: (agg) => agg.carryoverFunding + agg.unspentReturned },
                { type: 'currency', field: '$P2-6', value: (agg) => agg.commonwealthUnspent },
                { type: 'currency', field: '$P2-7', value: (agg) => agg.providerUnspent },
                { type: 'currency', field: '$P2-8', value: (agg) => agg.participantUnspent },
                { type: 'currency', field: '$P2-9', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P2-10', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P2-11', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P2-12', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P2-13', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P2-14', value: (agg) => agg.remainingBalance },
                { type: 'currency', field: '$P7-4', value: (agg) => agg.carryoverFunding },
                { type: 'currency', field: '$P7-5', value: (agg) => agg.unspentReturned },
                { type: 'currency', field: '$P7-6', value: (agg) => agg.carryoverFunding + agg.unspentReturned }
            ]);

            const restorativeAggregate = budgetAggregates.RCP ? { ...budgetAggregates.RCP } : initializeBudgetAggregate();
            restorativeAggregate.primarySupplementLabel = restorativeAggregate.primarySupplementLabel || restorativeAggregate.fund || restorativeAggregate.fundClassification || '';

            applyBudgetMapping(templateInputs, restorativeAggregate, [
                { type: 'multi', field: 'P3-2', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P3-1', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P3-2', value: (agg) => agg.primarySupplementAmount },
                { type: 'currency', field: '$P3-3', value: (agg) => agg.commonwealthUnspent },
                { type: 'currency', field: '$P3-4', value: (agg) => agg.providerUnspent },
                { type: 'currency', field: '$P3-5', value: (agg) => agg.participantUnspent },
                { type: 'currency', field: '$P3-6', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P3-7', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P3-8', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P3-9', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P3-10', value: (agg) => agg.remainingBalance },
                { type: 'multi', field: 'P3 Footer 1', value: (agg) => ({ 'Funding End Date': formatDateToAU(agg.fundingEndDate) || 'N/A' }) }
            ]);

            const endOfLifeAggregate = budgetAggregates.EOL ? { ...budgetAggregates.EOL } : initializeBudgetAggregate();
            endOfLifeAggregate.primarySupplementLabel = endOfLifeAggregate.primarySupplementLabel || endOfLifeAggregate.fund || endOfLifeAggregate.fundClassification || '';

            applyBudgetMapping(templateInputs, endOfLifeAggregate, [
                { type: 'multi', field: 'P3-12', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P3-11', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P3-12', value: (agg) => agg.primarySupplementAmount },
                { type: 'currency', field: '$P3-13', value: (agg) => agg.commonwealthUnspent },
                { type: 'currency', field: '$P3-14', value: (agg) => agg.providerUnspent },
                { type: 'currency', field: '$P3-15', value: (agg) => agg.participantUnspent },
                { type: 'currency', field: '$P3-16', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P3-17', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P3-18', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P3-19', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P3-20', value: (agg) => agg.remainingBalance },
                { type: 'multi', field: 'P3 Footer 2', value: (agg) => ({ 'Funding End Date': formatDateToAU(agg.fundingEndDate) || 'N/A' }) }
            ]);

            const assistiveShortAggregate = budgetAggregates.ATS ? { ...budgetAggregates.ATS } : initializeBudgetAggregate();
            assistiveShortAggregate.primarySupplementLabel = assistiveShortAggregate.primarySupplementLabel || assistiveShortAggregate.fund || assistiveShortAggregate.fundClassification || '';

            applyBudgetMapping(templateInputs, assistiveShortAggregate, [
                { type: 'multi', field: 'P4-2', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P4-1 ', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P4-3', value: (agg) => agg.fundAmount },
                { type: 'currency', field: '$P4-4', value: (agg) => agg.commonwealthUnspent },
                { type: 'currency', field: '$P4-5', value: (agg) => agg.providerUnspent },
                { type: 'currency', field: '$P4-6', value: (agg) => agg.participantUnspent },
                { type: 'currency', field: '$P4-7', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P4-8', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P4-9', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P4-10', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P4-11', value: (agg) => agg.remainingBalance },
                { type: 'currency', field: '$P4-12', value: (agg) => agg.committedFunds },
                { type: 'currency', field: '$P4-13', value: (agg) => agg.remainingBalance },
                { type: 'multi', field: 'P4 Footer 2', value: (agg) => ({ 'Funding End Date': formatDateToAU(agg.fundingEndDate) || 'N/A' }) }
            ]);

            const assistiveOngoingAggregate = budgetAggregates.ATO ? { ...budgetAggregates.ATO } : initializeBudgetAggregate();
            assistiveOngoingAggregate.primarySupplementLabel = assistiveOngoingAggregate.primarySupplementLabel || assistiveOngoingAggregate.fund || assistiveOngoingAggregate.fundClassification || '';

            applyBudgetMapping(templateInputs, assistiveOngoingAggregate, [
                { type: 'multi', field: 'P4-15', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P4-14', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P4-15', value: (agg) => agg.primarySupplementAmount },
                { type: 'currency', field: '$P4-16', value: (agg) => agg.commonwealthUnspent },
                { type: 'currency', field: '$P4-17', value: (agg) => agg.providerUnspent },
                { type: 'currency', field: '$P4-18', value: (agg) => agg.participantUnspent },
                { type: 'currency', field: '$P4-19', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P4-20', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P4-21', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P4-22', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P4-23', value: (agg) => agg.remainingBalance },
                { type: 'currency', field: '$P4-24', value: (agg) => agg.committedFunds },
                { type: 'currency', field: '$P4-25', value: (agg) => agg.remainingBalance },
                { type: 'multi', field: 'P4 Footer 1', value: (agg) => ({ 'Funding End Date': formatDateToAU(agg.fundingEndDate) || 'N/A' }) }
            ]);

            const homeModificationAggregate = budgetAggregates.HMB ? { ...budgetAggregates.HMB } : initializeBudgetAggregate();
            homeModificationAggregate.primarySupplementLabel = homeModificationAggregate.primarySupplementLabel || homeModificationAggregate.fund || homeModificationAggregate.fundClassification || '';

            applyBudgetMapping(templateInputs, homeModificationAggregate, [
                { type: 'multi', field: 'P5-', value: (agg) => ({ 'Primary Supplement': agg.primarySupplementLabel || 'N/A' }) },
                { type: 'currency', field: '$P5-1', value: (agg) => agg.availableFundStart },
                { type: 'currency', field: '$P5-2', value: (agg) => agg.primarySupplementAmount },
                { type: 'currency', field: '$P5-3', value: (agg) => agg.commonwealthUnspent },
                { type: 'currency', field: '$P5-4', value: (agg) => agg.providerUnspent },
                { type: 'currency', field: '$P5-5', value: (agg) => agg.participantUnspent },
                { type: 'currency', field: '$P5-6', value: (agg) => agg.previousMonthSpending },
                { type: 'currency', field: '$P5-7', value: (agg) => agg.totalAvailableBudget },
                { type: 'currency', field: '$P5-8', value: (agg) => agg.deliveredAmount },
                { type: 'currency', field: '$P5-9', value: (agg) => agg.adjustmentAmount },
                { type: 'currency', field: '$P5-10', value: (agg) => agg.remainingBalance },
                { type: 'currency', field: '$P5-11', value: (agg) => agg.committedFunds },
                { type: 'currency', field: '$P5-12', value: (agg) => agg.remainingBalance },
                { type: 'multi', field: 'P4 Footer 2 copy', value: (agg) => ({ 'Funding End Date': formatDateToAU(agg.fundingEndDate) || 'N/A' }) }
            ]);

            const serviceBuckets = createServiceBuckets();
            services.forEach((service) => {
                const code = determineFundingCode(service);
                const bucket = serviceBuckets[code];
                if (!bucket) {
                    return;
                }

                const status = (service.transactionStatus || '').toString().toLowerCase();
                const committedAmount = parseNumberValue(service.committedAtHmForDelivery);
                const hasCommittedBucket = committedAmount > 0 && Array.isArray(bucket.committed);
                const isAdjustment = status.includes('adjustment') && Array.isArray(bucket.adjustment);
                const isDelivered = (status.includes('delivered') || status.includes('cancelled')) && Array.isArray(bucket.delivered);
                const canRecordDelivery = Array.isArray(bucket.delivered);

                if (isAdjustment) {
                    bucket.adjustment.push(service);
                    return;
                }

                if (isDelivered) {
                    bucket.delivered.push(service);
                    return;
                }

                if (hasCommittedBucket && Array.isArray(bucket.committed)) {
                    bucket.committed.push(service);
                    return;
                }

                if (!status && canRecordDelivery) {
                    bucket.delivered.push(service);
                }
            });

            const tableColumnCounts = {};

            Object.entries(SERVICE_TABLE_CONFIG).forEach(([code, tableConfig]) => {
                const bucket = serviceBuckets[code];
                if (!bucket) return;

                Object.values(tableConfig).forEach((config) => {
                    const sourceServices = bucket[config.rowType] || [];
                    const tableData = buildServiceTableRows(sourceServices, config, business);
                    templateInputs[config.tableName] = JSON.stringify(tableData.rows);
                    tableColumnCounts[config.tableName] = config.columns.length;

                    const totalValues = [tableData.totals.amount, tableData.totals.gov, tableData.totals.participant];
                    config.totals.forEach((fieldName, index) => {
                        const value = totalValues[Math.min(index, totalValues.length - 1)] || 0;
                        setCurrencyField(templateInputs, fieldName, value);
                    });
                });
            });

            Object.entries(templateInputs).forEach(([key, value]) => {
                if (typeof key === 'string' && key.startsWith('Table ') && typeof value === 'string') {
                    try {
                        const parsed = JSON.parse(value);
                        const columnCount = tableColumnCounts[key]
                            ?? (Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0].length : 0);
                        const sanitized = Array.isArray(parsed)
                            ? parsed.map((row) => {
                                const baseRow = Array.isArray(row) ? row : [];
                                const padded = [...baseRow];
                                while (padded.length < columnCount) {
                                    padded.push('');
                                }
                                if (columnCount > 0) {
                                    padded.length = columnCount;
                                }
                                return padded.map((cell) => normalizeTableCell(cell));
                            })
                            : [];
                        templateInputs[key] = JSON.stringify(sanitized);
                    } catch (e) {
                        templateInputs[key] = JSON.stringify([]);
                    }
                }
            });

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
