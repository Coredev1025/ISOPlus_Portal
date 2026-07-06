export function parseMonthlyStatementNumberValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return 0;
  if (Array.isArray(rawValue) && rawValue.length > 0) return parseMonthlyStatementNumberValue(rawValue[0]);
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : 0;
  if (typeof rawValue !== 'string') return 0;

  let s = rawValue.trim();
  if (!s) return 0;
  s = s.replace(/[\u2212\u2012\u2013\u2014]/g, '-');

  let negative = false;
  if (/\(.*\)/.test(s)) {
    negative = true;
    s = s.replace(/[()]/g, '');
  }
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

export function normalizeAttributeNames(attributeName) {
  if (Array.isArray(attributeName)) {
    return attributeName.filter((name) => typeof name === 'string' && name.trim() !== '');
  }
  if (typeof attributeName === 'string' && attributeName.trim() !== '') {
    return [attributeName];
  }
  return [];
}

export function createMonthlyStatementItemAccessors(itemDataHelpers) {
  const { getValueFromItemMulti, parseNumberValue } = itemDataHelpers;

  const getNumberFromItem = (item, attributeName) =>
    parseNumberValue(getValueFromItemMulti(item, attributeName));

  const getLabelFromItem = (item, attributeName) => {
    const data = getValueFromItemMulti(item, attributeName);
    if (!data) return null;
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0];
      if (typeof first === 'object' && first.name) return first.name;
      return String(first);
    }
    if (typeof data === 'object' && data.name) return data.name;
    if (typeof data === 'string') return data;
    return null;
  };

  const getDateFromItem = (item, attributeName) => {
    const data = getValueFromItemMulti(item, attributeName);
    if (!data) return null;
    if (typeof data === 'string') return data;
    return null;
  };

  const getTextFromItem = (item, attributeName) => {
    const data = getValueFromItemMulti(item, attributeName);
    if (data === null || data === undefined) return '';
    if (typeof data === 'string') return data;
    if (Array.isArray(data) && data.length > 0) return data[0]?.toString() || '';
    return data.toString ? data.toString() : '';
  };

  const getFirstReferenceId = (item, attributeName) => {
    const data = getValueFromItemMulti(item, attributeName);
    if (Array.isArray(data) && data.length > 0) return data[0];
    if (typeof data === 'string') return data;
    return null;
  };

  return { getNumberFromItem, getLabelFromItem, getDateFromItem, getTextFromItem, getFirstReferenceId };
}

function transformHscmBudgetItem(item, context) {
  const {
    folderName,
    resolveParticipantName,
    getValueFromItemMulti,
    getNumberFromItem,
    getMonthLabelFromDate,
    getYearFromDate,
    workspaceId,
    boardId,
    setCachedMSBudget,
  } = context;

  const participantProfileIdValue = context.getFirstReferenceId(item, 'Associated Participant');
  const participantName = resolveParticipantName(participantProfileIdValue);
  const dateValue = getValueFromItemMulti(item, 'Date');
  const transactionTypeValue = getValueFromItemMulti(item, 'Transaction Type');
  const receivedAmount = getNumberFromItem(item, 'Received Amount ($)');
  const allocatedTime = getNumberFromItem(item, [context.ATTRIBUTE_NAMES.ALLOCATED_TIME, 'Allocated Time (Hr.)']);
  const allocatedAmount = getNumberFromItem(item, 'Allocated Amount ($-)');
  const currentBalanceValue = getNumberFromItem(item, 'Net Movement ($)');
  const currentBalance = Number.isFinite(currentBalanceValue) && currentBalanceValue !== 0
    ? currentBalanceValue
    : (receivedAmount || 0) + (allocatedAmount || 0);

  const transactionType = (() => {
    if (!transactionTypeValue) return '';
    if (typeof transactionTypeValue === 'object' && transactionTypeValue.name) return transactionTypeValue.name;
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
    rawData: item.data || {},
  };

  setCachedMSBudget(workspaceId, boardId, item.itemId, transformedData);
  return transformedData;
}

function getTotalBudgetAttrsForCategory(categoryCode, REF_ATTRIBUTE_NAMES) {
  if (categoryCode === 'RCP') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_RESTORATIVE, REF_ATTRIBUTE_NAMES.TOTAL_FUND_RESTORATIVE];
  if (categoryCode === 'EOL') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_END_OF_LIFE, REF_ATTRIBUTE_NAMES.TOTAL_FUND_END_OF_LIFE];
  if (categoryCode === 'ATS') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_AT_SHORT_TERM, REF_ATTRIBUTE_NAMES.TOTAL_FUND_AT_SHORT_TERM];
  if (categoryCode === 'ATO') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_AT_ONGOING, REF_ATTRIBUTE_NAMES.TOTAL_FUND_AT_ONGOING];
  if (categoryCode === 'HMB') return [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_HOME_MOD, REF_ATTRIBUTE_NAMES.TOTAL_FUND_HM];
  return null;
}

