import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Item from '../models/Item.js';
import Business from '../models/Business.js';
import InvoiceNumber from '../models/InvoiceNumber.js';
import Board from '../models/Board.js';
import { info, error, warn } from '../utils/logger.js';
import { getFolder } from '../services/isoplus.js';
import { batchProcess } from '../utils/helpers.js';
import { getCachedTransform, setCachedTransform, getCacheStats, invalidateCacheForItem, getCachedMSBudget, setCachedMSBudget, getCachedMSService, setCachedMSService, invalidateMSCacheForItem } from '../utils/transformCache.js';
import { mapNdisClaimFields } from '../services/ndisClaimMapper.js';

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
        let idStr = String(serviceId);
        if (idStr.includes('/')) {
            idStr = idStr.split('/')[0].trim();
        }
        return idStr;
    }

    if (refItemsMap) {
        const serviceRefAttrs = [
            'Home Support (HS)',
            'Assistive Technology (AT) - Short Term',
            'Assistive Technology (AT) - Ongoing',
            'Home Modification (HM)',
            'Health Professional'
        ];

        for (const refAttr of serviceRefAttrs) {
            const refValue = getValueFromFlatData(servicePlanItem, refAttr);
            const refId = extractRefId(refValue);
            if (refId) {
                const refItem = refItemsMap.get(refId);
                if (refItem) {
                    const refServiceId = getValueFromFlatData(refItem, idAttrs);
                    if (refServiceId) {
                        let idStr = String(refServiceId);
                        if (idStr.includes('/')) {
                            idStr = idStr.split('/')[0].trim();
                        }
                        return idStr;
                    }
                }
            }
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
        const serviceRefAttrs = [
            'Home Support (HS)',
            'Assistive Technology (AT) - Short Term',
            'Assistive Technology (AT) - Ongoing',
            'Home Modification (HM)',
            'Health Professional'
        ];

        for (const refAttr of serviceRefAttrs) {
            const refValue = getValueFromFlatData(servicePlanItem, refAttr);
            const refId = extractRefId(refValue);
            if (refId) {
                const refItem = refItemsMap.get(refId);
                if (refItem) {
                    const refCode = getValueFromFlatData(refItem, codeAttrs);
                    const refDesc = getValueFromFlatData(refItem, descAttrs);
                    if (refCode || refDesc) {
                        return {
                            code: refCode || '',
                            description: refDesc || ''
                        };
                    }
                }
            }
        }
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
        if (typeOther && typeOther.includes(' - Other')) {
            typeOther = typeOther.split(' - Other')[0];
        }
        return { typeCode, typeOther };
    }

    if (refItemsMap) {
        const healthProfRefValue = getValueFromFlatData(servicePlanItem, ['Health Professional']);
        const healthProfRefId = extractRefId(healthProfRefValue);

        if (healthProfRefId) {
            const healthProfItem = refItemsMap.get(healthProfRefId);
            if (healthProfItem) {
                typeCode = getValueFromFlatData(healthProfItem, typeCodeAttrs) || '';
                typeOther = getValueFromFlatData(healthProfItem, typeOtherAttrs) || '';

                if (typeOther && typeOther.includes(' - Other')) {
                    typeOther = typeOther.split(' - Other')[0];
                }
                return { typeCode, typeOther };
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

const handleGetInvoiceGenerator = async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const {
            participant = '',
            startDate,
            endDate,
            serviceDeliveryStart,
            serviceDeliveryEnd,
            transactionStatus: transactionStatusFilter = '',
            paymentStatus: paymentStatusFilter = '',
            page = 1,
            limit: limitParam,
            sortBy = 'scheduledServiceDate',
            sortOrder = 'asc'
        } = req.query;

        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        let isNDISBoard = false;
        try {
            const board = await Board.findOne({ boardId: boardId.toString() }).select('label').lean();
            if (board?.label && typeof board.label === 'string') {
                isNDISBoard = board.label.includes('NDIS');
            }
        } catch (boardErr) {
            warn('Items-Service', 'Failed to fetch board label for invoice-generator', {
                message: boardErr.message,
                workspaceId,
                boardId
            }, req ?? null);
        }

        // Calculate pagination
        const hasLimitParam = limitParam !== undefined && limitParam !== null && limitParam !== '';
        let limitNumber = null;
        let applyPagination = false;
        if (hasLimitParam) {
            const limitValue = limitParam.toString().toLowerCase();
            if (limitValue !== 'all') {
                const parsedLimit = parseInt(limitParam, 10);
                if (!isNaN(parsedLimit) && parsedLimit > 0) {
                    limitNumber = parsedLimit;
                    applyPagination = true;
                }
            }
        }
        const pageNumber = applyPagination
            ? (parseInt(page, 10) > 0 ? parseInt(page, 10) : 1)
            : 1;
        const skip = applyPagination && limitNumber
            ? (pageNumber - 1) * limitNumber
            : 0;

        // STABLE VERSION: Use find() instead of aggregate() for better stability
        // Base query - only from Master Plan,Shift Planning and Reporting
        const baseQuery = { workspaceId, boardId };
        const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseQuery.folderId = { $in: folderIds };
        }

        // Fetch all items matching base criteria using stable find() query
        let allItems;
        try {
            allItems = await Item.find(baseQuery).lean();
        } catch (dbErr) {
            error('Items-Service', 'Database query error', {
                message: dbErr.message,
                stack: dbErr.stack,
                workspaceId,
                boardId
            }, req ?? null);
            return res.status(500).json({
                message: 'Error fetching invoice generator data',
                error: dbErr.message
            });
        }

        // Helper function to extract value from flat item data
        // Flat format: item.data = { "Attribute Name": value, ... }
        const getValueFromItem = (item, attributeName) => {
            if (!item.data) return null;
            return item.data[attributeName] ?? null;
        };

        // Helper function to parse number from value
        const parseNumber = (value) => {
            if (value === null || value === undefined) return 0;
            if (typeof value === 'number') return value;
            if (typeof value === 'string') {
                const match = value.match(/-?\d+(?:\.\d+)?/);
                return match ? parseFloat(match[0]) : 0;
            }
            return 0;
        };

        // Helper function to parse date from value
        const parseDate = (value) => {
            if (value === null || value === undefined || value === '') return null;
            if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
            if (typeof value === 'string' || typeof value === 'number') {
                const date = new Date(value);
                return isNaN(date.getTime()) ? null : date;
            }
            return null;
        };

        // Helper function to get label names from flat data format
        // In flat format, labels are already resolved to { id, name, color } objects
        const getLabelNames = (item, attributeName) => {
            if (!item.data) return [];

            const statusData = item.data[attributeName];
            if (!statusData) return [];

            // Handle array of labels
            if (Array.isArray(statusData) && statusData.length > 0) {
                return statusData.map(item => {
                    if (typeof item === 'object' && item.name) {
                        return item.name;
                    }
                    return String(item);
                });
            }

            // Handle single label object
            if (typeof statusData === 'object' && statusData.name) {
                return [statusData.name];
            }

            // Handle string
            if (typeof statusData === 'string') {
                return [statusData];
            }

            return [String(statusData)];
        };

        // Helper function to get raw status data for fallback matching
        const getRawStatusData = (item, attributeName) => {
            if (!item.data) return null;
            return item.data[attributeName] ?? null;
        };

        // Process and filter items in JavaScript (more stable than aggregation)
        const processedItems = await Promise.all(allItems.map(async item => {
            const scheduledStart = getValueFromItem(item, ATTRIBUTE_NAMES.SCHEDULED_START);
            const actualEnd = getValueFromItem(item, ATTRIBUTE_NAMES.ACTUAL_END);
            const participantIds = getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE) || '';
            const participantId = participantIds.length > 0 ? participantIds[0] : '';
            let participantName = '';
            if(participantId) {
                const participantProfileItem = await Item.findOne({ itemId: participantId }).lean();
                participantName = getValueFromItem(participantProfileItem, REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME);
            }

            return {
                item,
                scheduledStartDate: parseDate(scheduledStart),
                actualEndDate: parseDate(actualEnd),
                participantName: String(participantName),
                totalAmountNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.TOTAL_AMOUNT)),
                govSubsidyNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.GOV_SUBSIDY)),
                participantContributionNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)),
                transactionStatusNames: getLabelNames(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS),
                paymentStatusNames: getLabelNames(item, ATTRIBUTE_NAMES.PAYMENT_STATUS || 'Payment Status'),
                transactionStatusRaw: getRawStatusData(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS),
                paymentStatusRaw: getRawStatusData(item, ATTRIBUTE_NAMES.PAYMENT_STATUS || 'Payment Status'),
                timesheetApprovalNames: getLabelNames(item, 'Timesheet Approval'),
                jobStatusRaw: getValueFromItem(item, 'Job Status')
            };
        }));
        // Apply filters in JavaScript
        let filteredItems = processedItems;

        if (startDate) {
            const startDateObj = new Date(startDate);
            filteredItems = filteredItems.filter(p =>
                p.scheduledStartDate && p.scheduledStartDate >= startDateObj
            );
        }

        if (endDate) {
            const endDateObj = new Date(endDate);
            filteredItems = filteredItems.filter(p =>
                p.scheduledStartDate && p.scheduledStartDate <= endDateObj
            );
        }

        if (serviceDeliveryStart) {
            const serviceDeliveryStartObj = new Date(serviceDeliveryStart);
            filteredItems = filteredItems.filter(p =>
                p.actualEndDate && p.actualEndDate >= serviceDeliveryStartObj
            );
        }

        if (serviceDeliveryEnd) {
            const serviceDeliveryEndObj = new Date(serviceDeliveryEnd);
            filteredItems = filteredItems.filter(p =>
                p.actualEndDate && p.actualEndDate <= serviceDeliveryEndObj
            );
        }

        if (participant) {
            try {
                const participantRegex = new RegExp(participant, 'i');
                filteredItems = filteredItems.filter(p =>
                    participantRegex.test(p.participantName)
                );
            } catch (regexErr) {
                warn('Items-Service', 'Invalid participant regex pattern', {
                    pattern: participant,
                    error: regexErr.message
                }, req ?? null);
            }
        }

        if (transactionStatusFilter && transactionStatusFilter !== 'all') {
            if (isNDISBoard) {
                // For NDIS boards, treat this filter as Job Status instead of Transaction Status
                filteredItems = filteredItems.filter(p => {
                    if (!p.jobStatusRaw) return false;
                    const raw = String(p.jobStatusRaw);
                    return transactionStatusFilter == raw;
                });
            } else {
                filteredItems = filteredItems.filter(p => {
                    // First try matching against label names
                    if (Array.isArray(p.transactionStatusNames) && p.transactionStatusNames.length > 0) {
                        if (p.transactionStatusNames.some(name => {
                            const nameStr = String(name);
                            return transactionStatusFilter == nameStr
                        })) {
                            return true;
                        }
                    } else if (p.transactionStatusNames && !Array.isArray(p.transactionStatusNames)) {
                        const nameStr = String(p.transactionStatusNames);
                        if (transactionStatusFilter == nameStr) {
                            return true;
                        }
                    }
                    // Fallback: try matching against raw status data if label names didn't match or were empty
                    if (p.transactionStatusRaw) {
                        const rawStr = Array.isArray(p.transactionStatusRaw)
                            ? p.transactionStatusRaw.map(v => String(v)).join(' ')
                            : String(p.transactionStatusRaw);
                        if (transactionStatusFilter == rawStr) {
                            return true;
                        }
                    }
                    return false;
                });
            }
        }

        if (paymentStatusFilter && paymentStatusFilter !== 'all') {
            filteredItems = filteredItems.filter(p => {
                if (Array.isArray(p.paymentStatusNames) && p.paymentStatusNames.length > 0) {
                    if (p.paymentStatusNames.some(name => {
                        const nameStr = String(name);
                        return paymentStatusFilter == nameStr;
                    })) {
                        return true;
                    }
                } else if (p.paymentStatusNames && !Array.isArray(p.paymentStatusNames)) {
                    const nameStr = String(p.paymentStatusNames);
                    if (paymentStatusFilter == nameStr) {
                        return true;
                    }
                }
                if (p.paymentStatusRaw) {
                    const rawStr = Array.isArray(p.paymentStatusRaw)
                        ? p.paymentStatusRaw.map(v => String(v)).join(' ')
                        : String(p.paymentStatusRaw);
                    if (paymentStatusFilter == rawStr) {
                        return true;
                    }
                }
                return false;
            });
        }

        if (isNDISBoard) {
            filteredItems = filteredItems.filter(p => {
                const value = p.timesheetApprovalNames;
                if (!value) return false;
                const names = Array.isArray(value) ? value : [value];
                const hasApprovedTimesheet = names.some(name => String(name).toLowerCase() === 'approved');
                if (!hasApprovedTimesheet) return false;

                const hasNonZeroTotal = Math.abs(p.totalAmountNum) > 0 ||
                    Math.abs(p.govSubsidyNum) > 0 ||
                    Math.abs(p.participantContributionNum) > 0;

                return hasNonZeroTotal;
            });
        }

        // Calculate totals from filtered items
        const totalsData = {
            totalAmount: 0,
            totalGovSubsidy: 0,
            totalParticipantContribution: 0,
            total: 0
        };

        filteredItems.forEach(p => {
            totalsData.totalAmount += p.totalAmountNum;
            totalsData.totalGovSubsidy += p.govSubsidyNum;
            totalsData.totalParticipantContribution += p.participantContributionNum;
            totalsData.total++;
        });

        // Sort items in JavaScript
        const sortFieldMap = {
            scheduledServiceDate: 'scheduledStartDate',
            serviceDeliveryDate: 'actualEndDate',
            updatedAt: 'updatedAt'
        };
        const selectedSortField = sortFieldMap[sortBy] || 'scheduledStartDate';
        const selectedSortOrder = sortOrder === 'desc' ? -1 : 1;

        filteredItems.sort((a, b) => {
            let aVal, bVal;

            if (selectedSortField === 'updatedAt') {
                aVal = a.item.updatedAt || a.item.createdAt || new Date(0);
                bVal = b.item.updatedAt || b.item.createdAt || new Date(0);
            } else {
                aVal = a[selectedSortField];
                bVal = b[selectedSortField];
            }

            const aIsNull = aVal === null || aVal === undefined;
            const bIsNull = bVal === null || bVal === undefined;
            if (aIsNull && bIsNull) return 0;
            if (aIsNull) return 1;
            if (bIsNull) return -1;

            // Use getTime() for reliable Date comparison
            const aTime = aVal instanceof Date ? aVal.getTime() : aVal;
            const bTime = bVal instanceof Date ? bVal.getTime() : bVal;

            if (aTime < bTime) return -1 * selectedSortOrder;
            if (aTime > bTime) return 1 * selectedSortOrder;

            // Secondary sort by updatedAt if not primary sort field
            if (selectedSortField !== 'updatedAt') {
                const aUpdated = a.item.updatedAt || a.item.createdAt || new Date(0);
                const bUpdated = b.item.updatedAt || b.item.createdAt || new Date(0);
                const aUpdTime = aUpdated instanceof Date ? aUpdated.getTime() : new Date(aUpdated).getTime();
                const bUpdTime = bUpdated instanceof Date ? bUpdated.getTime() : new Date(bUpdated).getTime();
                if (aUpdTime < bUpdTime) return 1;
                if (aUpdTime > bUpdTime) return -1;
            }

            return 0;
        });

        // Apply pagination
        const items = applyPagination && limitNumber
            ? filteredItems.slice(skip, skip + limitNumber)
            : filteredItems;

        // DATABASE-ONLY: Bulk fetch all reference items before transformation
        // Collect all reference IDs from items that need to be transformed
        const servicePlanIds = new Set();
        const participantProfileIds = new Set();
        const fundingSourceIds = new Set();

        for (const processedItem of items) {
            const item = processedItem.item;
            const getValue = (attributeName) => {
                if (!item.data) return null;
                return item.data[attributeName] ?? null;
            };

            // Service plan ID
            const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
            const spId = extractRefId(servicePlanId);
            if (spId) servicePlanIds.add(spId);

            // Participant profile ID
            const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const ppId = extractRefId(participantProfileValue);
            if (ppId) participantProfileIds.add(ppId);

            // Funding source IDs
            const fundingSourceValue = getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE);
            const fsIds = extractAllRefIds(fundingSourceValue);
            fsIds.forEach(id => fundingSourceIds.add(id));
        }

        // Bulk fetch ALL reference items from database in a single query
        const allRefIds = [...servicePlanIds, ...participantProfileIds, ...fundingSourceIds];
        const refItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, allRefIds);

        // SECOND LEVEL: Collect nested reference IDs from service plans
        // (Home Support, Assistive Technology, Wraparound, Health Professional items)
        const nestedRefIds = new Set();
        const serviceRefAttrs = [
            'Home Support (HS)',
            'Assistive Technology (AT) - Short Term',
            'Assistive Technology (AT) - Ongoing',
            'Home Modification (HM)',
            'Health Professional',
            'Wraparound'
        ];

        for (const servicePlanId of servicePlanIds) {
            const servicePlanItem = refItemsMap.get(servicePlanId);
            if (servicePlanItem && servicePlanItem.data) {
                for (const refAttr of serviceRefAttrs) {
                    const refValue = getValueFromFlatData(servicePlanItem, refAttr);
                    const refIds = extractAllRefIds(refValue);
                    refIds.forEach(id => nestedRefIds.add(id));
                }
            }
        }

        // Fetch nested reference items and add to map
        if (nestedRefIds.size > 0) {
            const nestedRefItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, [...nestedRefIds]);
            // Merge nested items into main map
            for (const [key, value] of nestedRefItemsMap) {
                refItemsMap.set(key, value);
            }
        }

        info('Items-Service', 'Bulk fetched reference items from DB (invoice-generator)', {
            servicePlans: servicePlanIds.size,
            participantProfiles: participantProfileIds.size,
            fundingSources: fundingSourceIds.size,
            nestedRefs: nestedRefIds.size,
            totalFound: refItemsMap.size
        }, req ?? null);

        // OPTIMIZED: Bulk fetch all invoice numbers upfront (like invoice-csv endpoint)
        const itemIdsForInvoice = items.map(p => p.item.itemId);
        const invoiceNumbers = await InvoiceNumber.find({
            workspaceId,
            boardId,
            itemId: { $in: itemIdsForInvoice },
            type: 'PDF' // Only fetch PDF invoices for fileUrl
        }).lean();
        const invoiceNumberMap = new Map(invoiceNumbers.map(inv => [inv.itemId, inv.invoiceNumber]));
        const invoiceFileUrlMap = new Map(invoiceNumbers.map(inv => [inv.itemId, inv.pdfLink || null]));

        // OPTIMIZED: Transform items synchronously without rate limiting (like invoice-csv endpoint)
        // This eliminates the massive delays from batchProcess rate limiting
        const transformedItems = items.map((processedItem) => {
            const item = processedItem.item;
            const itemId = item.itemId;
            const itemUpdatedAt = item.updatedAt || item.createdAt;

            // Check if transformed data is already in cache (synchronous check)
            const cachedData = getCachedTransform(workspaceId, boardId, itemId, itemUpdatedAt);
            if (cachedData) {
                // Return cached data with fresh invoice number and fileUrl from bulk-fetched maps
                return {
                    ...cachedData,
                    invoiceNumber: invoiceNumberMap.get(itemId) || cachedData.invoiceNumber,
                    fileUrl: invoiceFileUrlMap.get(itemId) || cachedData.fileUrl
                };
            }

            // Helper to get value from flat data format
            const getValue = (attributeName) => {
                if (!item.data) return null;
                return item.data[attributeName] ?? null;
            };

            // Get invoice number and fileUrl from bulk-fetched maps
            const invoiceNumber = invoiceNumberMap.get(itemId);
            const fileUrl = invoiceFileUrlMap.get(itemId) || null;

            // Helper to format label values from flat data format
            // In flat format, labels are already resolved to { id, name, color } objects
            const formatStatus = (value) => {
                if (!value) return undefined;

                // Handle array of labels
                if (Array.isArray(value) && value.length > 0) {
                    return value.map(item => {
                        if (typeof item === 'object' && item.name) {
                            return item.name;
                        }
                        return String(item);
                    }).filter(Boolean).join(', ');
                }

                // Handle single label object
                if (typeof value === 'object' && value.name) {
                    return value.name;
                }

                // Handle string
                if (typeof value === 'string') {
                    return value;
                }

                return String(value);
            };

            const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START) || null;
            const unit = getValue(ATTRIBUTE_NAMES.UNIT) || '';
            const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;
            const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
            const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
            const govSubsidy = Number(getValue(ATTRIBUTE_NAMES.GOV_SUBSIDY)) || 0;
            const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;
            const notes = getValue(ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';

            // DATABASE-ONLY: Get service plan from pre-fetched lookup map
            const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
            const servicePlanRefId = extractRefId(servicePlanId);
            const servicePlanItem = servicePlanRefId ? refItemsMap.get(servicePlanRefId) : null;

            let service = undefined;
            let serviceIdentifier = undefined;
            let itemDescriptionCode = '';
            let itemDescription = '';
            let wraparoundDescriptionCode = '';
            let wraparoundDescription = '';
            let healthProfessionalTypeCode = '';
            let healthProfessionalTypeOther = '';

            if (servicePlanItem) {
                // Use helper functions to extract data from service plan
                // Pass refItemsMap to allow resolving nested references
                service = getServiceFromServicePlan(servicePlanItem);
                serviceIdentifier = getServiceIdentifierFromServicePlan(servicePlanItem, refItemsMap);

                const itemDesc = getItemDescriptionFromServicePlan(servicePlanItem, refItemsMap);
                itemDescriptionCode = itemDesc.code;
                itemDescription = itemDesc.description;

                const wraparound = getWraparoundDescriptionFromServicePlan(servicePlanItem, refItemsMap);
                wraparoundDescriptionCode = wraparound.code;
                wraparoundDescription = wraparound.description;

                const healthProf = getHealthProfessionalFromServicePlan(servicePlanItem, refItemsMap);
                healthProfessionalTypeCode = healthProf.typeCode;
                healthProfessionalTypeOther = healthProf.typeOther;
            }

            // DATABASE-ONLY: Get participant profile from pre-fetched lookup map
            let careRecipientIdentifier;
            const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const participantProfileRefId = extractRefId(participantProfileValue);
            const participantProfileItem = participantProfileRefId ? refItemsMap.get(participantProfileRefId) : null;

            if (participantProfileItem) {
                careRecipientIdentifier = getMyAgedCareIdFromProfile(participantProfileItem);
            }

            const prescribedItem = getValue('Prescribed Item');
            const prescribedItemValue =
                prescribedItem === true || prescribedItem === 'true' || prescribedItem === 'Y' ? 'Y' : 'N';

            const itemFirstPaymentRaw = getValue('Item First Payment');
            let itemFirstPaymentValue = 'False';
            if (typeof itemFirstPaymentRaw === 'boolean') {
                itemFirstPaymentValue = itemFirstPaymentRaw ? 'True' : 'False';
            } else if (typeof itemFirstPaymentRaw === 'string') {
                const normalized = itemFirstPaymentRaw.trim().toLowerCase();
                itemFirstPaymentValue = ['true', 'y', 'yes'].includes(normalized) ? 'True' : 'False';
            } else if (itemFirstPaymentRaw !== undefined && itemFirstPaymentRaw !== null) {
                itemFirstPaymentValue = String(itemFirstPaymentRaw).trim().toLowerCase() === 'y' ? 'True' : 'False';
            }

            const itemPurchasedMethod = formatStatus(getValue('Item Purchased Method'));
            let itemPurchasedMethodString = undefined;
            if (itemPurchasedMethod) {
                const methodName = typeof itemPurchasedMethod === 'object'
                    ? (itemPurchasedMethod.name || '')
                    : String(itemPurchasedMethod || '');
                if (methodName) {
                    const normalized = methodName.toLowerCase().trim();
                    itemPurchasedMethodString = normalized.includes('loan') ? 'LOANED' : 'PURCHASED';
                }
            }

            // Get "If Loaned, Lender Name" and "If Loaned, Lender Invoice No." fields
            const ifLoanedLenderName = getValue('If Loaned, Lender Name');
            const ifLoanedLenderNameString = ifLoanedLenderName
                ? (typeof ifLoanedLenderName === 'object' ? ifLoanedLenderName.name : String(ifLoanedLenderName))
                : '';

            const ifLoanedLenderInvoiceNo =
                getValue('If Loaned, Lender Invoice No.') ||
                '';

            // Set loanedByOrganisationName and loanedByInvoiceNumber based on itemPurchasedMethod
            // If LOANED is selected, use the "If Loaned" fields; otherwise, use BLANK
            let loanedByOrganisationName = '';
            let loanedByInvoiceNumber = '';
            if (itemPurchasedMethodString === 'LOANED') {
                loanedByOrganisationName = ifLoanedLenderNameString || '';
                loanedByInvoiceNumber = ifLoanedLenderInvoiceNo || '';
            }

            const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END) || null;
            const serviceDeliveryDate = actualEnd
                ? (() => {
                    const date = new Date(actualEnd);
                    return isNaN(date.getTime()) ? null : date.toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
                })()
                : null;
            const scheduledServiceDate = scheduledStart
                ? (() => {
                    const date = new Date(scheduledStart);
                    return isNaN(date.getTime()) ? null : date.toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
                })()
                : null;

            // Get Delivered By for deliveredByThirdParty calculation
            const deliveredBy = formatStatus(getValue(ATTRIBUTE_NAMES.DELIVERED_BY));
            const deliveredByThirdParty = deliveredBy && deliveredBy.includes('Associated') ? 'True' : 'False';

            // Get payment status from flat data
            const paymentStatusValue = getValue(ATTRIBUTE_NAMES.PAYMENT_STATUS) || getValue('Payment Status');
            const paymentStatusFormatted = formatStatus(paymentStatusValue);

            // Get transaction status from flat data
            const transactionStatusValue = getValue(ATTRIBUTE_NAMES.TRANSACTION_STATUS);
            const transactionStatusFormatted = formatStatus(transactionStatusValue);

            const jobStatusRaw = getValue('Job Status');
            const jobStatusFormatted = formatStatus(jobStatusRaw);
            const gstRaw = getValue('GST');
            const gstLabel = isNDISBoard ? 'GST Free' : (typeof gstRaw === 'string' ? gstRaw : undefined);

            // DATABASE-ONLY: Get funding source names from pre-fetched lookup map
            let fundingSource;
            const fundingSourceData = getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE);
            if (fundingSourceData) {
                const fsIds = extractAllRefIds(fundingSourceData);
                const fundingSourceNames = [];

                for (const fsId of fsIds) {
                    const fsItem = refItemsMap.get(fsId);
                    const fsName = getFundingSourceNameFromItem(fsItem);
                    if (fsName) {
                        fundingSourceNames.push(fsName);
                    }
                }

                fundingSource = fundingSourceNames.length > 0 ? fundingSourceNames.join(', ') : undefined;
            }

            const normalizedUnit = typeof unit === 'string' ? unit.toLowerCase() : '';
            const isItemUnit = normalizedUnit === 'item';
            const serviceLabel = service || '';
            const isWraparound = serviceLabel.toLowerCase().includes('wraparound');

            let transformedData = {
                // Table fields (Visible in ISO+ Portal Table)
                id: item.itemId,
                paymentStatus: paymentStatusFormatted,
                participant: processedItem?.participantName || '',
                service: serviceLabel,
                scheduledServiceDate: scheduledServiceDate,
                serviceDeliveryDate: serviceDeliveryDate,
                unit: unit,
                quantity: quantity,
                unitPrice: unitPrice,
                totalAmount: totalAmount,
                govSubsidy: govSubsidy,
                participantContribution: participantContribution,
                fundingSource: fundingSource,
                transactionStatus: transactionStatusFormatted,
                notes: notes,
                jobStatus: jobStatusFormatted,
                gst: gstLabel,
                // PDF download field
                fileUrl: fileUrl,
                // CSV export fields (Included in CSV but not in table)
                invoiceNumber: invoiceNumber,
                careRecipientIdentifier: careRecipientIdentifier,
                serviceIdentifier: serviceIdentifier,
                deliveredByThirdParty: deliveredByThirdParty,
                itemOrWraparound: isItemUnit ? 'Item' : (isWraparound ? 'Wraparound' : ''),
                itemDescriptionCode: isItemUnit ? (itemDescriptionCode || '') : '',
                itemDescription: isItemUnit ? (itemDescription || '') : '',
                wraparoundDescriptionCode: isWraparound ? (wraparoundDescriptionCode || '') : '',
                wraparoundDescription: isWraparound ? (wraparoundDescription || '') : '',
                prescribedItem: prescribedItemValue,
                itemPurchasedMethod: itemPurchasedMethodString,
                loanedByOrganisationName: loanedByOrganisationName,
                loanedByInvoiceNumber: loanedByInvoiceNumber,
                healthProfessionalTypeCode: healthProfessionalTypeCode,
                healthProfessionalTypeOther: healthProfessionalTypeOther,
                itemFirstPayment: itemFirstPaymentValue
            };

            if (isNDISBoard) {
                const actualShiftDurationHours = Number(getValue('Actual Shift Duration(Hr.)')) || 0;
                const labourTravelMinutes = Number(getValue('Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.')) || 0;
                const nonFaceToFaceHours = Number(getValue('Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)')) || 0;
                const cancellationReasonRaw = getValue('Cancellation Reason');

                const ndisFields = mapNdisClaimFields({
                    unit,
                    quantity,
                    unitPrice,
                    serviceIdentifier,
                    invoiceNumber,
                    jobStatus: jobStatusFormatted,
                    scheduledServiceDate: scheduledServiceDate,
                    serviceDeliveryDate: serviceDeliveryDate,
                    actualShiftDurationHours,
                    labourTravelMinutes,
                    nonFaceToFaceHours,
                    cancellationReasonRaw,
                    gstLabelRaw: gstLabel
                });

                transformedData = {
                    ...transformedData,
                    ...ndisFields
                };
            }

            // Store transformed data in cache for future requests
            setCachedTransform(workspaceId, boardId, item.itemId, transformedData);

            return transformedData;
        });

        res.status(200).json({
            items: transformedItems,
            total: totalsData.total || 0,
            totalAmount: totalsData.totalAmount || 0,
            totalGovSubsidy: totalsData.totalGovSubsidy || 0,
            totalParticipantContribution: totalsData.totalParticipantContribution || 0
        });
    } catch (err) {
        error('Items-Service', 'Failed to fetch invoice generator data', {
            message: err.message
        }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
};

router.get('/:workspaceId/:boardId/invoice-generator', authenticateToken, handleGetInvoiceGenerator);
router.get('/:workspaceId/:boardId/ndis-invoice-generator', authenticateToken, handleGetInvoiceGenerator);

router.get('/:workspaceId/:boardId/monthly-statement', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const {
            participant = '',
            startDate,
            endDate,
            month,
            year,
            budgetPage = 1,
            budgetLimit: budgetLimitParam,
            servicePage = 1,
            serviceLimit: serviceLimitParam,
            serviceSortBy,
            serviceSortOrder = 'asc',
            serviceTransactionStatus: serviceTransactionStatusFilter = '',
            serviceFundingSource: fundingSourceFilter = ''
        } = req.query;

        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        // Fetch business details once for all items (Provider ID, name, address for monthly statement)
        let businessProfile = null;
        try {
            businessProfile = await Business.findOne({ workspaceId: workspaceId.toString() })
                .select('name phone email companyRegistrationId address')
                .lean();
        } catch (err) {
            warn('Items-Service', 'Failed to fetch business name', {
                message: err.message,
                workspaceId
            }, req ?? null);
        }

        // Fetch folder metadata once so we can group by real folder names
        let folders = [];
        try {
            const { folder } = await getFolder(workspaceId, boardId);
            folders = Array.isArray(folder) ? folder : [];
        } catch (folderErr) {
            warn('Items-Service', 'Failed to fetch folders', {
                message: folderErr.message,
                workspaceId,
                boardId
            }, req ?? null);
        }

        const folderIdToName = new Map();
        const folderIdToCode = {};
        const budgetFolderConfig = [...BUDGET_CATEGORY_CONFIG];

        folders.forEach(folderElement => {
            if (!folderElement?.id) return;
            const folderName = folderElement.name || '';
            folderIdToName.set(folderElement.id, folderName);

            const normalized = folderName.toLowerCase();
            const matchedConfig = budgetFolderConfig.find(cfg =>
                normalized.includes(cfg.folderName.toLowerCase())
            );
            if (matchedConfig) {
                folderIdToCode[folderElement.id] = matchedConfig.code;
            }
        });

        // Helper function to get folder IDs for a query
        const getFolderIdsForQuery = async (folderName) => {
            if (!folders || folders.length === 0) return [];
            const folderNames = folderName.toLowerCase().split(',').map(name => name.trim()).filter(Boolean);
            if (folderNames.length === 0) return [];
            return folders
                .filter(folderElement => {
                    const folderNameLower = (folderElement.name || '').toLowerCase();
                    return folderNames.some(name => folderNameLower.includes(name));
                })
                .map(folderElement => folderElement.id);
        };

        // Helper function to extract value from flat item data
        // Flat format: item.data = { "Attribute Name": value, ... }
        const getValueFromItem = (item, attributeName) => {
            if (!item.data) return null;
            return item.data[attributeName] ?? null;
        };

        // Helper function to parse date from value
        const parseDate = (value) => {
            if (value === null || value === undefined || value === '') return null;
            if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
            if (typeof value === 'string' || typeof value === 'number') {
                const date = new Date(value);
                return isNaN(date.getTime()) ? null : date;
            }
            return null;
        };

        // Fetch all budget items (first table) using find()
        const budgetFolderNames = [
            'Home Support Quarterly Budget',
            'Restorative Care Pathway Budget',
            'End-of-Life Pathway Budget',
            'Assistive Technology - Short-term Budget',
            'Assistive Technology - Ongoing Budget',
            'Home Modification Budget',
            'Home Support Care Management Budget'
        ].join(',');

        const budgetFolderIds = await getFolderIdsForQuery(budgetFolderNames);
        const budgetBaseQuery = { workspaceId, boardId };
        if (budgetFolderIds && budgetFolderIds.length > 0) {
            budgetBaseQuery.folderId = { $in: budgetFolderIds };
        }

        let allBudgetItems;
        try {
            allBudgetItems = await Item.find(budgetBaseQuery).lean();
        } catch (dbErr) {
            error('Items-Service', 'Database query error for budget items', {
                message: dbErr.message,
                stack: dbErr.stack,
                workspaceId,
                boardId
            }, req ?? null);
            return res.status(500).json({
                message: 'Error fetching budget items for monthly statement',
                error: dbErr.message
            });
        }

        const parseNumberValue = (rawValue) => {
            if (rawValue === null || rawValue === undefined) return 0;
            if (Array.isArray(rawValue) && rawValue.length > 0) return parseNumberValue(rawValue[0]);
            if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : 0;
            if (typeof rawValue !== 'string') return 0;

            let s = rawValue.trim();
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
        };

        const normalizeAttributeNames = (attributeName) => {
            if (Array.isArray(attributeName)) {
                return attributeName
                    .filter((name) => typeof name === 'string' && name.trim() !== '');
            }
            if (typeof attributeName === 'string' && attributeName.trim() !== '') {
                return [attributeName];
            }
            return [];
        };

        // Get value from flat data format, trying multiple attribute names
        const getValueFromItemMulti = (item, attributeNames) => {
            const candidateNames = normalizeAttributeNames(attributeNames);
            if (!item?.data || candidateNames.length === 0) {
                return null;
            }
            for (const name of candidateNames) {
                const value = item.data[name];
                if (value !== undefined && value !== null) {
                    return value;
                }
            }
            return null;
        };

        const getNumberFromItem = (item, attributeName) => {
            const value = getValueFromItemMulti(item, attributeName);
            return parseNumberValue(value);
        };

        const getLabelFromItem = (item, attributeName) => {
            const data = getValueFromItemMulti(item, attributeName);
            if (!data) {
                return null;
            }
            // In flat format, labels are already resolved to { id, name, color } objects
            if (Array.isArray(data) && data.length > 0) {
                const first = data[0];
                if (typeof first === 'object' && first.name) {
                    return first.name;
                }
                return String(first);
            }
            if (typeof data === 'object' && data.name) {
                return data.name;
            }
            if (typeof data === 'string') {
                return data;
            }
            return null;
        };

        const getDateFromItem = (item, attributeName) => {
            const data = getValueFromItemMulti(item, attributeName);
            if (!data) {
                return null;
            }
            if (typeof data === 'string') {
                return data;
            }
            return null;
        };

        const getTextFromItem = (item, attributeName) => {
            const data = getValueFromItemMulti(item, attributeName);
            if (data === null || data === undefined) {
                return '';
            }
            if (typeof data === 'string') {
                return data;
            }
            if (Array.isArray(data) && data.length > 0) {
                return data[0]?.toString() || '';
            }
            return data.toString ? data.toString() : '';
        };

        const getFirstReferenceId = (item, attributeName) => {
            const data = getValueFromItemMulti(item, attributeName);
            if (Array.isArray(data) && data.length > 0) {
                return data[0];
            }
            if (typeof data === 'string') {
                return data;
            }
            return null;
        };

        const resolveReferenceValue = (value, refMap) => {
            if (!value) return '';
            if (Array.isArray(value)) {
                return value.map(v => resolveReferenceValue(v, refMap)).filter(Boolean).join(', ');
            }
            if (typeof value === 'object') {
                if (value.name) return value.name;
                if (value.id) return resolveReferenceValue(value.id, refMap);
                return value.toString ? value.toString() : '';
            }
            const valueStr = String(value);
            if (isUuidLike(valueStr) && refMap?.has(valueStr)) {
                return getReferenceDisplayName(refMap.get(valueStr)) || valueStr;
            }
            return valueStr;
        };

        // DATABASE-ONLY: Bulk fetch all participant profiles needed for budget items
        const budgetParticipantProfileIds = new Set();
        for (const item of allBudgetItems) {
            const participantProfileId = getFirstReferenceId(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            if (participantProfileId) {
                const id = extractRefId(participantProfileId);
                if (id) budgetParticipantProfileIds.add(id);
            }
            // Also collect Associated Participant IDs for HSCM items
            const associatedParticipantId = getFirstReferenceId(item, 'Associated Participant');
            if (associatedParticipantId) {
                const id = extractRefId(associatedParticipantId);
                if (id) budgetParticipantProfileIds.add(id);
            }
        }

        const budgetProfilesMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, [...budgetParticipantProfileIds]);

        const primarySupplementRefIds = new Set();
        for (const item of allBudgetItems) {
            const primarySupplementValue = getValueFromItemMulti(item, 'Primary Supplement');
            const refIds = extractAllRefIds(primarySupplementValue).filter(isUuidLike);
            refIds.forEach(id => primarySupplementRefIds.add(id));
        }

        const primarySupplementMap = primarySupplementRefIds.size > 0
            ? await bulkFetchReferenceItemsFromDB(workspaceId, boardId, [...primarySupplementRefIds])
            : new Map();

        info('Items-Service', 'Bulk fetched participant profiles from DB (monthly-statement budget)', {
            profileIds: budgetParticipantProfileIds.size,
            foundProfiles: budgetProfilesMap.size
        }, req ?? null);

        // DATABASE-ONLY: Resolve participant name from lookup map using helper function
        const resolveParticipantName = (participantProfileIdValue) => {
            if (!participantProfileIdValue) {
                return '';
            }
            const profileIdStr = extractRefId(participantProfileIdValue);
            if (!profileIdStr) return '';

            const participantProfile = budgetProfilesMap.get(profileIdStr);
            const name = getParticipantNameFromProfile(participantProfile);
            return name || '';
        };

        const determineCategoryCodeForBudget = (item) => {
            // DATABASE-ONLY: Determine category from folderId if already mapped
            if (item?.folderId && folderIdToCode[item.folderId]) {
                return folderIdToCode[item.folderId];
            }
            
            // Try to determine category from item data (Funding Stream attribute)
            const fundingStreamValue = getValueFromFlatData(item, ATTRIBUTE_NAMES.FUNDING_STREAM);
            if (fundingStreamValue) {
                // This would require fetching the funding stream item, but for now use default
                // Category will be determined from folderId patterns in items
            }
            
            // Default to HSQ if we can't determine
            return 'HSQ';
        };

        const getMonthLabelFromDate = (dateValue) => {
            if (!dateValue) return '';
            const date = new Date(dateValue);
            if (isNaN(date.getTime())) return '';
            const monthLabelLookupLocal = [
                'January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'
            ];
            return monthLabelLookupLocal[date.getMonth()] || '';
        };

        const getYearFromDate = (dateValue) => {
            if (!dateValue) return '';
            const date = new Date(dateValue);
            if (isNaN(date.getTime())) return '';
            return date.getFullYear().toString();
        };

        const determineCategoryCodeForService = (service = {}) => {
            const normalize = (value) => (value || '').toString().toLowerCase();
            const fundingSource = normalize(service.fundingSource);
            const serviceName = normalize(service.service);
            const notes = normalize(service.notes);
            const haystack = `${fundingSource} ${serviceName} ${notes}`;

            if (haystack.includes('restorative care')) {
                return 'RCP';
            }
            if (haystack.includes('end-of-life') || haystack.includes('end of life')) {
                return 'EOL';
            }
            if (haystack.includes('assistive') && haystack.includes('short')) {
                return 'ATS';
            }
            if (haystack.includes('assistive') && haystack.includes('ongoing')) {
                return 'ATO';
            }
            if (haystack.includes('modification')) {
                return 'HMB';
            }
            if (haystack.includes('home support') || haystack.includes('hsq')) {
                return 'HSQ';
            }
            return 'HSQ';
        };

        const transformBudgetItem = (item) => {
            const itemId = item.itemId;
            const itemUpdatedAt = item.updatedAt || item.createdAt;

            // Check if transformed data is already in cache
            const cachedData = getCachedMSBudget(workspaceId, boardId, itemId, itemUpdatedAt);
            if (cachedData) {
                return cachedData;
            }

            const categoryCode = determineCategoryCodeForBudget(item);
            const folderName = folderIdToName.get(item.folderId) || BUDGET_CATEGORY_CONFIG.find(cfg => cfg.code === categoryCode)?.folderName || '';

            const isCareManagement = folderName.toLowerCase().includes('home support care management budget');
            if (isCareManagement) {
                const participantProfileIdValue = getFirstReferenceId(item, 'Associated Participant');
                const participantName = resolveParticipantName(participantProfileIdValue);
                const dateValue = getValueFromItemMulti(item, 'Date');
                const transactionTypeValue = getValueFromItemMulti(item, 'Transaction Type');
                const receivedAmount = getNumberFromItem(item, 'Received Amount ($)');
                const allocatedTime = getNumberFromItem(item, [ATTRIBUTE_NAMES.ALLOCATED_TIME, 'Allocated Time (Hr.)']);
                const allocatedAmount = getNumberFromItem(item, 'Allocated Amount ($-)');
                const currentBalanceValue = getNumberFromItem(item, 'Net Movement ($)');
                const currentBalance = Number.isFinite(currentBalanceValue) && currentBalanceValue !== 0
                    ? currentBalanceValue
                    : (receivedAmount || 0) + (allocatedAmount || 0);
                const transactionType = (() => {
                    if (!transactionTypeValue) return '';
                    if (typeof transactionTypeValue === 'object' && transactionTypeValue.name) {
                        return transactionTypeValue.name;
                    }
                    if (typeof transactionTypeValue === 'string') return transactionTypeValue;
                    return transactionTypeValue.toString ? transactionTypeValue.toString() : '';
                })();

                const transformedData = {
                    id: item.itemId,
                    categoryCode: 'HSCM',
                    folderName: folderName || 'Home Support Care Management Budget',
                    participantName,
                    participantProfileId: participantProfileIdValue ? participantProfileIdValue.toString() : null,
                    month: getMonthLabelFromDate(dateValue),
                    year: getYearFromDate(dateValue),
                    quarter: '',
                    fundingStartDate: null,
                    fundingEndDate: null,
                    totalAvailableBudget: receivedAmount || 0,
                    availableFundStart: receivedAmount || 0,
                    quarterlyAdjustment: 0,
                    primarySupplementAmount: 0,
                    carryoverFunding: 0,
                    unspentReturned: 0,
                    commonwealthUnspent: 0,
                    providerUnspent: 0,
                    participantUnspent: 0,
                    previousMonthSpending: 0,
                    deliveredAmount: allocatedAmount || 0,
                    deliveredAmountRaw: allocatedAmount,
                    adjustmentAmount: 0,
                    remainingBalance: Math.max(0, currentBalance),
                    fundClassification: 'Care Management',
                    fundAmount: 0,
                    fund: '',
                    committedFunds: 0,
                    fundingStreamId: null,
                    hscmDate: dateValue || null,
                    hscmTransactionType: transactionType,
                    hscmReceivedAmount: receivedAmount || 0,
                    hscmAllocatedTime: allocatedTime || 0,
                    hscmAllocatedAmount: allocatedAmount || 0,
                    hscmCurrentBalance: currentBalance || 0,
                    rawData: item.data || {}
                };

                setCachedMSBudget(workspaceId, boardId, itemId, transformedData);
                return transformedData;
            }

            const participantProfileIdValue = getFirstReferenceId(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const participantName = resolveParticipantName(participantProfileIdValue);

            const monthLabel = getLabelFromItem(item, ATTRIBUTE_NAMES.MONTH_LABEL);
            const yearLabel = getLabelFromItem(item, ATTRIBUTE_NAMES.YEAR_LABEL);
            const quarterLabel = getLabelFromItem(item, ATTRIBUTE_NAMES.FY_QUARTER);

            const fundingStartDate = getDateFromItem(item, ATTRIBUTE_NAMES.FUNDING_START_DATE);
            const fundingEndDate = getDateFromItem(item, ATTRIBUTE_NAMES.FUNDING_END_DATE);

            const availableFundStart = getNumberFromItem(item, ATTRIBUTE_NAMES.AVAILABLE_FUND_START);
            const quarterlyAdjustment = getNumberFromItem(item, ATTRIBUTE_NAMES.QUARTERLY_ADJUSTMENT);
            const primarySupplementAmount = getNumberFromItem(item, ATTRIBUTE_NAMES.PRIMARY_SUPPLEMENT_AMOUNT);
            const additionalAmountApproved = getNumberFromItem(item, ATTRIBUTE_NAMES.ADDITIONAL_AMOUNT_APPROVED_AT);
            const carryoverFunding = getNumberFromItem(item, ATTRIBUTE_NAMES.CARRYOVER_FUNDING);
            const unspentReturned = getNumberFromItem(item, ATTRIBUTE_NAMES.UNSPENT_BUDGET_RETURNED);
            const commonwealthUnspent = getNumberFromItem(item, ATTRIBUTE_NAMES.COMMONWEALTH_UNSPENT_FUNDS);
            const providerUnspent = getNumberFromItem(item, ATTRIBUTE_NAMES.PROVIDER_UNSPENT_FUNDS);
            const participantUnspent = getNumberFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_UNSPENT_FUNDS);
            const previousMonthSpendingSameQuarter = getNumberFromItem(item, ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING);
            const previousMonthSpendingAllocatedPeriod = getNumberFromItem(
                item,
                ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD
            );
            const previousMonthSpending = (categoryCode === 'ATS' || categoryCode === 'ATO' || categoryCode === 'HMB' || categoryCode === 'RCP' || categoryCode === 'EOL')
                ? previousMonthSpendingAllocatedPeriod
                : previousMonthSpendingSameQuarter;

            const totalAvailableBudgetHomeSupport = getNumberFromItem(item, ATTRIBUTE_NAMES.TOTAL_AVAILABLE_HOME_SUPPORT);
            let totalAvailableBudget = totalAvailableBudgetHomeSupport;
            if (!totalAvailableBudget && categoryCode === 'HSQ') {
                totalAvailableBudget =
                    availableFundStart +
                    quarterlyAdjustment +
                    primarySupplementAmount +
                    carryoverFunding +
                    commonwealthUnspent +
                    providerUnspent +
                    participantUnspent +
                    previousMonthSpending +
                    unspentReturned;
            }
            if (!totalAvailableBudget && categoryCode !== 'HSQ') {
                // Try both long (Budget) and short (Fund) attribute names used by boards
                const totalAttrs = (() => {
                    if (categoryCode === 'RCP') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_RESTORATIVE, REF_ATTRIBUTE_NAMES.TOTAL_FUND_RESTORATIVE];
                    if (categoryCode === 'EOL') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_END_OF_LIFE, REF_ATTRIBUTE_NAMES.TOTAL_FUND_END_OF_LIFE];
                    if (categoryCode === 'ATS') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_AT_SHORT_TERM, REF_ATTRIBUTE_NAMES.TOTAL_FUND_AT_SHORT_TERM];
                    if (categoryCode === 'ATO') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_AT_ONGOING, REF_ATTRIBUTE_NAMES.TOTAL_FUND_AT_ONGOING];
                    if (categoryCode === 'HMB') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_HOME_MOD, REF_ATTRIBUTE_NAMES.TOTAL_FUND_HM];
                    return null;
                })();
                if (totalAttrs && totalAttrs.length) {
                    totalAvailableBudget = getNumberFromItem(item, totalAttrs) || 0;
                }
                // Fallback for RCP/EOL: Total Available = Available Fund at Start + Primary Supplement + Spending from Previous Month(s) within Allocated Period (per formula)
                if (!totalAvailableBudget && (categoryCode === 'RCP' || categoryCode === 'EOL')) {
                    const previousSpendingAllocated = getNumberFromItem(item, ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD) || 0;
                    totalAvailableBudget = availableFundStart + primarySupplementAmount + previousSpendingAllocated;
                }
                // Fallback for ATS: Total Available Fund = Available Fund at Start + Primary Supplement + Additional amount approved (AT high tier) + Spending from Previous Month(s) within Allocated Period (per formula)
                if (!totalAvailableBudget && categoryCode === 'ATS') {
                    const previousSpendingAllocated = getNumberFromItem(item, ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD) || 0;
                    totalAvailableBudget = availableFundStart + primarySupplementAmount + additionalAmountApproved + previousSpendingAllocated;
                }
                // Fallback for ATO/HMB: Total Available Fund = Available Fund at Start + Primary Supplement + Spending from Previous Month(s) within Allocated Period (per formula)
                if (!totalAvailableBudget && (categoryCode === 'ATO' || categoryCode === 'HMB')) {
                    const previousSpendingAllocated = getNumberFromItem(item, ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD) || 0;
                    totalAvailableBudget = availableFundStart + primarySupplementAmount + previousSpendingAllocated;
                }
                // Fallback for other categories: use Available Fund at Start of Month
                if (!totalAvailableBudget && availableFundStart) {
                    totalAvailableBudget = availableFundStart;
                }
            }

            const deliveredAmountRaw = (() => {
                if (categoryCode === 'ATS') {
                    return getNumberFromItem(item, ATTRIBUTE_NAMES.AT_SHORT_TERM_DELIVERED);
                }
                if (categoryCode === 'ATO') {
                    return getNumberFromItem(item, ATTRIBUTE_NAMES.AT_ONGOING_DELIVERED);
                }
                if (categoryCode === 'HMB') {
                    return getNumberFromItem(item, ATTRIBUTE_NAMES.HOME_MODIFICATION_DELIVERED);
                }
                if (categoryCode === 'RCP') {
                    return getNumberFromItem(item, ATTRIBUTE_NAMES.RESTORATIVE_CARE_DELIVERED);
                }
                if (categoryCode === 'EOL') {
                    return getNumberFromItem(item, ATTRIBUTE_NAMES.END_OF_LIFE_DELIVERED);
                }
                return getNumberFromItem(item, ATTRIBUTE_NAMES.HOME_SUPPORT_DELIVERED);
            })();
            const adjustmentAmount = getNumberFromItem(item, ATTRIBUTE_NAMES.HOME_SUPPORT_ADJUSTMENTS);
            const primarySupplementValue = getValueFromItemMulti(item, 'Primary Supplement');
            const primarySupplementLabel = resolveReferenceValue(primarySupplementValue, primarySupplementMap);
            const fundClassification = getLabelFromItem(item, ATTRIBUTE_NAMES.FUND_CLASSIFICATION);
            const fundAmount = getNumberFromItem(item, ATTRIBUTE_NAMES.FUND_AMOUNT);
            const fund = getTextFromItem(item, ATTRIBUTE_NAMES.FUND_TEXT);

            const committedATShort = getNumberFromItem(item, ATTRIBUTE_NAMES.COMMITTED_AT_SHORT_TERM);
            const committedATOngoing = getNumberFromItem(item, ATTRIBUTE_NAMES.COMMITTED_AT_ONGOING);
            const committedHM = getNumberFromItem(item, ATTRIBUTE_NAMES.COMMITTED_HOME_MODIFICATION);

            let committedFunds = 0;
            if (categoryCode === 'ATS') {
                committedFunds = committedATShort;
            } else if (categoryCode === 'ATO') {
                committedFunds = committedATOngoing;
            } else if (categoryCode === 'HMB') {
                committedFunds = committedHM;
            }

            // Remaining as at End of Month = Total Available + Delivered ($-) + Adjustments (per formula)
            const remainingEndOfMonthAttr = (() => {
                if (categoryCode === 'HSQ') return ATTRIBUTE_NAMES.REMAINING_HOME_SUPPORT_BALANCE;
                if (categoryCode === 'ATS') return REF_ATTRIBUTE_NAMES.REMAINING_AT_SHORT_TERM_END_OF_MONTH;
                if (categoryCode === 'ATO') return REF_ATTRIBUTE_NAMES.REMAINING_AT_ONGOING_END_OF_MONTH;
                if (categoryCode === 'HMB') return REF_ATTRIBUTE_NAMES.REMAINING_HM_END_OF_MONTH;
                if (categoryCode === 'RCP' || categoryCode === 'EOL') return null; // RCP/EOL use single remaining
                return ATTRIBUTE_NAMES.REMAINING_HOME_SUPPORT_BALANCE;
            })();
            const remainingBalanceEndOfMonthRaw = remainingEndOfMonthAttr
                ? getValueFromItemMulti(item, remainingEndOfMonthAttr)
                : (categoryCode === 'RCP' || categoryCode === 'EOL'
                    ? getValueFromItemMulti(
                        item,
                        categoryCode === 'RCP'
                            ? REF_ATTRIBUTE_NAMES.REMAINING_RESTORATIVE_END_OF_MONTH
                            : REF_ATTRIBUTE_NAMES.REMAINING_END_OF_LIFE_END_OF_MONTH
                    )
                    : null);
            const remainingBalanceEndOfMonth = (remainingBalanceEndOfMonthRaw !== null && remainingBalanceEndOfMonthRaw !== undefined)
                ? Math.max(0, parseNumberValue(remainingBalanceEndOfMonthRaw))
                : Math.max(0, totalAvailableBudget + deliveredAmountRaw + adjustmentAmount);

            // For ATS/ATO/HMB: Remaining for Allocation Period = End of Month + Committed - to be delivered ($-) (per formula)
            let remainingBalanceAllocationPeriod = null;
            if (categoryCode === 'ATS' || categoryCode === 'ATO' || categoryCode === 'HMB') {
                const allocationAttr = categoryCode === 'ATS' ? REF_ATTRIBUTE_NAMES.REMAINING_AT_SHORT_TERM
                    : categoryCode === 'ATO' ? REF_ATTRIBUTE_NAMES.REMAINING_AT_ONGOING
                        : REF_ATTRIBUTE_NAMES.REMAINING_HOME_MOD;
                const allocationRaw = getValueFromItemMulti(item, allocationAttr);
                remainingBalanceAllocationPeriod = (allocationRaw !== null && allocationRaw !== undefined)
                    ? Math.max(0, parseNumberValue(allocationRaw))
                    : Math.max(0, remainingBalanceEndOfMonth + committedFunds);
            }

            // Single remainingBalance: End of Month for HSQ/RCP/EOL; Allocation Period for ATS/ATO/HMB (for table/aggregate)
            const effectiveRemainingBalance = (categoryCode === 'ATS' || categoryCode === 'ATO' || categoryCode === 'HMB')
                ? remainingBalanceAllocationPeriod
                : remainingBalanceEndOfMonth;

            const transformedData = {
                id: item.itemId,
                categoryCode,
                folderName,
                participantName,
                participantProfileId: participantProfileIdValue ? participantProfileIdValue.toString() : null,
                month: monthLabel,
                year: yearLabel,
                quarter: quarterLabel,
                fundingStartDate,
                fundingEndDate,
                totalAvailableBudget,
                availableFundStart,
                quarterlyAdjustment,
                primarySupplementAmount,
                carryoverFunding,
                unspentReturned,
                commonwealthUnspent,
                providerUnspent,
                participantUnspent,
                previousMonthSpending,
                deliveredAmount: deliveredAmountRaw || 0,
                deliveredAmountRaw,
                adjustmentAmount,
                remainingBalance: effectiveRemainingBalance,
                remainingBalanceEndOfMonth,
                ...(remainingBalanceAllocationPeriod !== null && { remainingBalanceAllocationPeriod }),
                primarySupplementLabel,
                fundClassification,
                fundAmount,
                additionalAmountApproved,
                fund,
                committedFunds,
                fundingStreamId: getFirstReferenceId(item, ATTRIBUTE_NAMES.FUNDING_STREAM),
                rawData: item.data || {}
            };

            // Store transformed data in cache for future requests
            setCachedMSBudget(workspaceId, boardId, itemId, transformedData);

            return transformedData;
        };

        // OPTIMIZED: Transform budget items synchronously without rate limiting (like invoice generator endpoint)
        // This eliminates the massive delays from batchProcess rate limiting
        const transformedAllBudgetItems = allBudgetItems.map(transformBudgetItem);

        const normalizeString = (value) => (value || '').toString().trim().toLowerCase().replace(/\.+$/, '');
        const isIdLike = (value) => typeof value === 'string' && value.includes('-');
        const normalizedParticipant = normalizeString(participant);

        const monthLabelLookup = {
            '01': 'January',
            '02': 'February',
            '03': 'March',
            '04': 'April',
            '05': 'May',
            '06': 'June',
            '07': 'July',
            '08': 'August',
            '09': 'September',
            '10': 'October',
            '11': 'November',
            '12': 'December'
        };

        const normalizedMonth = typeof month === 'string' ? month.padStart(2, '0') : null;
        const targetMonthLabel = normalizedMonth && monthLabelLookup[normalizedMonth] ? monthLabelLookup[normalizedMonth] : null;

        const filteredBudgetItems = transformedAllBudgetItems.filter(item => {
            const matchesParticipant = normalizedParticipant
                ? (isIdLike(participant)
                    ? item.participantProfileId === participant
                    : normalizeString(item.participantName) === normalizedParticipant)
                : true;

            const matchesYear = year
                ? normalizeString(item.year) === normalizeString(year)
                : true;

            const matchesMonth = targetMonthLabel
                ? normalizeString(item.month) === normalizeString(targetMonthLabel)
                : true;

            return matchesParticipant && matchesYear && matchesMonth;
        });

        const getCategoryOrderIndex = (code) => {
            const normalizedCode = (code || 'HSQ').toString();
            const idx = BUDGET_CATEGORY_ORDER.indexOf(normalizedCode);
            return idx === -1 ? BUDGET_CATEGORY_ORDER.length : idx;
        };

        filteredBudgetItems.sort((a, b) => {
            const orderDiff = getCategoryOrderIndex(a.categoryCode) - getCategoryOrderIndex(b.categoryCode);
            if (orderDiff !== 0) {
                return orderDiff;
            }
            return (a.folderName || '').localeCompare(b.folderName || '');
        });

        const hasBudgetLimit = budgetLimitParam !== undefined && budgetLimitParam !== null && budgetLimitParam !== '';
        let budgetLimitNumber = hasBudgetLimit ? parseInt(budgetLimitParam, 10) : null;
        if (hasBudgetLimit && (isNaN(budgetLimitNumber) || budgetLimitNumber <= 0)) {
            budgetLimitNumber = 10;
        }
        const budgetPageNumber = hasBudgetLimit
            ? (parseInt(budgetPage, 10) > 0 ? parseInt(budgetPage, 10) : 1)
            : 1;
        const budgetSkip = hasBudgetLimit && budgetLimitNumber
            ? (budgetPageNumber - 1) * budgetLimitNumber
            : 0;
        
        const groupedBudgetItems = filteredBudgetItems.reduce((acc, item) => {
            const folderName = item.folderName || 'Uncategorized';
            if (!acc[folderName]) {
                acc[folderName] = [];
            }
            acc[folderName].push(item);
            return acc;
        }, {});

        const paginatedGroupedBudgetItems = {};
        Object.keys(groupedBudgetItems).forEach(folderName => {
            const itemsInGroup = groupedBudgetItems[folderName];
            const totalItems = itemsInGroup.length;
            const paginatedItems = hasBudgetLimit && budgetLimitNumber
                ? itemsInGroup.slice((budgetPageNumber - 1) * budgetLimitNumber, budgetPageNumber * budgetLimitNumber)
                : itemsInGroup;
            paginatedGroupedBudgetItems[folderName] = {
                items: paginatedItems,
                total: totalItems,
                page: budgetPageNumber,
                limit: budgetLimitNumber || totalItems
            };
        });
        // Fetch service items (second table) from Master Plan,Shift Planning and Reporting using find()
        const serviceFolderIds = await getFolderIdsForQuery('Master Plan,Shift Planning and Reporting');
        const serviceBaseQuery = { workspaceId, boardId };
        if (serviceFolderIds && serviceFolderIds.length > 0) {
            serviceBaseQuery.folderId = { $in: serviceFolderIds };
        }

        let allServiceItems;
        try {
            allServiceItems = await Item.find(serviceBaseQuery).lean();
        } catch (dbErr) {
            error('Items-Service', 'Database query error for service items', {
                message: dbErr.message,
                stack: dbErr.stack,
                workspaceId,
                boardId
            }, req ?? null);
            return res.status(500).json({
                message: 'Error fetching service items for monthly statement',
                error: dbErr.message
            });
        }

        // Helper function to parse number from value
        const parseNumber = (value) => {
            if (value === null || value === undefined) return 0;
            if (typeof value === 'number') return value;
            if (typeof value === 'string') {
                const match = value.match(/-?\d+(?:\.\d+)?/);
                return match ? parseFloat(match[0]) : 0;
            }
            return 0;
        };

        const serviceParticipantProfileIds = new Set();
        const serviceFundingSourceIds = new Set();
        for (const item of allServiceItems) {
            const participantProfileValue = getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const ppId = extractRefId(participantProfileValue);
            if (ppId) serviceParticipantProfileIds.add(ppId);

            const fundingSourceValue = getValueFromItem(item, ATTRIBUTE_NAMES.FUNDING_SOURCE);
            const fsIds = extractAllRefIds(fundingSourceValue);
            fsIds.forEach(id => serviceFundingSourceIds.add(id));
        }

        const earlyRefIds = [...serviceParticipantProfileIds, ...serviceFundingSourceIds];
        const serviceProfilesAndFsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, earlyRefIds);

        const serviceProfilesMap = new Map();
        const fundingSourceRefMap = new Map();
        for (const [key, value] of serviceProfilesAndFsMap) {
            if (serviceParticipantProfileIds.has(key)) serviceProfilesMap.set(key, value);
            if (serviceFundingSourceIds.has(key)) fundingSourceRefMap.set(key, value);
        }

        info('Items-Service', 'Bulk fetched participant profiles and funding sources from DB (monthly-statement service processing)', {
            profileIds: serviceParticipantProfileIds.size,
            foundProfiles: serviceProfilesMap.size,
            fundingSourceIds: serviceFundingSourceIds.size,
            foundFundingSources: fundingSourceRefMap.size
        }, req ?? null);

        // Format transaction status to string (same logic as formatStatus used in transform)
        const formatStatusLabel = (value) => {
            if (!value) return '';
            if (Array.isArray(value) && value.length > 0) {
                return value.map(v => (typeof v === 'object' && v && v.name ? v.name : String(v))).filter(Boolean).join(', ');
            }
            if (typeof value === 'object' && value !== null && value.name) return value.name;
            return String(value);
        };

        // Process and filter service items in JavaScript
        const processedServiceItems = allServiceItems.map(item => {
            const scheduledStart = getValueFromItem(item, ATTRIBUTE_NAMES.SCHEDULED_START);
            const actualEnd = getValueFromItem(item, ATTRIBUTE_NAMES.ACTUAL_END);
            const participantProfileValue = getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const transactionStatusRaw = getValueFromItem(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS);
            const transactionStatusFormatted = formatStatusLabel(transactionStatusRaw);
            const useActualEndForFilter = normalizeString(transactionStatusFormatted) === normalizeString(TRANSACTION_STATUS_USE_ACTUAL_END);
            const scheduledStartDate = parseDate(scheduledStart);
            const actualEndDate = parseDate(actualEnd);
            const filterDate = useActualEndForFilter ? actualEndDate : scheduledStartDate;

            // Get participant name from profile (like invoice generator endpoint)
            let participantName = '';
            const participantId = extractRefId(participantProfileValue);
            if (participantId) {
                const participantProfileItem = serviceProfilesMap.get(participantId);
                if (participantProfileItem) {
                    participantName = getParticipantNameFromProfile(participantProfileItem) || '';
                }
            }
            if (!participantName) {
                participantName = getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
            }

            let fundingSourceResolved = '';
            const fundingSourceValue = getValueFromItem(item, ATTRIBUTE_NAMES.FUNDING_SOURCE);
            const fsIds = extractAllRefIds(fundingSourceValue);
            if (fsIds.length > 0) {
                const fundingSourceNames = [];
                for (const fsId of fsIds) {
                    const fsItem = fundingSourceRefMap.get(fsId);
                    const fsName = getFundingSourceNameFromItem(fsItem);
                    if (fsName) {
                        fundingSourceNames.push(fsName);
                    }
                }
                fundingSourceResolved = fundingSourceNames.join(', ');
            }

            return {
                item,
                scheduledStartDate,
                actualEndDate,
                filterDate,
                participantName: String(participantName),
                participantProfileValue,
                transactionStatusFormatted: transactionStatusFormatted || '',
                fundingSourceResolved: fundingSourceResolved || '',
                totalAmountNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.TOTAL_AMOUNT)),
                govSubsidyNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.GOV_SUBSIDY)),
                participantContributionNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)),
                quantityNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.QUANTITY)),
                unitValue: getValueFromItem(item, ATTRIBUTE_NAMES.UNIT) || ''
            };
        });

        // Apply filters in JavaScript
        let filteredServiceItems = processedServiceItems;

        if (participant) {
            try {
                const participantRegex = new RegExp(participant, 'i');
                filteredServiceItems = filteredServiceItems.filter(p =>
                    participantRegex.test(p.participantName) ||
                    (p.participantProfileValue && (
                        (typeof p.participantProfileValue === 'string' && participantRegex.test(p.participantProfileValue)) ||
                        (Array.isArray(p.participantProfileValue) && p.participantProfileValue.some(v => participantRegex.test(String(v)))) ||
                        (typeof p.participantProfileValue === 'object' && p.participantProfileValue.id && participantRegex.test(String(p.participantProfileValue.id)))
                    ))
                );
            } catch (regexErr) {
                warn('Items-Service', 'Invalid participant regex pattern', {
                    pattern: participant,
                    error: regexErr.message
                }, req ?? null);
            }
        }

        if (startDate) {
            const startDateObj = new Date(startDate);
            filteredServiceItems = filteredServiceItems.filter(p =>
                p.filterDate && p.filterDate >= startDateObj
            );
        }

        if (endDate) {
            const endDateObj = new Date(endDate);
            filteredServiceItems = filteredServiceItems.filter(p =>
                p.filterDate && p.filterDate <= endDateObj
            );
        }

        // Collect distinct transaction statuses for filter dropdown (before applying transaction status filter)
        const distinctTransactionStatuses = [...new Set(
            filteredServiceItems
                .map(p => p.transactionStatusFormatted)
                .filter(Boolean)
        )].sort();

        const distinctFundingSources = [...new Set(
            filteredServiceItems
                .map(p => p.fundingSourceResolved)
                .filter(Boolean)
        )].sort();

        if (fundingSourceFilter && fundingSourceFilter !== 'all') {
            const fsFilterValue = String(fundingSourceFilter).trim();
            filteredServiceItems = filteredServiceItems.filter(p =>
                p.fundingSourceResolved && p.fundingSourceResolved === fsFilterValue
            );
        }

        if (serviceTransactionStatusFilter && String(serviceTransactionStatusFilter).trim() !== '' && String(serviceTransactionStatusFilter).toLowerCase() !== 'all') {
            const filterValue = String(serviceTransactionStatusFilter).trim();
            filteredServiceItems = filteredServiceItems.filter(p =>
                p.transactionStatusFormatted && p.transactionStatusFormatted === filterValue
            );
        }

        // Sort service items (by date column if requested, else by updatedAt)
        const sortByDate = serviceSortBy === 'scheduledServiceDate' || serviceSortBy === 'serviceDeliveryDate';
        const useDeliveryDate = serviceSortBy === 'serviceDeliveryDate';
        filteredServiceItems.sort((a, b) => {
            if (sortByDate) {
                const aDate = useDeliveryDate ? a.actualEndDate : a.scheduledStartDate;
                const bDate = useDeliveryDate ? b.actualEndDate : b.scheduledStartDate;
                if (!aDate && !bDate) return 0;
                if (!aDate) return 1;
                if (!bDate) return -1;
                // Use getTime() for reliable Date comparison
                const aTime = aDate instanceof Date ? aDate.getTime() : aDate;
                const bTime = bDate instanceof Date ? bDate.getTime() : bDate;
                const cmp = aTime < bTime ? -1 : (aTime > bTime ? 1 : 0);
                return serviceSortOrder === 'desc' ? -cmp : cmp;
            }
            const aUpdated = a.item.updatedAt || a.item.createdAt || new Date(0);
            const bUpdated = b.item.updatedAt || b.item.createdAt || new Date(0);
            const aUpdTime = aUpdated instanceof Date ? aUpdated.getTime() : new Date(aUpdated).getTime();
            const bUpdTime = bUpdated instanceof Date ? bUpdated.getTime() : new Date(bUpdated).getTime();
            if (aUpdTime < bUpdTime) return 1;
            if (aUpdTime > bUpdTime) return -1;
            return 0;
        });

        const serviceTotal = filteredServiceItems.length;

        // Apply pagination
        const hasServiceLimit = serviceLimitParam !== undefined && serviceLimitParam !== null && serviceLimitParam !== '';
        let serviceLimitNumber = hasServiceLimit ? parseInt(serviceLimitParam, 10) : null;
        if (hasServiceLimit && (isNaN(serviceLimitNumber) || serviceLimitNumber <= 0)) {
            serviceLimitNumber = 10;
        }
        const servicePageNumber = hasServiceLimit
            ? (parseInt(servicePage, 10) > 0 ? parseInt(servicePage, 10) : 1)
            : 1;
        const serviceSkip = hasServiceLimit && serviceLimitNumber
            ? (servicePageNumber - 1) * serviceLimitNumber
            : 0;
        const paginatedServiceItems = hasServiceLimit && serviceLimitNumber
            ? filteredServiceItems.slice(serviceSkip, serviceSkip + serviceLimitNumber)
            : filteredServiceItems;

        const serviceItems = paginatedServiceItems.map(p => p.item);

        // DATABASE-ONLY: Bulk fetch all reference items for service items before transformation
        const msServicePlanIds = new Set();
        const msParticipantProfileIds = new Set();
        const msFundingSourceIds = new Set();
        const msAssociatedProviderIds = new Set();

        for (const item of serviceItems) {
            const getValue = (attributeName) => {
                if (!item.data) return null;
                return item.data[attributeName] ?? null;
            };

            // Service plan ID
            const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
            const spId = extractRefId(servicePlanId);
            if (spId) msServicePlanIds.add(spId);

            // Participant profile ID
            const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const ppId = extractRefId(participantProfileValue);
            if (ppId) msParticipantProfileIds.add(ppId);

            // Funding source IDs
            const fundingSourceValue = getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE);
            const fsIds = extractAllRefIds(fundingSourceValue);
            fsIds.forEach(id => msFundingSourceIds.add(id));

            // Associated provider ID (reference item for Business/Individual)
            const associatedProviderValue = getValue(ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER);
            const apId = extractRefId(associatedProviderValue);
            if (apId) msAssociatedProviderIds.add(apId);
        }

        // Bulk fetch ALL service reference items from database in a single query
        // Filter out participant profiles we already fetched to avoid duplicate queries
        const msParticipantProfileIdsToFetch = [...msParticipantProfileIds].filter(id => !serviceProfilesMap.has(id));
        const msAllRefIds = [...msServicePlanIds, ...msParticipantProfileIdsToFetch, ...msFundingSourceIds, ...msAssociatedProviderIds];
        const msRefItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, msAllRefIds);
        
        // Merge already-fetched participant profiles into the reference map
        for (const [key, value] of serviceProfilesMap) {
            msRefItemsMap.set(key, value);
        }

        info('Items-Service', 'Bulk fetched reference items from DB (monthly-statement service)', {
            servicePlans: msServicePlanIds.size,
            participantProfiles: msParticipantProfileIds.size,
            participantProfilesAlreadyFetched: serviceProfilesMap.size,
            participantProfilesNewlyFetched: msParticipantProfileIdsToFetch.length,
            fundingSources: msFundingSourceIds.size,
            totalFound: msRefItemsMap.size
        }, req ?? null);

        // Format label value from flat data format
        const formatStatus = (value) => {
            if (!value) return undefined;

            // Handle array of labels
            if (Array.isArray(value) && value.length > 0) {
                return value.map(item => {
                    if (typeof item === 'object' && item.name) {
                        return item.name;
                    }
                    return String(item);
                }).filter(Boolean).join(', ');
            }

            // Handle single label object
            if (typeof value === 'object' && value.name) {
                return value.name;
            }

            // Handle string
            if (typeof value === 'string') {
                return value;
            }

            return String(value);
        };

        const isPrimarySupplementOrUnspentHcp = (name) => {
            const n = (name || '').toLowerCase();
            return n.includes('primary supplement') || n.includes('unspent home care package') || n.includes('unspent hcp');
        };

        // OPTIMIZED: Transform service items synchronously without rate limiting (like invoice generator endpoint)
        // This eliminates the massive delays from batchProcess rate limiting
        const transformedServiceItems = serviceItems.map((item) => {
            const itemId = item.itemId;
            const itemUpdatedAt = item.updatedAt || item.createdAt;

            // Check if transformed data is already in cache (synchronous check)
            const cachedData = getCachedMSService(workspaceId, boardId, itemId, itemUpdatedAt);
            if (cachedData) {
                return cachedData;
            }

            // Get value from flat data format
            const getValue = (attributeName) => {
                if (!item.data) return null;
                return item.data[attributeName] ?? null;
            };

            // DATABASE-ONLY: Get participant name from participant profile in lookup map
            let participantName = getValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
            const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const participantProfileId = extractRefId(participantProfileValue);

            if (participantProfileId) {
                const participantProfileItem = msRefItemsMap.get(participantProfileId);
                const profileName = getParticipantNameFromProfile(participantProfileItem);
                if (profileName) {
                    participantName = profileName;
                }
            }

            // DATABASE-ONLY: Get Service from service plan in lookup map
            const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
            const servicePlanRefId = extractRefId(servicePlanId);
            const servicePlanItem = servicePlanRefId ? msRefItemsMap.get(servicePlanRefId) : null;

            let service = getServiceFromServicePlan(servicePlanItem);

            // Get Service Provider and Delivered By (single computation for both)
            const deliveredByRaw = getValue(ATTRIBUTE_NAMES.DELIVERED_BY);
            const deliveredByName = deliveredByRaw == null
                ? null
                : (typeof deliveredByRaw === 'object' ? (deliveredByRaw.name || deliveredByRaw.toString()) : String(deliveredByRaw));
            let serviceProvider = undefined;
            if (deliveredByName && typeof deliveredByName === 'string') {
                const deliveredByLower = deliveredByName.toLowerCase();
                if (deliveredByLower.includes('company workforce')) {
                    serviceProvider = businessProfile?.name || undefined;
                } else if (deliveredByLower.includes('associated')) {
                    const apRefId = extractRefId(getValue(ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER));
                    const providerRefItem = apRefId ? msRefItemsMap.get(apRefId) : null;
                    const businessIndividual = providerRefItem ? getValueFromFlatData(providerRefItem, 'Business/Individual') : null;
                    serviceProvider = (businessIndividual != null && businessIndividual !== '')
                        ? (typeof businessIndividual === 'object' && businessIndividual.name ? businessIndividual.name : String(businessIndividual))
                        : (apRefId || undefined);
                }
            }
            // Get dates
            const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START) || null;
            const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END) || null;
            // Return raw ISO datetime strings so the frontend can format them in the user's local timezone
            const scheduledServiceDate = scheduledStart || null;
            const serviceDeliveryDate = actualEnd || null;

            // Get Transaction Status from flat data format
            const transactionStatusValue = getValue(ATTRIBUTE_NAMES.TRANSACTION_STATUS);
            const transactionStatus = formatStatus(transactionStatusValue);
            const committedAtHm = getValue(ATTRIBUTE_NAMES.COMMITTED_AT_HM);
            const committedAtHmForDelivery = committedAtHm !== null && committedAtHm !== undefined
                ? (typeof committedAtHm === 'number' ? committedAtHm : Number(committedAtHm) || 0)
                : undefined;
            const unit = getValue(ATTRIBUTE_NAMES.UNIT) || 'Hour';
            const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;
            const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
            const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
            const govSubsidy = Number(getValue(ATTRIBUTE_NAMES.GOV_SUBSIDY)) || 0;
            const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;

            // DATABASE-ONLY: Get Service Category from Service Plan (for Funding Source items 7 & 8: Primary Supplements / Unspent HCP)
            const serviceCategoryRaw = servicePlanItem ? getValueFromFlatData(servicePlanItem, ['Service Category', ATTRIBUTE_NAMES.SERVICE_CATEGORY]) : null;
            const serviceCategory = serviceCategoryRaw
                ? (typeof serviceCategoryRaw === 'object' && serviceCategoryRaw.name ? serviceCategoryRaw.name : String(serviceCategoryRaw).trim())
                : '';

            // DATABASE-ONLY: Get Funding Source names from pre-fetched lookup map
            let fundingSource;
            const fundingSourceData = getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE);
            if (fundingSourceData) {
                const fsIds = extractAllRefIds(fundingSourceData);
                const fundingSourceNames = [];
                for (const fsId of fsIds) {
                    const fsItem = msRefItemsMap.get(fsId);
                    let fsName = getFundingSourceNameFromItem(fsItem);
                    if (fsName) {
                        if (serviceCategory && isPrimarySupplementOrUnspentHcp(fsName)) {
                            fsName = `${fsName} - ${stripEmojiFromFundingSource(serviceCategory)}`;
                        }
                        fundingSourceNames.push(fsName);
                    }
                }

                fundingSource = fundingSourceNames.length > 0 ? fundingSourceNames.join(', ') : undefined;
            }

            const notes = getValue(ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';

            // Get allocated time if available
            const allocatedTimeValue = getValue(ATTRIBUTE_NAMES.ALLOCATED_TIME);
            const allocatedTime = allocatedTimeValue !== null && allocatedTimeValue !== undefined
                ? (typeof allocatedTimeValue === 'number' ? allocatedTimeValue : Number(allocatedTimeValue) || 0)
                : undefined;

            const transformedData = {
                participant: participantName,
                service,
                serviceProvider,
                deliveredBy: deliveredByName,
                scheduledStart,
                scheduledServiceDate,
                scheduledShiftStart: scheduledStart,
                scheduledShiftStartDateTime: scheduledStart,
                actualEnd,
                actualShiftEndDateTime: actualEnd,
                serviceDeliveryDate,
                transactionStatus,
                committedAtHmForDelivery,
                unit,
                quantity,
                unitPrice,
                totalAmount,
                govSubsidy,
                participantContribution,
                fundingSource,
                notes,
                allocatedTime
            };

            // Store transformed data in cache for future requests
            setCachedMSService(workspaceId, boardId, itemId, transformedData);

            return transformedData;
        });

        const budgetCategoryAggregates = {};
        const createBudgetAggregate = () => ({
            availableFunds: 0,
            remainingBudget: 0,
            remainingBalanceAllocationPeriod: 0,
            remainingBalanceEndOfMonth: 0,
            serviceDeliveredAmount: 0,
            serviceDeliveredAmountRaw: 0,
            adjustmentAmount: 0,
            govSubsidyAmount: 0,
            participantContributionAmount: 0,
            committedFunds: 0,
            serviceCount: 0,
            fundingStartDate: null,
            fundingEndDate: null,
            months: new Set(),
            availableFundStart: 0,
            quarterlyAdjustment: 0,
            primarySupplementAmount: 0,
            carryoverFunding: 0,
            unspentReturned: 0,
            commonwealthUnspent: 0,
            providerUnspent: 0,
            participantUnspent: 0,
            previousMonthSpending: 0,
            fundAmount: 0,
            additionalAmountApproved: 0,
            shouldDisplay: false,
            hscmTotalAllocatedTime: 0,
            hscmTotalReceivedAmount: 0,
            hscmTotalAllocatedAmount: 0,
            hscmItemCount: 0
        });

        // Calculate summary from all filtered service items (before pagination) - following invoice generator pattern
        const summaryTotals = filteredServiceItems.reduce((acc, p) => {
            const quantity = p.quantityNum || 0;
            const totalAmount = p.totalAmountNum || 0;
            const gov = p.govSubsidyNum || 0;
            const participantContribution = p.participantContributionNum || 0;
            const unit = (p.unitValue || '').toString().toLowerCase();
            const hours = unit.includes('hour') ? quantity : 0;
            return {
                totalServices: acc.totalServices + 1,
                totalHours: acc.totalHours + hours,
                totalAmount: acc.totalAmount + totalAmount,
                govSubsidy: acc.govSubsidy + gov,
                participantContribution: acc.participantContribution + participantContribution
            };
        }, { totalServices: 0, totalHours: 0, totalAmount: 0, govSubsidy: 0, participantContribution: 0 });

        // Calculate budget category aggregates from all filtered service items (before pagination)
        filteredServiceItems.forEach(p => {
            // We need to determine category code, but we don't have the transformed service yet
            // So we'll calculate it from the item data
            const fundingSourceValue = getValueFromItem(p.item, ATTRIBUTE_NAMES.FUNDING_SOURCE);
            const serviceValue = getValueFromItem(p.item, ATTRIBUTE_NAMES.SERVICE_PLAN);
            const notesValue = getValueFromItem(p.item, ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';

            // Determine category code from item data
            const normalize = (value) => {
                if (Array.isArray(value)) {
                    return value.map(v => String(v || '')).join(' ').toLowerCase();
                }
                return (value || '').toString().toLowerCase();
            };
            const fundingSourceStr = normalize(fundingSourceValue);
            const notesStr = normalize(notesValue);
            const haystack = `${fundingSourceStr} ${notesStr}`;

            let code = 'HSQ';
            if (haystack.includes('restorative care')) {
                code = 'RCP';
            } else if (haystack.includes('end-of-life') || haystack.includes('end of life')) {
                code = 'EOL';
            } else if (haystack.includes('assistive') && haystack.includes('short')) {
                code = 'ATS';
            } else if (haystack.includes('assistive') && haystack.includes('ongoing')) {
                code = 'ATO';
            } else if (haystack.includes('modification')) {
                code = 'HMB';
            } else if (haystack.includes('home support') || haystack.includes('hsq')) {
                code = 'HSQ';
            }

            if (!budgetCategoryAggregates[code]) {
                budgetCategoryAggregates[code] = createBudgetAggregate();
            }
            const aggregate = budgetCategoryAggregates[code];
            aggregate.govSubsidyAmount += p.govSubsidyNum || 0;
            aggregate.participantContributionAmount += p.participantContributionNum || 0;
            aggregate.serviceCount += 1;
        });

        const summary = {
            ...summaryTotals,
            averageServiceCost: summaryTotals.totalServices > 0
                ? summaryTotals.totalAmount / summaryTotals.totalServices
                : 0
        };

        const budgetTotal = filteredBudgetItems.length;

        filteredBudgetItems.forEach(item => {
            const code = item.categoryCode || 'HSQ';
            if (!budgetCategoryAggregates[code]) {
                budgetCategoryAggregates[code] = createBudgetAggregate();
            }

            const aggregate = budgetCategoryAggregates[code];
            aggregate.availableFunds += item.totalAvailableBudget || 0;
            aggregate.remainingBudget += item.remainingBalance || 0;
            if (code === 'ATS' || code === 'ATO' || code === 'HMB') {
                aggregate.remainingBalanceAllocationPeriod += (item.remainingBalanceAllocationPeriod ?? item.remainingBalance) || 0;
                aggregate.remainingBalanceEndOfMonth += item.remainingBalanceEndOfMonth || 0;
            }
            aggregate.serviceDeliveredAmount += item.deliveredAmount || 0;
            aggregate.serviceDeliveredAmountRaw += item.deliveredAmountRaw || 0;
            aggregate.adjustmentAmount += item.adjustmentAmount || 0;
            aggregate.govSubsidyAmount += item.govSubsidyAmount || 0;
            aggregate.participantContributionAmount += item.participantContributionAmount || 0;
            aggregate.committedFunds += item.committedFunds || 0;
            aggregate.availableFundStart += item.availableFundStart || 0;
            aggregate.quarterlyAdjustment += item.quarterlyAdjustment || 0;
            aggregate.primarySupplementAmount += item.primarySupplementAmount || 0;
            aggregate.carryoverFunding += item.carryoverFunding || 0;
            aggregate.unspentReturned += item.unspentReturned || 0;
            aggregate.commonwealthUnspent += item.commonwealthUnspent || 0;
            aggregate.providerUnspent += item.providerUnspent || 0;
            aggregate.participantUnspent += item.participantUnspent || 0;
            aggregate.previousMonthSpending += item.previousMonthSpending || 0;
            aggregate.fundAmount += item.fundAmount || 0;
            aggregate.additionalAmountApproved += item.additionalAmountApproved || 0;

            // Track HSCM-specific aggregates
            if (code === 'HSCM') {
                aggregate.hscmTotalAllocatedTime += item.hscmAllocatedTime || 0;
                aggregate.hscmTotalReceivedAmount += item.hscmReceivedAmount || 0;
                aggregate.hscmTotalAllocatedAmount += item.hscmAllocatedAmount || 0;
                aggregate.hscmItemCount += 1;
            }

            if (item.fundingStartDate) {
                if (!aggregate.fundingStartDate || new Date(item.fundingStartDate) < new Date(aggregate.fundingStartDate)) {
                    aggregate.fundingStartDate = item.fundingStartDate;
                }
            }

            if (item.fundingEndDate) {
                if (!aggregate.fundingEndDate || new Date(item.fundingEndDate) > new Date(aggregate.fundingEndDate)) {
                    aggregate.fundingEndDate = item.fundingEndDate;
                }
            }

            const monthLabel = item.month ? (item.year ? `${item.month} ${item.year}` : item.month) : (item.year || null);
            if (monthLabel) {
                aggregate.months.add(monthLabel);
            }
        });

        Object.values(budgetCategoryAggregates).forEach(aggregate => {
            if (aggregate.months && aggregate.months.size > 0) {
                aggregate.expenditurePeriodLabel = Array.from(aggregate.months).join(', ');
            }
            if (aggregate.fundingStartDate || aggregate.fundingEndDate) {
                aggregate.availableBalanceRangeLabel = [aggregate.fundingStartDate, aggregate.fundingEndDate].filter(Boolean).join(' - ');
            }
            const visibilityFields = [
                aggregate.availableFunds,
                aggregate.remainingBudget,
                aggregate.serviceDeliveredAmount,
                aggregate.adjustmentAmount,
                aggregate.committedFunds,
                aggregate.previousMonthSpending,
                aggregate.fundAmount,
                aggregate.hscmTotalAllocatedTime,
                aggregate.hscmTotalReceivedAmount,
                aggregate.hscmTotalAllocatedAmount,
                aggregate.hscmItemCount
            ];
            aggregate.shouldDisplay = visibilityFields.some(value => Math.abs(value || 0) > 0.009);
            delete aggregate.months;
        });

        let participantProfileId = filteredBudgetItems.find(item => item.participantProfileId)?.participantProfileId || null;
        if (!participantProfileId) {
            participantProfileId = transformedServiceItems.find(service => service.participantProfileId)?.participantProfileId || null;
        }
        if (!participantProfileId) {
            // In flat data format, look for Participant Profile directly
            const rawServiceWithProfile = allServiceItems.find(rawItem =>
                rawItem?.data?.[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]
            );
            if (rawServiceWithProfile) {
                const profileValue = rawServiceWithProfile.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE];
                if (Array.isArray(profileValue) && profileValue.length > 0) {
                    participantProfileId = profileValue[0].toString();
                } else if (profileValue) {
                    participantProfileId = profileValue.toString();
                }
            }
        }

        const extractProfileString = (value) => {
            if (value === null || value === undefined) {
                return '';
            }
            if (typeof value === 'object' && value.name) {
                return value.name;
            }
            return value.toString ? value.toString() : '';
        };

        let participantProfileValues = null;
        let participantFullName = typeof participant === 'string' ? participant : '';
        let participantAddress = '';
        let participantSuburb = '';
        let participantState = '';
        let participantPostcode = '';
        let myAgedCareIdNumber = '';
        let providerIdFromProfile = '';

        // DATABASE-ONLY: Get participant profile from bulk fetched reference items
        // Check both service items map and budget items map
        if (participantProfileId) {
            participantProfileValues = msRefItemsMap.get(participantProfileId) || budgetProfilesMap.get(participantProfileId);
        }

        if (participantProfileValues) {
            // Helper to get value from participant profile using getValueFromFlatData
            const getProfileValue = (attributeName) => {
                const value = getValueFromFlatData(participantProfileValues, attributeName);
                if (!value) return '';
                return extractProfileString(value);
            };

            participantFullName = getProfileValue(ATTRIBUTE_NAMES.FULL_NAME) ||
                getProfileValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) ||
                participantFullName;
            participantAddress = getProfileValue(ATTRIBUTE_NAMES.ADDRESS) || participantAddress;
            participantSuburb = getProfileValue(ATTRIBUTE_NAMES.SUBURB) || participantSuburb;

            // Handle state field - may be a label/object
            const stateValue = getValueFromFlatData(participantProfileValues, ATTRIBUTE_NAMES.STATE);
            if (stateValue) {
                if (typeof stateValue === 'object' && stateValue.name) {
                    participantState = stateValue.name;
                } else if (typeof stateValue === 'string') {
                    participantState = stateValue;
                } else if (Array.isArray(stateValue) && stateValue.length > 0) {
                    const first = stateValue[0];
                    participantState = typeof first === 'object' && first.name ? first.name : String(first);
                }
            }

            participantPostcode = getProfileValue(ATTRIBUTE_NAMES.POSTCODE) ||
                getProfileValue(ATTRIBUTE_NAMES.POST_CODE) ||
                participantPostcode;
            myAgedCareIdNumber = getProfileValue(ATTRIBUTE_NAMES.MY_AGED_CARE_ID) ||
                getProfileValue(ATTRIBUTE_NAMES.MY_AGED_CARE_ID_ALT) ||
                myAgedCareIdNumber;
            providerIdFromProfile = getProfileValue(ATTRIBUTE_NAMES.PROVIDER_ID) || providerIdFromProfile;
        }

        // DATABASE-ONLY: Fetch budget data from participant profile funding streams
        let budgetDataFromProfile = null;
        if (participantProfileId) {
            try {
                // Get participant profile item from database
                const participantProfileItem = await Item.findOne({
                    workspaceId,
                    boardId,
                    itemId: participantProfileId
                }).lean();

                if (participantProfileItem && participantProfileItem.data) {
                    // Extract funding source references from participant profile
                    const fundingSourceValue = getValueFromFlatData(participantProfileItem, ATTRIBUTE_NAMES.FUNDING_SOURCE);
                    const fundingSourceIds = extractAllRefIds(fundingSourceValue);

                    if (fundingSourceIds.length > 0) {
                        // Bulk fetch funding stream items from database
                        const fundingStreamItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, fundingSourceIds);

                        // Extract budget data from funding stream items
                        budgetDataFromProfile = {
                            homeSupport: null,
                            restorativeCare: null,
                            endOfLife: null,
                            assistiveTechShortTerm: null,
                            assistiveTechOngoing: null,
                            homeModification: null
                        };

                        for (const fsId of fundingSourceIds) {
                            const fsItem = fundingStreamItemsMap.get(fsId);
                            if (!fsItem || !fsItem.data) continue;

                            const fsName = getFundingSourceNameFromItem(fsItem);
                            if (!fsName) continue;

                            const getValue = (attrName) => {
                                const value = getValueFromFlatData(fsItem, attrName);
                                if (!value) return null;
                                if (attrName.includes('Date') && value) {
                                    return value.toString();
                                }
                                if (typeof value === 'number') return value;
                                if (typeof value === 'string' && value.includes('$')) {
                                    return parseFloat(value.replace(/[^0-9.-]/g, '')) || 0;
                                }
                                return parseFloat(value) || 0;
                            };

                            const fsNameLower = fsName.toLowerCase();
                            if (fsNameLower.includes('home support') || fsNameLower.includes('hs')) {
                                budgetDataFromProfile.homeSupport = {
                                    totalAvailableBudget: getValue('Total Available Budget for Home Support ($)') ||
                                        getValue('Remaining Home Support Balance as at the End of the Month ($)') || 0,
                                    remainingBalance: getValue('Remaining Home Support Balance as at the End of the Month ($)') || 0,
                                    fundingEndDate: getValue('Funding End Date') || null,
                                    availableFundStart: getValue(ATTRIBUTE_NAMES.AVAILABLE_FUND_START) || 0,
                                    quarterlyAdjustment: getValue(ATTRIBUTE_NAMES.QUARTERLY_ADJUSTMENT) || 0,
                                    primarySupplementAmount: getValue(ATTRIBUTE_NAMES.PRIMARY_SUPPLEMENT_AMOUNT) || 0,
                                    carryoverFunding: getValue(ATTRIBUTE_NAMES.CARRYOVER_FUNDING) || 0,
                                    unspentReturned: getValue(ATTRIBUTE_NAMES.UNSPENT_BUDGET_RETURNED) || 0,
                                    commonwealthUnspent: getValue(ATTRIBUTE_NAMES.COMMONWEALTH_UNSPENT_FUNDS) || 0,
                                    providerUnspent: getValue(ATTRIBUTE_NAMES.PROVIDER_UNSPENT_FUNDS) || 0,
                                    participantUnspent: getValue(ATTRIBUTE_NAMES.PARTICIPANT_UNSPENT_FUNDS) || 0,
                                    previousMonthSpending: getValue(ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING) || 0,
                                    fundAmount: getValue(ATTRIBUTE_NAMES.FUND_AMOUNT) || 0
                                };
                            } else if (fsNameLower.includes('restorative care')) {
                                budgetDataFromProfile.restorativeCare = {
                                    totalAvailableBudget: getValue('Total Available Budget for Restorative Care ($)') || 0,
                                    remainingBalance: getValue(REF_ATTRIBUTE_NAMES.REMAINING_RESTORATIVE_END_OF_MONTH) || 0,
                                    fundingEndDate: getValue('Funding End Date') || null
                                };
                            } else if (fsNameLower.includes('end-of-life') || fsNameLower.includes('end of life')) {
                                budgetDataFromProfile.endOfLife = {
                                    totalAvailableBudget: getValue('Total Available Budget for End-of-Life Care ($)') || 0,
                                    remainingBalance: getValue(REF_ATTRIBUTE_NAMES.REMAINING_END_OF_LIFE_END_OF_MONTH) || 0,
                                    fundingEndDate: getValue('Funding End Date') || null
                                };
                            } else if (fsNameLower.includes('assistive') && fsNameLower.includes('short')) {
                                budgetDataFromProfile.assistiveTechShortTerm = {
                                    totalAvailableBudget: getValue('Total Available Budget for Assistive Technology - Short-term ($)') || 0,
                                    remainingBalance: getValue('Remaining AT - Short-term Balance for Allocation Period ($)') || 0,
                                    fundingEndDate: getValue('Funding End Date') || null,
                                    committedFunds: getValue('Committed AT Short-term Funds - to be delivered ($-)') || 0
                                };
                            } else if (fsNameLower.includes('assistive') && fsNameLower.includes('ongoing')) {
                                budgetDataFromProfile.assistiveTechOngoing = {
                                    totalAvailableBudget: getValue('Total Available Budget for Assistive Technology - Ongoing ($)') || 0,
                                    remainingBalance: getValue('Remaining AT - Ongoing Balance for Allocation Period ($)') || 0,
                                    fundingEndDate: getValue('Funding End Date') || null,
                                    committedFunds: getValue('Committed AT Ongoing Funds - to be delivered ($-)') || 0
                                };
                            } else if (fsNameLower.includes('modification')) {
                                budgetDataFromProfile.homeModification = {
                                    totalAvailableBudget: getValue('Total Available Budget for Home Modification ($)') || 0,
                                    remainingBalance: getValue('Remaining HM Balance for Allocation Period ($)') || 0,
                                    fundingEndDate: getValue('Funding End Date') || null,
                                    committedFunds: getValue('Committed HM Funds - to be delivered ($-)') || 0
                                };
                            }
                        }
                    }
                }
            } catch (err) {
                warn('Items-Service', 'Failed to fetch budget data from profile', {
                    message: err.message,
                    participantProfileId
                }, req ?? null);
            }
        }

        const getQuarterMonths = (monthNum) => {
            const numericMonth = parseInt(monthNum, 10) || 1;
            if (numericMonth >= 1 && numericMonth <= 3) return { start: 'January', end: 'March' };
            if (numericMonth >= 4 && numericMonth <= 6) return { start: 'April', end: 'June' };
            if (numericMonth >= 7 && numericMonth <= 9) return { start: 'July', end: 'September' };
            return { start: 'October', end: 'December' };
        };

        const monthNum = parseInt(month, 10) || 1;
        const yearStr = (year || new Date().getFullYear().toString()).toString();
        const quarterMonths = getQuarterMonths(monthNum);
        const defaultFundingEndDate = new Date(parseInt(yearStr, 10), 11, 31).toISOString();

        const budgetCategories = BUDGET_CATEGORY_CONFIG.map(config => {
            const profileData = budgetDataFromProfile?.[config.profileKey] || {};
            const budgetAggregate = budgetCategoryAggregates[config.code] || createBudgetAggregate();

            const categoryName = config.code === 'HSQ'
                ? `Home Support Quarterly Budget ${quarterMonths.start} ~ ${quarterMonths.end} ${yearStr}`
                : config.folderName;

            // For ATS/ATO/HMB, funding end date must be dynamic (from budget rows for selected month only)
            const useDynamicFundingEndDate = ['ATS', 'ATO', 'HMB'].includes(config.code);
            const fundingEndDate = useDynamicFundingEndDate
                ? (budgetAggregate.fundingEndDate || null)
                : (budgetAggregate.fundingEndDate || profileData.fundingEndDate || defaultFundingEndDate);
            // For ATS/ATO/HMB, blue bar uses "Remaining ... Balance for Allocation Period" (calculated per formula)
            const remainingBalanceAllocationPeriod = ['ATS', 'ATO', 'HMB'].includes(config.code)
                ? (budgetAggregate.remainingBalanceAllocationPeriod ?? budgetAggregate.remainingBudget ?? profileData.remainingBalance ?? 0)
                : undefined;
            // For ATS/ATO/HMB: also expose remaining as at end of selected month
            const remainingBalanceEndOfMonth = ['ATS', 'ATO', 'HMB'].includes(config.code)
                ? (budgetAggregate.remainingBalanceEndOfMonth ?? 0)
                : undefined;

            return {
                name: categoryName,
                code: config.code,
                availableFunds: budgetAggregate.availableFunds || profileData.totalAvailableBudget || 0,
                remainingBudget: budgetAggregate.remainingBudget || profileData.remainingBalance || 0,
                ...(remainingBalanceAllocationPeriod !== undefined && { remainingBalanceAllocationPeriod }),
                ...(remainingBalanceEndOfMonth !== undefined && { remainingBalanceEndOfMonth }),
                fundingEndDate,
                committedFunds: budgetAggregate.committedFunds || profileData.committedFunds || 0,
                serviceDeliveredAmount: budgetAggregate.serviceDeliveredAmount || 0,
                serviceDeliveredAmountRaw: budgetAggregate.serviceDeliveredAmountRaw || 0,
                govSubsidyAmount: budgetAggregate.govSubsidyAmount || 0,
                participantContributionAmount: budgetAggregate.participantContributionAmount || 0,
                adjustmentAmount: budgetAggregate.adjustmentAmount || 0,
                serviceCount: budgetAggregate.serviceCount || 0,
                quarterStartMonth: config.code === 'HSQ' ? quarterMonths.start : undefined,
                quarterEndMonth: config.code === 'HSQ' ? quarterMonths.end : undefined,
                availableBalanceRangeLabel: budgetAggregate.availableBalanceRangeLabel || undefined,
                expenditurePeriodLabel: budgetAggregate.expenditurePeriodLabel || undefined,
                availableFundStart: budgetAggregate.availableFundStart || profileData.availableFundStart || 0,
                quarterlyAdjustment: budgetAggregate.quarterlyAdjustment || profileData.quarterlyAdjustment || 0,
                primarySupplementAmount: budgetAggregate.primarySupplementAmount || profileData.primarySupplementAmount || 0,
                carryoverFunding: budgetAggregate.carryoverFunding || profileData.carryoverFunding || 0,
                unspentReturned: budgetAggregate.unspentReturned || profileData.unspentReturned || 0,
                commonwealthUnspent: budgetAggregate.commonwealthUnspent || profileData.commonwealthUnspent || 0,
                providerUnspent: budgetAggregate.providerUnspent || profileData.providerUnspent || 0,
                participantUnspent: budgetAggregate.participantUnspent || profileData.participantUnspent || 0,
                previousMonthSpending: budgetAggregate.previousMonthSpending || profileData.previousMonthSpending || 0,
                fundAmount: budgetAggregate.fundAmount || profileData.fundAmount || 0,
                additionalAmountApproved: budgetAggregate.additionalAmountApproved ?? profileData.additionalAmountApproved ?? 0,
                shouldDisplay: Boolean(budgetAggregate.shouldDisplay),
                ...(config.code === 'HSCM' && {
                    hscmTotalAllocatedTime: budgetAggregate.hscmTotalAllocatedTime || 0,
                    hscmTotalReceivedAmount: budgetAggregate.hscmTotalReceivedAmount || 0,
                    hscmTotalAllocatedAmount: budgetAggregate.hscmTotalAllocatedAmount || 0,
                    hscmItemCount: budgetAggregate.hscmItemCount || 0
                }),
                deliveredAmount: budgetAggregate.serviceDeliveredAmount || 0,
                totalAvailableBudget: budgetAggregate.availableFunds || profileData.totalAvailableBudget || 0
            };
        });

        const providerIdValue = businessProfile?.companyRegistrationId || providerIdFromProfile || null;
        const monthLabelForResponse = targetMonthLabel ||
            (normalizedMonth && monthLabelLookup[normalizedMonth]) ||
            normalizedMonth ||
            '';
        const monthNumberForResponse = normalizedMonth || (typeof month === 'string' ? month : '');
        const participantNameForResponse = participantFullName || (typeof participant === 'string' ? participant : '');

        res.status(200).json({
            budgetItems: {
                items: paginatedGroupedBudgetItems,
                total: budgetTotal,
                page: budgetPageNumber,
                limit: budgetLimitNumber || budgetTotal
            },
            serviceItems: {
                items: transformedServiceItems,
                total: serviceTotal,
                page: servicePageNumber,
                limit: serviceLimitNumber,
                distinctTransactionStatuses: distinctTransactionStatuses,
                distinctFundingSources: distinctFundingSources
            },
            budgetCategories,
            participant: participantNameForResponse,
            participantProfile: participantNameForResponse,
            participantAddress,
            participantSuburb,
            participantState,
            participantPostcode,
            myAgedCareIdNumber,
            providerId: providerIdValue,
            month: monthLabelForResponse,
            monthNumber: monthNumberForResponse,
            year: yearStr,
            summary,
            fundingSources: distinctFundingSources // Include distinct funding sources in the response
        });
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
        let invoiceIssuedValue;
        if (normalizedStatus === 'invoiced') {
            invoiceIssuedValue = true;
        } else if (normalizedStatus === 'pending' || normalizedStatus === 'not invoiced') {
            invoiceIssuedValue = false;
        }

        const results = [];

        for (const itemId of itemIds) {
            try {
                // Use findOne to get a Mongoose document (not lean) so we can save it
                const item = await Item.findOne({ workspaceId, boardId, itemId });
                if (!item) {
                    results.push({
                        itemId,
                        updated: false,
                        reason: 'ITEM_NOT_FOUND'
                    });
                    continue;
                }

                // In flat data format, data is an object: { "Attribute Name": value, ... }
                if (!item.data || typeof item.data !== 'object') {
                    results.push({
                        itemId,
                        updated: false,
                        reason: 'NO_DATA_ON_ITEM'
                    });
                    continue;
                }

                let changed = false;

                // Helper to update attribute in flat data format
                const updateAttribute = (attributeName, newData, options = { required: true }) => {
                    const currentData = item.data[attributeName];
                    const nextData = typeof newData === 'function' ? newData(currentData) : newData;

                    if (nextData !== undefined && nextData !== currentData) {
                        item.data[attributeName] = nextData;
                        changed = true;
                        return true;
                    }
                    return false;
                };

                if (invoiceIssuedValue !== undefined) {
                    updateAttribute('Invoice Issued and Sent', invoiceIssuedValue);
                }

                if (invoiceNumber) {
                    updateAttribute('Generated Invoice Number', invoiceNumber);
                }

                if (fileUrl) {
                    const optionalFileAttributes = [
                        'Invoice File URL',
                        'Invoice PDF Link',
                        'Generated Invoice File URL',
                        'Generated Invoice Link'
                    ];
                    const fileAttrUpdated = optionalFileAttributes.some(attr =>
                        updateAttribute(attr, fileUrl, { required: false })
                    );
                    if (!fileAttrUpdated) {
                        info('Items-Service', 'No matching attribute found for invoice file URL', {
                            itemId,
                            workspaceId,
                            boardId
                        });
                    }
                }

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