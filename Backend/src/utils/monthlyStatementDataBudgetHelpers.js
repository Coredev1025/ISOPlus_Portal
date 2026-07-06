export function getMonthLabelFromDate(dateValue) {
  if (!dateValue) return '';
  const date = new Date(dateValue);
  if (isNaN(date.getTime())) return '';
  const monthLabels = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return monthLabels[date.getMonth()] || '';
}

export function getYearFromDate(dateValue) {
  if (!dateValue) return '';
  const date = new Date(dateValue);
  if (isNaN(date.getTime())) return '';
  return date.getFullYear().toString();
}

function parseTransactionType(transactionTypeValue) {
  if (!transactionTypeValue) return '';
  if (typeof transactionTypeValue === 'object' && transactionTypeValue.name) return transactionTypeValue.name;
  if (typeof transactionTypeValue === 'string') return transactionTypeValue;
  return transactionTypeValue.toString ? transactionTypeValue.toString() : '';
}

export function transformHscmBudgetItemData(item, ctx) {
  const {
    folderName,
    resolveParticipantForHSCM,
    getValue,
    getValueMulti,
    parseNumber,
    toOutflow,
    extractRefId,
  } = ctx;

  const participantProfileIdValue = getValue(item, 'Associated Participant');
  const participantProfileId = extractRefId(participantProfileIdValue);
  const participantName = resolveParticipantForHSCM(item);
  const dateValue = getValueMulti(item, ['Date']);
  const transactionTypeValue = getValueMulti(item, ['Transaction Type']);
  const receivedAmount = parseNumber(getValue(item, 'Received Amount ($)'));
  const allocatedTime = parseNumber(getValueMulti(item, ['Allocated time (Hr.)', 'Allocated Time (Hr.)']));
  const allocatedAmount = toOutflow(parseNumber(getValue(item, 'Allocated Amount ($-)')));
  const currentBalance = parseNumber(getValue(item, 'Net Movement ($)'));

  return {
    id: item.itemId,
    categoryCode: 'HSCM',
    folderName: folderName || 'Home Support Care Management Budget',
    participantName,
    participantProfileId: participantProfileId ? participantProfileId.toString() : null,
    month: getMonthLabelFromDate(dateValue),
    year: getYearFromDate(dateValue),
    quarter: '',
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
    remainingBalance: currentBalance,
    fundClassification: 'Care Management',
    fundAmount: 0,
    fund: '',
    committedFunds: 0,
    fundingStartDate: null,
    fundingEndDate: null,
    primarySupplementLabel: '',
    remainingBalanceEndOfMonth: currentBalance,
    remainingBalanceAllocationPeriod: 0,
    hscmDate: dateValue || null,
    hscmTransactionType: parseTransactionType(transactionTypeValue),
    hscmReceivedAmount: receivedAmount || 0,
    hscmAllocatedTime: allocatedTime || 0,
    hscmAllocatedAmount: allocatedAmount || 0,
    hscmCurrentBalance: currentBalance || 0,
    updatedAt: item.updatedAt,
    createdAt: item.createdAt,
    rawData: item.data || {},
  };
}

function getTotalAvailableBudgetAttrs(code) {
  if (code === 'RCP') return ['Total Available Budget for Restorative Care ($)', 'Total Available Fund for Restorative Care ($)'];
  if (code === 'EOL') return ['Total Available Budget for End-of-Life Care ($)', 'Total Available Fund for End-of-Life Care ($)'];
  if (code === 'ATS') return ['Total Available Budget for Assistive Technology - Short-term ($)', 'Total Available Fund for AT - Short-term ($)'];
  if (code === 'ATO') return ['Total Available Budget for Assistive Technology - Ongoing ($)', 'Total Available Fund for AT Ongoing ($)'];
  if (code === 'HMB') return ['Total Available Budget for Home Modification ($)', 'Total Available Fund for HM ($)'];
  return null;
}