function computePreviousMonthSpending(categoryCode, accessors, item, ATTRIBUTE_NAMES) {
  const { getNumberFromItem } = accessors;
  const sameQuarter = getNumberFromItem(item, ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING);
  const allocatedPeriod = getNumberFromItem(item, ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD);
  const usesAllocated = ['ATS', 'ATO', 'HMB', 'RCP', 'EOL'].includes(categoryCode);
  return usesAllocated ? allocatedPeriod : sameQuarter;
}

function computeHsqTotalAvailableBudget({
  availableFundStart,
  quarterlyAdjustment,
  primarySupplementAmount,
  carryoverFunding,
  commonwealthUnspent,
  providerUnspent,
  participantUnspent,
  previousMonthSpending,
  unspentReturned,
}) {
  return availableFundStart + quarterlyAdjustment + primarySupplementAmount + carryoverFunding
    + commonwealthUnspent + providerUnspent + participantUnspent + previousMonthSpending + unspentReturned;
}

function computeNonHsqTotalFallback(categoryCode, {
  availableFundStart,
  primarySupplementAmount,
  additionalAmountApproved,
  previousSpendingAllocated,
}) {
  if (categoryCode === 'RCP' || categoryCode === 'EOL') {
    return availableFundStart + primarySupplementAmount + previousSpendingAllocated;
  }
  if (categoryCode === 'ATS') {
    return availableFundStart + primarySupplementAmount + additionalAmountApproved + previousSpendingAllocated;
  }
  if (categoryCode === 'ATO' || categoryCode === 'HMB') {
    return availableFundStart + primarySupplementAmount + previousSpendingAllocated;
  }
  return availableFundStart || 0;
}

function computeTotalAvailableBudget(params) {
  const {
    categoryCode,
    item,
    accessors,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
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
  } = params;

  const { getNumberFromItem } = accessors;
  const totalAvailableBudgetHomeSupport = getNumberFromItem(item, ATTRIBUTE_NAMES.TOTAL_AVAILABLE_HOME_SUPPORT);
  if (totalAvailableBudgetHomeSupport) return totalAvailableBudgetHomeSupport;

  if (categoryCode === 'HSQ') {
    return computeHsqTotalAvailableBudget({
      availableFundStart,
      quarterlyAdjustment,
      primarySupplementAmount,
      carryoverFunding,
      commonwealthUnspent,
      providerUnspent,
      participantUnspent,
      previousMonthSpending,
      unspentReturned,
    });
  }

  const totalAttrs = getTotalBudgetAttrsForCategory(categoryCode, REF_ATTRIBUTE_NAMES);
  let totalAvailableBudget = totalAttrs?.length ? (getNumberFromItem(item, totalAttrs) || 0) : 0;
  if (totalAvailableBudget) return totalAvailableBudget;

  const previousSpendingAllocated = getNumberFromItem(item, ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD) || 0;
  return computeNonHsqTotalFallback(categoryCode, {
    availableFundStart,
    primarySupplementAmount,
    additionalAmountApproved,
    previousSpendingAllocated,
  });
}

