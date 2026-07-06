import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Item from '../models/Item.js';
import Business from '../models/Business.js';
import InvoiceNumber from '../models/InvoiceNumber.js';
import { info, error, warn } from '../utils/logger.js';
import { getFolder } from '../services/isoplus.js';
import { batchProcess } from '../utils/helpers.js';
import { getCachedTransform, setCachedTransform, getCacheStats, invalidateCacheForItem, getCachedMSBudget, setCachedMSBudget, getCachedMSService, setCachedMSService, invalidateMSCacheForItem } from '../utils/transformCache.js';
import {
    buildNdisMasterPlanServiceRows,
    buildNdisSupportCatalogueForServicePlan,
    collectNdisSupportCatalogueRefIds,
    formatLabelValue as formatNdisLabelValue,
    NDIS_MASTERPLAN_ATTR,
    NDIS_SERVICEPLAN_ATTR,
    extractRefId as extractNdisRefId,
    extractAllRefIds as extractNdisAllRefIds,
    parseNumberValue as parseNdisNumber,
    getValueMulti as getNdisValueMulti,
    getParticipantDisplayName as getNdisParticipantDisplayName,
} from '../utils/ndisServiceRecords.js';
import { resolveNdisPricingRuleForServicePlan } from '../utils/ndisPricingRules.js';
import {
    buildMasterItemsMap,
    enrichNdisInvoiceGeneratorRows,
} from '../utils/ndisInvoiceGeneratorOutput.js';
import {
    resolveInvoiceIssuedValue,
    applyInvoiceStatusUpdates,
} from '../utils/itemsRouteHelpers.js';
import { getNdisInvoiceGeneratorData } from '../utils/ndisInvoiceGeneratorRouteHelpers.js';
import { getInvoiceGeneratorData } from '../utils/invoiceGeneratorRouteHelpers.js';
import { getMonthlyStatementData } from '../utils/monthlyStatementRouteHelpers.js';
import {
    lookupServiceIdFromRefs,
    normalizeServiceIdString,
} from '../utils/exportOptimizedServicePlanHelpers.js';

const router = express.Router();

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
    STATE: 'State',
    MY_AGED_CARE_ID: 'My Aged Care ID Number',
    MY_AGED_CARE_ID_ALT: 'My Aged Care ID',
    PROVIDER_ID: 'Provider ID',
    COMMITTED_AT_HM: 'Committed AT-HM for Delivery',
    FUNDING_STREAM: 'Funding Stream',
    YEAR_LABEL: 'Year',
    FY_QUARTER: 'FY Quarter',
    QUARTERLY_BUDGET: 'Quarterly Budget ($)',
    AVAILABLE_FUND_START: 'Available Fund at the Start of the Month ($)',
    QUARTERLY_ADJUSTMENT: 'Classification Quarterly Budget Adjustment ($)',
    PRIMARY_SUPPLEMENT_AMOUNT: 'Primary Supplement ($)',
    CARRYOVER_FUNDING: 'Carryover Funding from the Previous Quarter ($)',
    UNSPENT_BUDGET_RETURNED: 'Unspent Budget at the End of the Quarter – Returned ($-)',
    COMMONWEALTH_UNSPENT_FUNDS: [
        'Unspent HCP Funds - Commonwealth Portion (Provider-held) ($)',
        'Commonwealth-held HCP Unspent Funds ($)'
    ],
    PROVIDER_UNSPENT_FUNDS: [
        'Commonwealth-held HCP Unspent Funds (Notional Home Care Account) ($)',
        'Provider-held HCP Unspent Funds ($)'
    ],
    PARTICIPANT_UNSPENT_FUNDS: [
        'Unspent HCP Funds - Participant Portion (Provider-held) ($)',
        'Participant Portion HCP Unspent Funds ($)'
    ],
    PREVIOUS_MONTH_SPENDING: 'Spending from Previous Month(s) within same Quarter ($)',
    PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD: 'Spending from Previous Month(s) within Allocated Period ($)',
    MONTH_LABEL: 'Month',
    FUNDING_START_DATE: 'Funding Start Date',
    FUNDING_END_DATE: 'Funding End Date',
    FUND_CLASSIFICATION: 'Fund Classification',
    FUND_AMOUNT: 'Fund Amount ($)',
    ADDITIONAL_AMOUNT_APPROVED_AT: 'Additional amount approved (AT high tier) ($)',
    TOTAL_AVAILABLE_HOME_SUPPORT: 'Total Available Budget for Home Support ($)',
    FUND_TEXT: 'Fund',
    HOME_SUPPORT_DELIVERED: 'Home Support Delivered During the Month ($-)',
    AT_SHORT_TERM_DELIVERED: [
        'AT - Short-term Delivered During the Month ($-)',
        'Assistive Technology - Short-term Delivered During the Month ($-)',
        'Assistive Technology - Short-term Delivered During the Month'
    ],
    AT_ONGOING_DELIVERED: [
        'AT - Ongoing Delivered During the Month ($-)',
        'Assistive Technology - Ongoing Delivered During the Month ($-)',
        'Assistive Technology - Ongoing Delivered During the Month'
    ],
    HOME_MODIFICATION_DELIVERED: [
        'Home Modification Delivered During the Month ($-)',
        'Home Modification Delivered During the Month'
    ],
    RESTORATIVE_CARE_DELIVERED: 'Restorative Care Delivered During the Month ($-)',
    END_OF_LIFE_DELIVERED: 'End-of-Life Care Delivered During the Month ($-)',
    HOME_SUPPORT_ADJUSTMENTS: 'Adjustments from Previous Months [Charges($-)/Refund($)]',
    REMAINING_HOME_SUPPORT_BALANCE: 'Remaining Home Support Balance as at the End of the Month ($)',
    COMMITTED_AT_SHORT_TERM: 'Committed AT Short-term Funds - to be delivered ($-)',
    COMMITTED_AT_ONGOING: 'Committed AT Ongoing Funds - to be delivered ($-)',
    COMMITTED_HOME_MODIFICATION: 'Committed HM Funds - to be delivered ($-)',
    ITEM_OR_WRAPAROUND: 'Item or Wraparound',
    ITEM_DESCRIPTION_CODE: 'Item Description Code',
    ITEM_DESCRIPTION: 'Item Description',
    WRAPAROUND_DESCRIPTION_CODE: 'Wraparound Description Code',
    DELIVERED_BY_THIRD_PARTY: 'Delivered By Third Party',
    LOANED_BY_ORGANISATION_NAME: 'Loaned by Organisation Name',
    PAYMENT_STATUS: 'Payment Status',
    INVOICE_NUMBER: 'Generated Invoice Number',
    ALLOCATED_TIME: 'Allocated time (Hr.)'
};

