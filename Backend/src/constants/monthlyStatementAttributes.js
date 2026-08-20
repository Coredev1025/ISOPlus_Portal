export const ATTRIBUTE_NAMES = {
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

export const FUNDING_SOURCE_TYPES = {
    HOME_SUPPORT: 'Home Support Quarterly Budget',
    RESTORATIVE_CARE: 'Restorative Care Pathway Budget',
    END_OF_LIFE: 'End-of-Life Pathway Budget',
    ASSISTIVE_TECH_SHORT: 'Assistive Technology - Short-term Budget',
    ASSISTIVE_TECH_ONGOING: 'Assistive Technology - Ongoing Budget',
    HOME_MODIFICATION: 'Home Modification Budget'
};

export const BUDGET_CATEGORY_CONFIG = [
    { code: 'HSQ', folderName: FUNDING_SOURCE_TYPES.HOME_SUPPORT, profileKey: 'homeSupport' },
    { code: 'HSCM', folderName: 'Home Support Care Management Budget', profileKey: 'careManagement' },
    { code: 'ATS', folderName: FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_SHORT, profileKey: 'assistiveTechShortTerm' },
    { code: 'ATO', folderName: FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_ONGOING, profileKey: 'assistiveTechOngoing' },
    { code: 'HMB', folderName: FUNDING_SOURCE_TYPES.HOME_MODIFICATION, profileKey: 'homeModification' },
    { code: 'RCP', folderName: FUNDING_SOURCE_TYPES.RESTORATIVE_CARE, profileKey: 'restorativeCare' },
    { code: 'EOL', folderName: FUNDING_SOURCE_TYPES.END_OF_LIFE, profileKey: 'endOfLife' }
];

export const BUDGET_CATEGORY_ORDER = BUDGET_CATEGORY_CONFIG.map(config => config.code);

export const DELIVERED_BY_TYPES = {
    COMPANY_WORKFORCE: 'company workforce',
    ASSOCIATED_PROVIDERS: 'associated providers'
};

// Transaction status that uses Actual Shift End Date & Time for month filtering; others use Scheduled Shift Start
export const TRANSACTION_STATUS_USE_ACTUAL_END = 'Delivered - To be claimed and invoiced.';

// Attribute names for referenced item types (Participant Profiles, Service Plans, Funding Sources)
export const REF_ATTRIBUTE_NAMES = {
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
    // The mailbox an automation with recipient `billing_contact` sends to.
    // Touchpoints: services/email/recipients.js (selectProfileAddress).
    PROFILE_BILLING_EMAIL: 'Billing Email',

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