function getDeliveredAmountRaw(categoryCode, accessors, item, ATTRIBUTE_NAMES) {
  const { getNumberFromItem } = accessors;
  if (categoryCode === 'ATS') return getNumberFromItem(item, ATTRIBUTE_NAMES.AT_SHORT_TERM_DELIVERED);
  if (categoryCode === 'ATO') return getNumberFromItem(item, ATTRIBUTE_NAMES.AT_ONGOING_DELIVERED);
  if (categoryCode === 'HMB') return getNumberFromItem(item, ATTRIBUTE_NAMES.HOME_MODIFICATION_DELIVERED);
  if (categoryCode === 'RCP') return getNumberFromItem(item, ATTRIBUTE_NAMES.RESTORATIVE_CARE_DELIVERED);
  if (categoryCode === 'EOL') return getNumberFromItem(item, ATTRIBUTE_NAMES.END_OF_LIFE_DELIVERED);
  return getNumberFromItem(item, ATTRIBUTE_NAMES.HOME_SUPPORT_DELIVERED);
}

function getCommittedFunds(categoryCode, accessors, item, ATTRIBUTE_NAMES) {
  const { getNumberFromItem } = accessors;
  if (categoryCode === 'ATS') return getNumberFromItem(item, ATTRIBUTE_NAMES.COMMITTED_AT_SHORT_TERM);
  if (categoryCode === 'ATO') return getNumberFromItem(item, ATTRIBUTE_NAMES.COMMITTED_AT_ONGOING);
  if (categoryCode === 'HMB') return getNumberFromItem(item, ATTRIBUTE_NAMES.COMMITTED_HOME_MODIFICATION);
  return 0;
}

function getRemainingEndOfMonthAttr(categoryCode, ATTRIBUTE_NAMES, REF_ATTRIBUTE_NAMES) {
  if (categoryCode === 'HSQ') return ATTRIBUTE_NAMES.REMAINING_HOME_SUPPORT_BALANCE;
  if (categoryCode === 'ATS') return REF_ATTRIBUTE_NAMES.REMAINING_AT_SHORT_TERM_END_OF_MONTH;
  if (categoryCode === 'ATO') return REF_ATTRIBUTE_NAMES.REMAINING_AT_ONGOING_END_OF_MONTH;
  if (categoryCode === 'HMB') return REF_ATTRIBUTE_NAMES.REMAINING_HM_END_OF_MONTH;
  if (categoryCode === 'RCP' || categoryCode === 'EOL') return null;
  return ATTRIBUTE_NAMES.REMAINING_HOME_SUPPORT_BALANCE;
}

function getRemainingBalanceEndOfMonthRaw(categoryCode, item, accessors, ATTRIBUTE_NAMES, REF_ATTRIBUTE_NAMES) {
  const { getValueFromItemMulti } = accessors;
  const remainingEndOfMonthAttr = getRemainingEndOfMonthAttr(categoryCode, ATTRIBUTE_NAMES, REF_ATTRIBUTE_NAMES);
  if (remainingEndOfMonthAttr) {
    return getValueFromItemMulti(item, remainingEndOfMonthAttr);
  }
  if (categoryCode !== 'RCP' && categoryCode !== 'EOL') return null;
  return getValueFromItemMulti(
    item,
    categoryCode === 'RCP'
      ? REF_ATTRIBUTE_NAMES.REMAINING_RESTORATIVE_END_OF_MONTH
      : REF_ATTRIBUTE_NAMES.REMAINING_END_OF_LIFE_END_OF_MONTH,
  );
}