const FUNDING_SOURCE_TYPES = {
    HOME_SUPPORT: 'Home Support Quarterly Budget',
    RESTORATIVE_CARE: 'Restorative Care Pathway Budget',
    END_OF_LIFE: 'End-of-Life Pathway Budget',
    ASSISTIVE_TECH_SHORT: 'Assistive Technology - Short-term Budget',
    ASSISTIVE_TECH_ONGOING: 'Assistive Technology - Ongoing Budget',
    HOME_MODIFICATION: 'Home Modification Budget'
};

const BUDGET_CATEGORY_CONFIG = [
    { code: 'HSQ', folderName: FUNDING_SOURCE_TYPES.HOME_SUPPORT, profileKey: 'homeSupport' },
    { code: 'HSCM', folderName: 'Home Support Care Management Budget', profileKey: 'careManagement' },
    { code: 'ATS', folderName: FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_SHORT, profileKey: 'assistiveTechShortTerm' },
    { code: 'ATO', folderName: FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_ONGOING, profileKey: 'assistiveTechOngoing' },
    { code: 'HMB', folderName: FUNDING_SOURCE_TYPES.HOME_MODIFICATION, profileKey: 'homeModification' },
    { code: 'RCP', folderName: FUNDING_SOURCE_TYPES.RESTORATIVE_CARE, profileKey: 'restorativeCare' },
    { code: 'EOL', folderName: FUNDING_SOURCE_TYPES.END_OF_LIFE, profileKey: 'endOfLife' }
];

const BUDGET_CATEGORY_ORDER = BUDGET_CATEGORY_CONFIG.map(config => config.code);

const DELIVERED_BY_TYPES = {
    COMPANY_WORKFORCE: 'company workforce',
    ASSOCIATED_PROVIDERS: 'associated providers'
};

// Transaction status that uses Actual Shift End Date & Time for month filtering; others use Scheduled Shift Start
const TRANSACTION_STATUS_USE_ACTUAL_END = 'Delivered - To be claimed and invoiced.';

// Attribute names for referenced item types (Participant Profiles, Service Plans, Funding Sources)
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
    TOTAL_FUND_RESTORATIVE: 'Total Available Fund for Restorative Care ($)',
    REMAINING_RESTORATIVE: 'Remaining Balance for Allocation Period ($)',
    REMAINING_RESTORATIVE_END_OF_MONTH: 'Remaining Restorative Care Balance as at the End of the Month ($)',
    TOTAL_BUDGET_END_OF_LIFE: 'Total Available Budget for End-of-Life Care ($)',
    TOTAL_FUND_END_OF_LIFE: 'Total Available Fund for End-of-Life Care ($)',
    REMAINING_END_OF_LIFE_END_OF_MONTH: 'Remaining End-of-Life Care Balance as at the End of the Month ($)',
    TOTAL_BUDGET_AT_SHORT_TERM: 'Total Available Budget for Assistive Technology - Short-term ($)',
    TOTAL_FUND_AT_SHORT_TERM: 'Total Available Fund for AT - Short-term ($)',
    REMAINING_AT_SHORT_TERM_END_OF_MONTH: 'Remaining AT - Short-term Balance as at the End of the Month ($)',
    REMAINING_AT_SHORT_TERM: 'Remaining AT - Short-term Balance for Allocation Period ($)',
    COMMITTED_AT_SHORT_TERM: 'Committed AT Short-term Funds - to be delivered ($-)',
    TOTAL_BUDGET_AT_ONGOING: 'Total Available Budget for Assistive Technology - Ongoing ($)',
    TOTAL_FUND_AT_ONGOING: 'Total Available Fund for AT Ongoing ($)',
    REMAINING_AT_ONGOING_END_OF_MONTH: 'Remaining AT - Ongoing Balance as at the End of the Month ($)',
    REMAINING_AT_ONGOING: 'Remaining AT - Ongoing Balance for Allocation Period ($)',
    COMMITTED_AT_ONGOING: 'Committed AT Ongoing Funds - to be delivered ($-)',
    TOTAL_BUDGET_HOME_MOD: 'Total Available Budget for Home Modification ($)',
    TOTAL_FUND_HM: 'Total Available Fund for HM ($)',
    REMAINING_HM_END_OF_MONTH: 'Remaining HM Balance as at the End of the Month ($)',
    REMAINING_HOME_MOD: 'Remaining HM Balance for Allocation Period ($)',
    COMMITTED_HOME_MOD: 'Committed HM Funds - to be delivered ($-)',
    FUNDING_END_DATE: 'Funding End Date',

    // Funding Source attributes
    FS_NAME: 'Funding Stream',
    FS_DEFINITION: 'Definition'
};