function computeTotalAvailableBudget({
  code,
  item,
  getValue,
  getValueMulti,
  parseNumber,
  availableFundStart,
  quarterlyAdjustment,
  primarySupplementAmount,
  additionalAmountApproved,
  carryoverFunding,
  commonwealthUnspent,
  providerUnspent,
  participantUnspent,
  previousMonthSpending,
  unspentReturned,
  previousMonthSpendingAllocatedPeriod,
}) {
  if (code === 'HSQ') {
    const direct = parseNumber(getValue(item, 'Total Available Budget for Home Support ($)'));
    if (direct) return direct;
    return availableFundStart + quarterlyAdjustment + primarySupplementAmount + carryoverFunding
      + commonwealthUnspent + providerUnspent + participantUnspent + previousMonthSpending + unspentReturned;
  }

  const totalAttrs = getTotalAvailableBudgetAttrs(code);
  if (totalAttrs?.length) {
    const fromBoard = parseNumber(getValueMulti(item, totalAttrs));
    if (fromBoard) return fromBoard;
  }

  if (code === 'RCP' || code === 'EOL') {
    return availableFundStart + primarySupplementAmount + previousMonthSpendingAllocatedPeriod;
  }
  if (code === 'ATS') {
    return availableFundStart + primarySupplementAmount + additionalAmountApproved + previousMonthSpendingAllocatedPeriod;
  }
  if (code === 'ATO' || code === 'HMB') {
    return availableFundStart + primarySupplementAmount + previousMonthSpendingAllocatedPeriod;
  }
  return availableFundStart || 0;
}

function getRemainingEndOfMonthAttr(code) {
  if (code === 'HSQ') return 'Remaining Home Support Balance as at the End of the Month ($)';
  if (code === 'ATS') return 'Remaining AT - Short-term Balance as at the End of the Month ($)';
  if (code === 'ATO') return 'Remaining AT - Ongoing Balance as at the End of the Month ($)';
  if (code === 'HMB') return 'Remaining HM Balance as at the End of the Month ($)';
  if (code === 'RCP' || code === 'EOL') return null;
  return 'Remaining Home Support Balance as at the End of the Month ($)';
}

function getRemainingBalanceEndOfMonthRaw(code, item, getValueMulti) {
  const remainingEndOfMonthAttr = getRemainingEndOfMonthAttr(code);
  if (remainingEndOfMonthAttr) return getValueMulti(item, [remainingEndOfMonthAttr]);
  if (code === 'RCP') return getValueMulti(item, ['Remaining Restorative Care Balance as at the End of the Month ($)']);
  if (code === 'EOL') return getValueMulti(item, ['Remaining End-of-Life Care Balance as at the End of the Month ($)']);
  return null;
}

function computeCommittedFunds(code, item, getValue, parseNumber, toOutflow) {
  if (code === 'ATS') return toOutflow(parseNumber(getValue(item, 'Committed AT Short-term Funds - to be delivered ($-)')));
  if (code === 'ATO') return toOutflow(parseNumber(getValue(item, 'Committed AT Ongoing Funds - to be delivered ($-)')));
  if (code === 'HMB') return toOutflow(parseNumber(getValue(item, 'Committed HM Funds - to be delivered ($-)')));
  return 0;
}

function computeRemainingBalances({
  code,
  item,
  getValueMulti,
  parseNumber,
  totalAvailableBudget,
  deliveredAmountRaw,
  adjustmentAmount,
  committedFunds,
}) {
  const remainingBalanceEndOfMonthRaw = getRemainingBalanceEndOfMonthRaw(code, item, getValueMulti);
  const remainingBalanceEndOfMonth = (remainingBalanceEndOfMonthRaw !== null && remainingBalanceEndOfMonthRaw !== undefined)
    ? Math.max(0, parseNumber(remainingBalanceEndOfMonthRaw))
    : Math.max(0, totalAvailableBudget + deliveredAmountRaw + adjustmentAmount);

  let remainingBalanceAllocationPeriod = null;
  if (code === 'ATS' || code === 'ATO' || code === 'HMB') {
    const allocationAttr = code === 'ATS'
      ? 'Remaining AT - Short-term Balance for Allocation Period ($)'
      : code === 'ATO'
        ? 'Remaining AT - Ongoing Balance for Allocation Period ($)'
        : 'Remaining HM Balance for Allocation Period ($)';
    const allocationRaw = getValueMulti(item, [allocationAttr]);
    remainingBalanceAllocationPeriod = (allocationRaw !== null && allocationRaw !== undefined)
      ? Math.max(0, parseNumber(allocationRaw))
      : Math.max(0, remainingBalanceEndOfMonth + committedFunds);
  }

  const effectiveRemainingBalance = (code === 'ATS' || code === 'ATO' || code === 'HMB')
    ? remainingBalanceAllocationPeriod
    : remainingBalanceEndOfMonth;

  return { remainingBalanceEndOfMonth, remainingBalanceAllocationPeriod, effectiveRemainingBalance };
}