function computeRemainingBalanceAllocationPeriod(categoryCode, item, accessors, REF_ATTRIBUTE_NAMES, parseNumberValue, remainingBalanceEndOfMonth, committedFunds) {
  if (categoryCode !== 'ATS' && categoryCode !== 'ATO' && categoryCode !== 'HMB') return null;
  const allocationAttr = categoryCode === 'ATS' ? REF_ATTRIBUTE_NAMES.REMAINING_AT_SHORT_TERM
    : categoryCode === 'ATO' ? REF_ATTRIBUTE_NAMES.REMAINING_AT_ONGOING
      : REF_ATTRIBUTE_NAMES.REMAINING_HOME_MOD;
  const allocationRaw = accessors.getValueFromItemMulti(item, allocationAttr);
  return (allocationRaw !== null && allocationRaw !== undefined)
    ? Math.max(0, parseNumberValue(allocationRaw))
    : Math.max(0, remainingBalanceEndOfMonth + committedFunds);
}

function computeRemainingBalances({
  categoryCode,
  item,
  accessors,
  ATTRIBUTE_NAMES,
  REF_ATTRIBUTE_NAMES,
  parseNumberValue,
  totalAvailableBudget,
  deliveredAmountRaw,
  adjustmentAmount,
  committedFunds,
}) {
  const remainingBalanceEndOfMonthRaw = getRemainingBalanceEndOfMonthRaw(
    categoryCode,
    item,
    accessors,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
  );

  const remainingBalanceEndOfMonth = (remainingBalanceEndOfMonthRaw !== null && remainingBalanceEndOfMonthRaw !== undefined)
    ? Math.max(0, parseNumberValue(remainingBalanceEndOfMonthRaw))
    : Math.max(0, totalAvailableBudget + deliveredAmountRaw + adjustmentAmount);

  const remainingBalanceAllocationPeriod = computeRemainingBalanceAllocationPeriod(
    categoryCode,
    item,
    accessors,
    REF_ATTRIBUTE_NAMES,
    parseNumberValue,
    remainingBalanceEndOfMonth,
    committedFunds,
  );

  const effectiveRemainingBalance = (categoryCode === 'ATS' || categoryCode === 'ATO' || categoryCode === 'HMB')
    ? remainingBalanceAllocationPeriod
    : remainingBalanceEndOfMonth;

  return { remainingBalanceEndOfMonth, remainingBalanceAllocationPeriod, effectiveRemainingBalance };
}

function transformStandardBudgetItem(item, context) {
  const {
    categoryCode,
    folderName,
    resolveParticipantName,
    accessors,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    parseNumberValue,
    resolveReferenceValue,
    primarySupplementMap,
    workspaceId,
    boardId,
    setCachedMSBudget,
  } = context;

  const participantProfileIdValue = accessors.getFirstReferenceId(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
  const participantName = resolveParticipantName(participantProfileIdValue);

  const availableFundStart = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.AVAILABLE_FUND_START);
  const quarterlyAdjustment = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.QUARTERLY_ADJUSTMENT);
  const primarySupplementAmount = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.PRIMARY_SUPPLEMENT_AMOUNT);
  const additionalAmountApproved = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.ADDITIONAL_AMOUNT_APPROVED_AT);
  const carryoverFunding = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.CARRYOVER_FUNDING);
  const unspentReturned = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.UNSPENT_BUDGET_RETURNED);
  const commonwealthUnspent = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.COMMONWEALTH_UNSPENT_FUNDS);
  const providerUnspent = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.PROVIDER_UNSPENT_FUNDS);
  const participantUnspent = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_UNSPENT_FUNDS);
  const previousMonthSpending = computePreviousMonthSpending(categoryCode, accessors, item, ATTRIBUTE_NAMES);

  const totalAvailableBudget = computeTotalAvailableBudget({
    categoryCode,
    item,
    accessors,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
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
  });

  const deliveredAmountRaw = getDeliveredAmountRaw(categoryCode, accessors, item, ATTRIBUTE_NAMES);
  const adjustmentAmount = accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.HOME_SUPPORT_ADJUSTMENTS);
  const primarySupplementValue = context.getValueFromItemMulti(item, 'Primary Supplement');
  const primarySupplementLabel = resolveReferenceValue(primarySupplementValue, primarySupplementMap);
  const committedFunds = getCommittedFunds(categoryCode, accessors, item, ATTRIBUTE_NAMES);

  const {
    remainingBalanceEndOfMonth,
    remainingBalanceAllocationPeriod,
    effectiveRemainingBalance,
  } = computeRemainingBalances({
    categoryCode,
    item,
    accessors,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    parseNumberValue,
    totalAvailableBudget,
    deliveredAmountRaw,
    adjustmentAmount,
    committedFunds,
  });

  const transformedData = {
    id: item.itemId,
    categoryCode,
    folderName,
    participantName,
    participantProfileId: participantProfileIdValue ? participantProfileIdValue.toString() : null,
    month: accessors.getLabelFromItem(item, ATTRIBUTE_NAMES.MONTH_LABEL),
    year: accessors.getLabelFromItem(item, ATTRIBUTE_NAMES.YEAR_LABEL),
    quarter: accessors.getLabelFromItem(item, ATTRIBUTE_NAMES.FY_QUARTER),
    fundingStartDate: accessors.getDateFromItem(item, ATTRIBUTE_NAMES.FUNDING_START_DATE),
    fundingEndDate: accessors.getDateFromItem(item, ATTRIBUTE_NAMES.FUNDING_END_DATE),
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
    fundClassification: accessors.getLabelFromItem(item, ATTRIBUTE_NAMES.FUND_CLASSIFICATION),
    fundAmount: accessors.getNumberFromItem(item, ATTRIBUTE_NAMES.FUND_AMOUNT),
    additionalAmountApproved,
    fund: accessors.getTextFromItem(item, ATTRIBUTE_NAMES.FUND_TEXT),
    committedFunds,
    fundingStreamId: accessors.getFirstReferenceId(item, ATTRIBUTE_NAMES.FUNDING_STREAM),
    rawData: item.data || {},
  };

  setCachedMSBudget(workspaceId, boardId, item.itemId, transformedData);
  return transformedData;
}