const bulkFetchReferenceItemsFromDB = async (workspaceId, boardId, itemIds) => {
    if (!itemIds || itemIds.length === 0) return new Map();

    const uniqueIds = [...new Set(itemIds.filter(Boolean).map(id => {
        if (typeof id === 'object' && id.id) return id.id.toString();
        if (typeof id === 'object' && id) return id.toString();
        return id?.toString();
    }).filter(Boolean))];

    if (uniqueIds.length === 0) return new Map();

    let items = await Item.find({
        workspaceId,
        boardId,
        itemId: { $in: uniqueIds }
    }).lean();

    const itemMap = new Map();
    for (const item of items) {
        itemMap.set(item.itemId, item);
    }

    const sameBoardCount = items.length;

    const foundIds = new Set(items.map(i => i.itemId));
    const missingIds = uniqueIds.filter(id => !foundIds.has(id));

    let crossBoardCount = 0;
    if (missingIds.length > 0) {
        const crossBoardItems = await Item.find({
            workspaceId,
            itemId: { $in: missingIds }
        }).lean();

        for (const item of crossBoardItems) {
            if (!itemMap.has(item.itemId)) {
                itemMap.set(item.itemId, item);
                crossBoardCount++;
            }
        }

        const stillMissingIds = missingIds.filter(id => !itemMap.has(id));
        if (stillMissingIds.length > 0 && stillMissingIds.length <= 5) {
            warn('Items-Service', 'Reference items not found in database', {
                missingCount: stillMissingIds.length,
                missingIds: stillMissingIds.slice(0, 5)
            });
        } else if (stillMissingIds.length > 5) {
            warn('Items-Service', 'Reference items not found in database', {
                missingCount: stillMissingIds.length,
                sampleMissingIds: stillMissingIds.slice(0, 3)
            });
        }
    }

    info('Items-Service', 'Bulk fetch reference items completed', {
        requested: uniqueIds.length,
        foundInSameBoard: sameBoardCount,
        foundInOtherBoards: crossBoardCount,
        totalFound: itemMap.size
    });

    return itemMap;
};

const extractRefId = (value) => {
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
};

const extractAllRefIds = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map(v => {
            if (typeof v === 'object' && v.id) return v.id.toString();
            if (typeof v === 'string') return v;
            return v?.toString();
        }).filter(Boolean);
    }
    if (typeof value === 'object' && value.id) return [value.id.toString()];
    if (typeof value === 'string') return [value];
    return value ? [value.toString()] : [];
};

const getValueFromFlatData = (item, attributeName) => {
    if (!item?.data) return null;

    const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];

    for (const attrName of attributeNames) {
        if (item.data[attrName] !== undefined && item.data[attrName] !== null) {
            return item.data[attrName];
        }
    }

    if (Array.isArray(item.data.values)) {
        for (const attrName of attributeNames) {
            const entry = item.data.values.find(v => v.attribute?.name === attrName);
            if (entry?.data !== undefined && entry?.data !== null) {
                return entry.data;
            }
        }
    }

    return null;
};

const getParticipantNameFromProfile = (profileItem) => {
    if (!profileItem) return null;

    const nameAttrs = [
        REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME,
        REF_ATTRIBUTE_NAMES.PROFILE_PREFERRED_NAME,
        REF_ATTRIBUTE_NAMES.PROFILE_FIRST_NAME,
        REF_ATTRIBUTE_NAMES.PROFILE_LAST_NAME
    ];

    const name = getValueFromFlatData(profileItem, nameAttrs);
    if (!name) {
        if (profileItem.data) {
            warn('Items-Service', 'No name found in participant profile', {
                itemId: profileItem.itemId,
                availableKeys: Object.keys(profileItem.data).slice(0, 10)
            });
        }
        return null;
    }

    if (typeof name === 'object' && name.name) return name.name;
    return String(name);
};