export function transformStandardBudgetItemData(item, ctx) {
  const {
    code,
    folderName,
    resolveParticipant,
    getValue,
    getValueMulti,
    parseNumber,
    toOutflow,
    extractRefId,
    formatStatus,
    resolveReferenceValue,
    psMap,
    BUDGET_FIELDS,
    getDeliveredAmountForCategoryCode,
    ATTR,
  } = ctx;

  const participantProfileIdValue = getValue(item, ATTR.PARTICIPANT_PROFILE);
  const participantProfileId = extractRefId(participantProfileIdValue);
  const participantName = resolveParticipant(item);

  const monthLabel = formatStatus(getValue(item, 'Month'));
  const yearLabel = formatStatus(getValue(item, 'Year'));
  const quarterLabel = formatStatus(getValue(item, 'FY Quarter')) || '';

  const fundingStartDate = getValue(item, 'Funding Start Date');
  const fundingEndDate = getValue(item, 'Funding End Date');

  const availableFundStart = parseNumber(getValue(item, 'Available Fund at the Start of the Month ($)'));
  const quarterlyAdjustment = parseNumber(getValue(item, 'Classification Quarterly Budget Adjustment ($)'));
  const primarySupplementAmount = parseNumber(getValue(item, 'Primary Supplement ($)'));
  const additionalAmountApproved = parseNumber(getValue(item, 'Additional amount approved (AT high tier) ($)'));
  const carryoverFunding = parseNumber(getValue(item, 'Carryover Funding from the Previous Quarter ($)'));
  const unspentReturned = parseNumber(getValueMulti(item, [
    'Unspent Budget at the End of the Quarter – Returned ($-)',
    'Unspent Budget at the End of the Quarter - Returned ($-)',
  ]));
  const commonwealthUnspent = parseNumber(getValueMulti(item, BUDGET_FIELDS.commonwealthUnspent));
  const providerUnspent = parseNumber(getValueMulti(item, BUDGET_FIELDS.providerUnspent));
  const participantUnspent = parseNumber(getValueMulti(item, BUDGET_FIELDS.participantUnspent));
  const previousMonthSpendingSameQuarter = parseNumber(getValue(item, 'Spending from Previous Month(s) within same Quarter ($)'));
  const previousMonthSpendingAllocatedPeriod = parseNumber(getValue(item, 'Spending from Previous Month(s) within Allocated Period ($)'));
  const previousMonthSpending = (code === 'ATS' || code === 'ATO' || code === 'HMB' || code === 'RCP' || code === 'EOL')
    ? previousMonthSpendingAllocatedPeriod
    : previousMonthSpendingSameQuarter;

  const totalAvailableBudget = computeTotalAvailableBudget({
    code,
    item,
    getValue,
    getValueMulti,
    parseNumber,
    availableFundStart,
    quarterlyAdjustment,
    primarySupplementAmount,
    additionalAmountApproved,
    carryoverFunding,
    commonwealthUnspent,
    providerUnspent,
    participantUnspent,
    previousMonthSpending,
    unspentReturned,
    previousMonthSpendingAllocatedPeriod,
  });

  const deliveredAmountRaw = getDeliveredAmountForCategoryCode(code, item, getValue, parseNumber, toOutflow);
  const adjustmentAmount = parseNumber(getValue(item, 'Adjustments from Previous Months [Charges($-)/Refund($)]'));
  const primarySupplementLabel = resolveReferenceValue(getValue(item, 'Primary Supplement'), psMap);
  const fundClassification = formatStatus(getValue(item, 'Fund Classification')) || '';
  const fundAmount = parseNumber(getValueMulti(item, ['Fund Amount ($)', 'Fund Amount($)']));
  const fund = formatStatus(getValue(item, 'Fund')) || '';
  const committedFunds = computeCommittedFunds(code, item, getValue, parseNumber, toOutflow);

  const {
    remainingBalanceEndOfMonth,
    remainingBalanceAllocationPeriod,
    effectiveRemainingBalance,
  } = computeRemainingBalances({
    code,
    item,
    getValueMulti,
    parseNumber,
    totalAvailableBudget,
    deliveredAmountRaw,
    adjustmentAmount,
    committedFunds,
  });

  return {
    id: item.itemId,
    folderName,
    categoryCode: code,
    participantName,
    participantProfileId: participantProfileId ? participantProfileId.toString() : null,
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
    fundingStreamId: getValue(item, 'Funding Stream'),
    updatedAt: item.updatedAt,
    createdAt: item.createdAt,
    rawData: item.data || {},
  };
}

export function transformBudgetItemData(item, ctx) {
  const code = ctx.folderIdToCode[item.folderId] || 'HSQ';
  const folderName = ctx.folderIdToName.get(item.folderId) || '';
  const isCareManagement = folderName.toLowerCase().includes('home support care management budget');

  if (isCareManagement) {
    return transformHscmBudgetItemData(item, { ...ctx, folderName });
  }
  return transformStandardBudgetItemData(item, { ...ctx, code, folderName });
}