export function transformMonthlyStatementBudgetItem(item, context) {
  const itemId = item.itemId;
  const itemUpdatedAt = item.updatedAt || item.createdAt;
  const cachedData = context.getCachedMSBudget(context.workspaceId, context.boardId, itemId, itemUpdatedAt);
  if (cachedData) return cachedData;

  const categoryCode = context.determineCategoryCodeForBudget(item);
  const folderName = context.folderIdToName.get(item.folderId)
    || context.BUDGET_CATEGORY_CONFIG.find((cfg) => cfg.code === categoryCode)?.folderName
    || '';

  const isCareManagement = folderName.toLowerCase().includes('home support care management budget');
  if (isCareManagement) {
    return transformHscmBudgetItem(item, { ...context, folderName });
  }

  return transformStandardBudgetItem(item, { ...context, categoryCode, folderName });
}

export function determineCategoryCodeForBudgetItem(item, folderIdToCode, getValueFromFlatData, ATTRIBUTE_NAMES) {
  if (item?.folderId && folderIdToCode[item.folderId]) {
    return folderIdToCode[item.folderId];
  }
  const fundingStreamValue = getValueFromFlatData(item, ATTRIBUTE_NAMES.FUNDING_STREAM);
  if (fundingStreamValue) {
    // Category may be determined from funding stream in future
  }
  return 'HSQ';
}

export function determineCategoryCodeForService(service = {}) {
  const normalize = (value) => (value || '').toString().toLowerCase();
  const haystack = `${normalize(service.fundingSource)} ${normalize(service.service)} ${normalize(service.notes)}`;

  if (haystack.includes('restorative care')) return 'RCP';
  if (haystack.includes('end-of-life') || haystack.includes('end of life')) return 'EOL';
  if (haystack.includes('assistive') && haystack.includes('short')) return 'ATS';
  if (haystack.includes('assistive') && haystack.includes('ongoing')) return 'ATO';
  if (haystack.includes('modification')) return 'HMB';
  if (haystack.includes('home support') || haystack.includes('hsq')) return 'HSQ';
  return 'HSQ';
}