const getMyAgedCareIdFromProfile = (profileItem) => {
    if (!profileItem) return null;

    const idAttrs = [
        REF_ATTRIBUTE_NAMES.PROFILE_MY_AGED_CARE_ID,
        REF_ATTRIBUTE_NAMES.PROFILE_MY_AGED_CARE_ID_ALT
    ];

    const id = getValueFromFlatData(profileItem, idAttrs);
    if (!id) return null;
    return String(id);
};

const getServiceFromServicePlan = (servicePlanItem) => {
    if (!servicePlanItem) return null;

    const servicePlanIdValue = getValueFromFlatData(servicePlanItem, REF_ATTRIBUTE_NAMES.SERVICE_PLAN_ID);
    if (servicePlanIdValue) {
        const servicePlanIdStr = String(servicePlanIdValue).trim();
        if (servicePlanIdStr.includes('-')) {
            const parts = servicePlanIdStr.split('-');
            const fromId = parts.length >= 2 ? parts.slice(1).join('-').trim() : servicePlanIdStr;
            if (fromId) return fromId;
        } else if (servicePlanIdStr) {
            return servicePlanIdStr;
        }
    }

    // Fallback: use "Service" attribute from the service plan item (fixes blank Service for some rows)
    const serviceAttr = getValueFromFlatData(servicePlanItem, [REF_ATTRIBUTE_NAMES.SERVICE, 'Service']);
    if (serviceAttr) {
        if (typeof serviceAttr === 'object' && serviceAttr.name) return serviceAttr.name;
        return String(serviceAttr).trim();
    }
    return null;
};

const getServiceIdentifierFromServicePlan = (servicePlanItem, refItemsMap) => {
    if (!servicePlanItem) return null;

    const idAttrs = [
        REF_ATTRIBUTE_NAMES.SERVICE_ID_ITEM_ID,
        REF_ATTRIBUTE_NAMES.SERVICE_ID_ITEM_ID_ALT,
        'Service ID /  Item ID',
        'Service ID/Item ID'
    ];

    const serviceId = getValueFromFlatData(servicePlanItem, idAttrs);
    if (serviceId) {
        return normalizeServiceIdString(serviceId);
    }

    if (refItemsMap) {
        return lookupServiceIdFromRefs(
            servicePlanItem,
            refItemsMap,
            SERVICE_REF_ATTRS,
            getValueFromFlatData,
            getValueFromFlatData,
            extractRefId,
            idAttrs,
        );
    }

    return null;
};

const SERVICE_REF_ATTRS = [
    'Home Support (HS)',
    'Assistive Technology (AT) - Short Term',
    'Assistive Technology (AT) - Ongoing',
    'Home Modification (HM)',
    'Health Professional'
];

const lookupItemDescriptionFromRefs = (servicePlanItem, refItemsMap, codeAttrs, descAttrs, getValueFn) => {
    for (const refAttr of SERVICE_REF_ATTRS) {
        const refValue = getValueFn(servicePlanItem, refAttr);
        const refId = extractRefId(refValue);
        if (!refId) continue;
        const refItem = refItemsMap.get(refId);
        if (!refItem) continue;
        const refCode = getValueFn(refItem, codeAttrs);
        const refDesc = getValueFn(refItem, descAttrs);
        if (refCode || refDesc) {
            return { code: refCode || '', description: refDesc || '' };
        }
    }
    return null;
};

const getItemDescriptionFromServicePlan = (servicePlanItem, refItemsMap) => {
    if (!servicePlanItem) return { code: '', description: '' };

    const codeAttrs = [
        REF_ATTRIBUTE_NAMES.ITEM_DESCRIPTION_CODE,
        REF_ATTRIBUTE_NAMES.ITEM_ID,
        'Item ID',
        'Item Description Code'
    ];
    const descAttrs = [
        REF_ATTRIBUTE_NAMES.ITEM_DESCRIPTION,
        REF_ATTRIBUTE_NAMES.ITEM,
        'Item',
        'Item Description'
    ];

    const directCode = getValueFromFlatData(servicePlanItem, codeAttrs);
    const directDesc = getValueFromFlatData(servicePlanItem, descAttrs);

    if (directCode || directDesc) {
        return {
            code: directCode || '',
            description: directDesc || ''
        };
    }

    if (refItemsMap) {
        const fromRefs = lookupItemDescriptionFromRefs(
            servicePlanItem, refItemsMap, codeAttrs, descAttrs, getValueFromFlatData
        );
        if (fromRefs) return fromRefs;
    }

    return { code: '', description: '' };
};

const getWraparoundDescriptionFromServicePlan = (servicePlanItem, refItemsMap) => {
    if (!servicePlanItem) return { code: '', description: '' };

    const codeAttrs = [
        REF_ATTRIBUTE_NAMES.WRAPAROUND_DESCRIPTION_CODE,
        REF_ATTRIBUTE_NAMES.WRAPAROUND_ITEM_ID,
        'Wraparound Item ID',
        'Wraparound Description Code'
    ];
    const descAttrs = [
        REF_ATTRIBUTE_NAMES.WRAPAROUND_DESCRIPTION,
        'Wraparound Description'
    ];

    const directCode = getValueFromFlatData(servicePlanItem, codeAttrs);
    const directDesc = getValueFromFlatData(servicePlanItem, descAttrs);

    if (directCode || directDesc) {
        return {
            code: directCode || '',
            description: directDesc || ''
        };
    }

    if (refItemsMap) {
        const wraparoundRefValue = getValueFromFlatData(servicePlanItem, ['Wraparound', REF_ATTRIBUTE_NAMES.WRAPAROUND]);
        const wraparoundRefId = extractRefId(wraparoundRefValue);

        if (wraparoundRefId) {
            const wraparoundItem = refItemsMap.get(wraparoundRefId);
            if (wraparoundItem) {
                const refCode = getValueFromFlatData(wraparoundItem, codeAttrs);
                const refDesc = getValueFromFlatData(wraparoundItem, descAttrs);
                return {
                    code: refCode || '',
                    description: refDesc || ''
                };
            }
        }
    }

    return { code: '', description: '' };
};

const normalizeHealthProfessionalTypeOther = (typeOther) => {
    if (!typeOther || !typeOther.includes(' - Other')) return typeOther;
    return typeOther.split(' - Other')[0];
};

const getHealthProfessionalFromServicePlan = (servicePlanItem, refItemsMap) => {
    if (!servicePlanItem) return { typeCode: '', typeOther: '' };

    const typeCodeAttrs = [
        REF_ATTRIBUTE_NAMES.HEALTH_PROFESSIONAL_TYPE_CODE,
        'Health Professional Type Code'
    ];
    const typeOtherAttrs = [
        REF_ATTRIBUTE_NAMES.HEALTH_PROFESSIONAL_TYPE_OTHER,
        'Health Professional Type'
    ];

    let typeCode = getValueFromFlatData(servicePlanItem, typeCodeAttrs) || '';
    let typeOther = getValueFromFlatData(servicePlanItem, typeOtherAttrs) || '';

    if (typeCode || typeOther) {
        return {
            typeCode,
            typeOther: normalizeHealthProfessionalTypeOther(typeOther),
        };
    }

    if (refItemsMap) {
        const healthProfRefValue = getValueFromFlatData(servicePlanItem, ['Health Professional']);
        const healthProfRefId = extractRefId(healthProfRefValue);

        if (healthProfRefId) {
            const healthProfItem = refItemsMap.get(healthProfRefId);
            if (healthProfItem) {
                typeCode = getValueFromFlatData(healthProfItem, typeCodeAttrs) || '';
                typeOther = getValueFromFlatData(healthProfItem, typeOtherAttrs) || '';
                return {
                    typeCode,
                    typeOther: normalizeHealthProfessionalTypeOther(typeOther),
                };
            }
        }
    }

    return { typeCode: '', typeOther: '' };
};

const stripEmojiFromFundingSource = (str) => (str || '').replace(/[\u{1F300}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

const getFundingSourceNameFromItem = (fsItem) => {
    if (!fsItem) return null;

    const nameAttrs = [
        REF_ATTRIBUTE_NAMES.FS_NAME,
        REF_ATTRIBUTE_NAMES.FS_DEFINITION
    ];

    const name = getValueFromFlatData(fsItem, nameAttrs);
    if (!name) {
        if (fsItem.data) {
            warn('Items-Service', 'No name found in funding source item', {
                itemId: fsItem.itemId,
                availableKeys: Object.keys(fsItem.data).slice(0, 10)
            });
        }
        return null;
    }

    const raw = typeof name === 'object' && name.name ? name.name : String(name).trim();
    return stripEmojiFromFundingSource(raw) || null;
};

const isUuidLike = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const getReferenceDisplayName = (refItem) => {
    if (!refItem) return '';
    // Prefer short 'Name' (e.g. Veterans, Remote) over Definition for Primary Supplement and similar refs (per spec: "after the dash use the value of the Primary Supplement attribute")
    const shortName = getValueFromFlatData(refItem, [
        'Primary Supplement',
        'Name',
        REF_ATTRIBUTE_NAMES.FS_NAME,
        REF_ATTRIBUTE_NAMES.FULL_NAME,
        REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME
    ]);
    if (shortName) {
        const raw = typeof shortName === 'object' && shortName.name ? shortName.name : String(shortName).trim();
        if (raw) return stripEmojiFromFundingSource(raw);
    }
    const fundingName = getFundingSourceNameFromItem(refItem);
    if (fundingName) return fundingName;
    const participantName = getParticipantNameFromProfile(refItem);
    if (participantName) return participantName;
    const genericName = getValueFromFlatData(refItem, [
        REF_ATTRIBUTE_NAMES.FS_DEFINITION
    ]);
    if (genericName) {
        if (typeof genericName === 'object' && genericName.name) return genericName.name;
        return String(genericName);
    }
    return '';
};

const formatLabelValueFromData = (value, labels = []) => {
    if (!value) return '';
    if (Array.isArray(value) && value.length > 0) {
        return value.map(item => {
            if (typeof item === 'object' && item.name) return item.name;
            const label = labels.find(l => l.id === item || (typeof item === 'object' && l.id === item.id));
            return label ? label.name : (typeof item === 'object' ? item.name : String(item));
        }).filter(Boolean).join(', ');
    }
    if (typeof value === 'object' && value.name) return value.name;
    if (typeof value === 'object' && value.id) {
        const label = labels.find(l => l.id === value.id);
        return label ? label.name : (value.name || String(value.id));
    }
    if (typeof value === 'string') return value;
    return String(value);
};

const getFolderIds = async (folderName, workspaceId, boardId, providedFolders = null) => {
    let folders = providedFolders;

    if (!Array.isArray(folders)) {
        const { folder } = await getFolder(workspaceId, boardId);
        folders = folder || [];
    }

    let folderids = [], folderNames = folderName.toLowerCase().split(',');

    if (folders && folders.length > 0) {
        try {
            const filteredFolders = await Promise.all(
                folders.map(async folderElement => {
                    const matchesName = folderNames.some(name =>
                        folderElement.name.toLowerCase().includes(name)
                    );
                    return matchesName ? folderElement : null;
                })
            );

            folderids = filteredFolders
                .filter(folder => folder !== null)
                .map(folder => folder.id);

            return folderids || [];
        } catch (folderError) {
            error('Items-Service', 'Error processing folders', {
                message: folderError.message
            });
            return [];
        }
    } else {
        return [];
    }
}

router.get('/:workspaceId/:boardId/invoice-generator/participants', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;

        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        // Build aggregation pipeline to get distinct participant names
        const pipeline = [];

        // Base match - only from Master Plan,Shift Planning and Reporting
        const baseMatch = { workspaceId, boardId };
        const folderIds = await getFolderIds('📋 Participants Intake', workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseMatch.folderId = { $in: folderIds };
        }
        pipeline.push({ $match: baseMatch });

        // Extract participant name from flat data format
        // In flat format, data is: { "Participant Full Name": "Jane Smith", ... }
        pipeline.push({
            $addFields: {
                participantName: { $ifNull: [`$data.${ATTRIBUTE_NAMES.FULL_NAME}`, null] }
            }
        });

        // Filter out null/empty participant names
        pipeline.push({
            $match: {
                participantName: { $ne: null, $ne: "", $exists: true }
            }
        });

        // Group by participant name to get distinct values
        pipeline.push({
            $group: {
                _id: "$participantName"
            }
        });

        // Project to clean format
        pipeline.push({
            $project: {
                _id: 0,
                participant: "$_id"
            }
        });

        // Sort alphabetically
        pipeline.push({
            $sort: { participant: 1 }
        });

        const result = await Item.aggregate(pipeline, {
            allowDiskUse: true,
            batchSize: 1000,
            maxTimeMS: 30000 // 30 second timeout
        });

        const participants = result.map(item => item.participant).filter(p => p && p.trim() !== '');

        res.status(200).json({
            participants: participants
        });
    } catch (err) {
        error('Items-Service', 'Failed to fetch invoice generator participants', {
            message: err.message,
            workspaceId,
            boardId
        }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/invoice-generator-ndis/participants', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;

        if (!workspaceId || !boardId) {
            return res.status(400).json({ message: 'WorkspaceId and boardId are required' });
        }

        // Base query - only from Master Plan, Shift Planning and Reporting
        const baseQuery = { workspaceId, boardId };
        const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseQuery.folderId = { $in: folderIds };
        }

        const allItems = await Item.find(baseQuery).lean();

        // Only Approved timesheets
        const approvedItems = allItems.filter(item => {
            const approval = item?.data?.[NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL];
            return formatNdisLabelValue(approval).trim().toLowerCase() === 'approved';
        });

        const participantProfileIds = new Set();
        for (const item of approvedItems) {
            const ppId = extractNdisRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
            if (ppId && isUuidLike(ppId)) participantProfileIds.add(ppId);
        }

        const refItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, [...participantProfileIds]);

        const names = new Set();
        for (const item of approvedItems) {
            const ppId = extractNdisRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
            const profileItem = ppId ? refItemsMap.get(ppId) : null;
            const name =
                getNdisParticipantDisplayName(profileItem) ||
                (item?.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME] ? String(item.data[NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME]).trim() : '');
            if (name) names.add(name);
        }

        res.status(200).json({ participants: [...names].sort((a, b) => a.localeCompare(b)) });
    } catch (err) {
        error('Items-Service', 'Failed to fetch NDIS invoice generator participants', { message: err.message }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/invoice-generator-ndis/payment-status-options', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;

        if (!workspaceId || !boardId) {
            return res.status(400).json({ message: 'WorkspaceId and boardId are required' });
        }

        const baseQuery = { workspaceId, boardId };
        const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseQuery.folderId = { $in: folderIds };
        }

        const allItems = await Item.find(baseQuery).lean();
        const approvedItems = allItems.filter(item => {
            const approval = item?.data?.[NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL];
            return formatNdisLabelValue(approval).trim().toLowerCase() === 'approved';
        });

        const statuses = new Set();
        for (const item of approvedItems) {
            const raw = getNdisValueMulti(item, [NDIS_MASTERPLAN_ATTR.PAYMENT_STATUS, 'Payment status', 'PaymentStatus']);
            const value = formatNdisLabelValue(raw).trim();
            if (value) statuses.add(value);
        }

        res.status(200).json({ options: [...statuses].sort((a, b) => a.localeCompare(b)) });
    } catch (err) {
        error('Items-Service', 'Failed to fetch NDIS payment status options', { message: err.message }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/invoice-generator-ndis', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        if (!workspaceId || !boardId) {
            return res.status(400).json({ message: 'WorkspaceId and boardId are required' });
        }

        const result = await getNdisInvoiceGeneratorData(
            { workspaceId, boardId, query: req.query, req },
            {
                Item,
                Business,
                InvoiceNumber,
                getFolderIds,
                bulkFetchReferenceItemsFromDB,
                isUuidLike,
                warn,
            },
        );
        res.status(200).json(result);
    } catch (err) {
        error('Items-Service', 'Failed to fetch NDIS invoice generator data', { message: err.message, stack: err.stack }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/monthly-statement/participants', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;

        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        // Build aggregation pipeline to get distinct participant names
        const pipeline = [];

        // Base match - only from Master Plan,Shift Planning and Reporting
        const baseMatch = { workspaceId, boardId };
        const folderIds = await getFolderIds('📋 Participants Intake', workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseMatch.folderId = { $in: folderIds };
        }
        pipeline.push({ $match: baseMatch });

        // Extract participant name from flat data format
        pipeline.push({
            $addFields: {
                participantName: { $ifNull: [`$data.${ATTRIBUTE_NAMES.FULL_NAME}`, null] }
            }
        });

        // Filter out null/empty participant names
        pipeline.push({
            $match: {
                participantName: { $ne: null, $ne: "", $exists: true }
            }
        });

        // Group by participant name to get distinct values
        pipeline.push({
            $group: {
                _id: "$participantName"
            }
        });

        // Project to clean format
        pipeline.push({
            $project: {
                _id: 0,
                participant: "$_id"
            }
        });

        // Sort alphabetically
        pipeline.push({
            $sort: { participant: 1 }
        });

        const result = await Item.aggregate(pipeline, {
            allowDiskUse: true,
            batchSize: 1000,
            maxTimeMS: 30000 // 30 second timeout
        });

        const participants = result.map(item => item.participant).filter(p => p && p.trim() !== '');

        res.status(200).json({
            participants: participants
        });
    } catch (err) {
        error('Items-Service', 'Failed to fetch monthly statement participants', {
            message: err.message,
            workspaceId,
            boardId
        }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/invoice-generator', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        const result = await getInvoiceGeneratorData(
            { workspaceId, boardId, query: req.query, req },
            {
                Item,
                InvoiceNumber,
                getFolderIds,
                bulkFetchReferenceItemsFromDB,
                getValueFromFlatData,
                extractRefId,
                extractAllRefIds,
                getServiceFromServicePlan,
                getServiceIdentifierFromServicePlan,
                getItemDescriptionFromServicePlan,
                getWraparoundDescriptionFromServicePlan,
                getHealthProfessionalFromServicePlan,
                getMyAgedCareIdFromProfile,
                getFundingSourceNameFromItem,
                ATTRIBUTE_NAMES,
                REF_ATTRIBUTE_NAMES,
                info,
                error,
                warn,
            },
        );

        if (result.error) {
            return res.status(result.error.status).json(result.error.body);
        }

        res.status(200).json(result);
    } catch (err) {
        error('Items-Service', 'Failed to fetch invoice generator data', {
            message: err.message
        }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/monthly-statement', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        const result = await getMonthlyStatementData(
            { workspaceId, boardId, query: req.query, req },
            {
                Item,
                Business,
                getFolder,
                bulkFetchReferenceItemsFromDB,
                getValueFromFlatData,
                extractRefId,
                extractAllRefIds,
                getParticipantNameFromProfile,
                getServiceFromServicePlan,
                getFundingSourceNameFromItem,
                stripEmojiFromFundingSource,
                getReferenceDisplayName,
                isUuidLike,
                getCachedMSBudget,
                setCachedMSBudget,
                ATTRIBUTE_NAMES,
                REF_ATTRIBUTE_NAMES,
                BUDGET_CATEGORY_CONFIG,
                BUDGET_CATEGORY_ORDER,
                TRANSACTION_STATUS_USE_ACTUAL_END,
                info,
                error,
                warn,
            },
        );

        if (result.error) {
            return res.status(result.error.status).json(result.error.body);
        }

        res.status(200).json(result);
    } catch (err) {
        error('Items-Service', 'Failed to fetch monthly statement data', {
            message: err.message
        }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/:workspaceId/:boardId/update-status', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const { itemIds, invoiceNumber, status, fileUrl } = req.body;

        if (!workspaceId || !boardId) {
            return res.status(400).json({ message: 'WorkspaceId and BoardId are required' });
        }

        if (!Array.isArray(itemIds) || itemIds.length === 0) {
            return res.status(400).json({ message: 'itemIds must be a non-empty array' });
        }

        const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : null;
        const invoiceIssuedValue = resolveInvoiceIssuedValue(status);

        const results = [];

        for (const itemId of itemIds) {
            try {
                const item = await Item.findOne({ workspaceId, boardId, itemId });
                if (!item) {
                    results.push({
                        itemId,
                        updated: false,
                        reason: 'ITEM_NOT_FOUND'
                    });
                    continue;
                }

                if (!item.data || typeof item.data !== 'object') {
                    results.push({
                        itemId,
                        updated: false,
                        reason: 'NO_DATA_ON_ITEM'
                    });
                    continue;
                }

                const changed = applyInvoiceStatusUpdates(item, { invoiceIssuedValue, invoiceNumber, fileUrl }, info);

                if (!changed) {
                    results.push({
                        itemId,
                        updated: false,
                        reason: 'NO_CHANGES_REQUIRED'
                    });
                    continue;
                }

                // Mark data as modified for Mongoose to save it
                item.markModified('data');
                await item.save();

                // Invalidate cache for this item since it was updated
                invalidateCacheForItem(workspaceId, boardId, itemId);
                invalidateMSCacheForItem(workspaceId, boardId, itemId);

                results.push({
                    itemId,
                    updated: true
                });
            } catch (itemErr) {
                error('Items-Service', 'Failed to update invoice status for item', {
                    message: itemErr.message,
                    itemId,
                    workspaceId,
                    boardId
                }, req ?? null);
                results.push({
                    itemId,
                    updated: false,
                    reason: 'UPDATE_FAILED',
                    error: itemErr.message
                });
            }
        }

        const updatedCount = results.filter(r => r.updated).length;
        const failedCount = results.length - updatedCount;

        info('Items-Service', 'Invoice statuses updated', {
            workspaceId,
            boardId,
            updatedCount,
            failedCount
        }, req ?? null);

        res.status(200).json({
            updatedCount,
            failedCount,
            results
        });
    } catch (err) {
        error('Items-Service', 'Failed to update invoice statuses', {
            message: err.message
        }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/:itemId', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId, itemId } = req.params;

        if (!itemId || !workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId, BoardId, and ItemId are required'
            });
        }

        const item = await Item.findOne({
            itemId,
            workspaceId,
            boardId
        }).lean();

        if (!item) {
            warn('Items-Service', 'Item not found', {
                workspaceId, boardId, itemId
            }, req ?? null);
            return res.status(404).json({ message: 'Item not found' });
        }

        info('Items-Service', 'Successfully fetched item', {
            itemId
        }, req ?? null);

        res.status(200).json(item);
    } catch (err) {
        error('Items-Service', 'Failed to fetch item', {
            message: err.message
        }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

// Debug endpoint to check transformation cache stats
router.get('/cache/stats', authenticateToken, async (req, res) => {
    try {
        const stats = getCacheStats();
        res.status(200).json({
            success: true,
            cache: stats,
            message: 'Transformation cache statistics'
        });
    } catch (err) {
        error('Items-Service', 'Failed to get cache stats', {
            message: err.message
        }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get PDF link by invoice number
router.get('/:workspaceId/:boardId/invoice/:invoiceNumber/pdf-link', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId, invoiceNumber } = req.params;

        if (!workspaceId || !boardId || !invoiceNumber) {
            return res.status(400).json({ message: 'WorkspaceId, boardId, and invoiceNumber are required' });
        }

        // Decode the invoice number from URL
        const decodedInvoiceNumber = decodeURIComponent(invoiceNumber);
        
        // Try to find invoice with exact match first, then try with (ISO+™) suffix
        let invoiceRecord = await InvoiceNumber.findOne({
            workspaceId,
            boardId,
            invoiceNumber: decodedInvoiceNumber,
            type: 'PDF'
        }).lean();

        // If not found, try with (ISO+™) suffix
        if (!invoiceRecord) {
            invoiceRecord = await InvoiceNumber.findOne({
                workspaceId,
                boardId,
                invoiceNumber: `${decodedInvoiceNumber} (ISO+™)`,
                type: 'PDF'
            }).lean();
        }

        if (!invoiceRecord) {
            return res.status(404).json({ message: 'Invoice not found or is not a PDF invoice' });
        }

        if (!invoiceRecord.pdfLink) {
            return res.status(404).json({ message: 'PDF link not available for this invoice' });
        }

        return res.status(200).json({
            pdfLink: invoiceRecord.pdfLink,
            invoiceNumber: invoiceRecord.invoiceNumber,
            itemId: invoiceRecord.itemId
        });
    } catch (err) {
        error('Items-Service', 'Failed to get PDF link', {
            message: err.message
        }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;