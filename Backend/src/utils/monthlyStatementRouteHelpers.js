import { compareServiceItems } from './itemsRouteHelpers.js';
import { formatMonthlyStatementStatus } from './monthlyStatementServiceTransformHelpers.js';
import {
  parseMonthlyStatementNumberValue,
  normalizeAttributeNames,
  createMonthlyStatementItemAccessors,
  transformMonthlyStatementBudgetItem,
  determineCategoryCodeForBudgetItem,
  determineCategoryCodeForService,
} from './monthlyStatementBudgetTransformHelpers.js';
import { transformMonthlyStatementServiceItem } from './monthlyStatementServiceTransformHelpers.js';
import { mongoEq } from './securityHelpers.js';

function getValueFromItem(item, attributeName) {
  if (!item?.data) return null;
  return item.data[attributeName] ?? null;
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function parseNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    return match ? parseFloat(match[0]) : 0;
  }
  return 0;
}

function buildFolderMaps(folders, BUDGET_CATEGORY_CONFIG) {
  const folderIdToName = new Map();
  const folderIdToCode = {};
  folders.forEach((folderElement) => {
    if (!folderElement?.id) return;
    const folderName = folderElement.name || '';
    folderIdToName.set(folderElement.id, folderName);
    const normalized = folderName.toLowerCase();
    const matchedConfig = BUDGET_CATEGORY_CONFIG.find((cfg) =>
      normalized.includes(cfg.folderName.toLowerCase()),
    );
    if (matchedConfig) folderIdToCode[folderElement.id] = matchedConfig.code;
  });
  return { folderIdToName, folderIdToCode };
}

function createFolderIdResolver(folders) {
  return (folderName) => {
    if (!folders?.length) return [];
    const folderNames = folderName.toLowerCase().split(',').map((name) => name.trim()).filter(Boolean);
    if (!folderNames.length) return [];
    return folders
      .filter((folderElement) => {
        const folderNameLower = (folderElement.name || '').toLowerCase();
        return folderNames.some((name) => folderNameLower.includes(name));
      })
      .map((folderElement) => folderElement.id);
  };
}

function createItemDataHelpers() {
  const getValueFromItemMulti = (item, attributeNames) => {
    const candidateNames = normalizeAttributeNames(attributeNames);
    if (!item?.data || candidateNames.length === 0) return null;
    for (const name of candidateNames) {
      const value = item.data[name];
      if (value !== undefined && value !== null) return value;
    }
    return null;
  };
  return {
    getValueFromItemMulti,
    parseNumberValue: parseMonthlyStatementNumberValue,
    accessors: createMonthlyStatementItemAccessors({
      getValueFromItemMulti,
      parseNumberValue: parseMonthlyStatementNumberValue,
    }),
  };
}

function resolveReferenceValue(value, refMap, isUuidLike, getReferenceDisplayName) {
  if (!value) return '';
  if (Array.isArray(value)) {
    return value.map((v) => resolveReferenceValue(v, refMap, isUuidLike, getReferenceDisplayName)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    if (value.name) return value.name;
    if (value.id) return resolveReferenceValue(value.id, refMap, isUuidLike, getReferenceDisplayName);
    return value.toString ? value.toString() : '';
  }
  const valueStr = String(value);
  if (isUuidLike(valueStr) && refMap?.has(valueStr)) {
    return getReferenceDisplayName(refMap.get(valueStr)) || valueStr;
  }
  return valueStr;
}

async function fetchBudgetItems(workspaceId, boardId, getFolderIdsForQuery, Item, error, req) {
  const budgetFolderNames = [
    'Home Support Quarterly Budget',
    'Restorative Care Pathway Budget',
    'End-of-Life Pathway Budget',
    'Assistive Technology - Short-term Budget',
    'Assistive Technology - Ongoing Budget',
    'Home Modification Budget',
    'Home Support Care Management Budget',
  ].join(',');

  const budgetFolderIds = await getFolderIdsForQuery(budgetFolderNames);
  const budgetBaseQuery = {
    workspaceId: mongoEq(workspaceId),
    boardId: mongoEq(boardId),
  };
  if (budgetFolderIds?.length > 0) budgetBaseQuery.folderId = { $in: budgetFolderIds };

  try {
    return await Item.find(budgetBaseQuery).lean();
  } catch (dbErr) {
    error('Items-Service', 'Database query error for budget items', {
      message: dbErr.message,
      stack: dbErr.stack,
      workspaceId,
      boardId,
    }, req ?? null);
    return { error: { status: 500, body: { message: 'Error fetching budget items for monthly statement', error: dbErr.message } } };
  }
}

async function loadBudgetReferenceMaps(allBudgetItems, workspaceId, boardId, deps, accessors) {
  const budgetParticipantProfileIds = new Set();
  for (const item of allBudgetItems) {
    for (const attr of [deps.ATTRIBUTE_NAMES.PARTICIPANT_PROFILE, 'Associated Participant']) {
      const refId = accessors.getFirstReferenceId(item, attr);
      if (!refId) continue;
      const id = deps.extractRefId(refId);
      if (id) budgetParticipantProfileIds.add(id);
    }
  }

  const budgetProfilesMap = await deps.bulkFetchReferenceItemsFromDB(
    workspaceId,
    boardId,
    [...budgetParticipantProfileIds],
  );

  const primarySupplementRefIds = new Set();
  for (const item of allBudgetItems) {
    const primarySupplementValue = deps.getValueFromItemMulti?.(item, 'Primary Supplement')
      ?? getValueFromItem(item, 'Primary Supplement');
    deps.extractAllRefIds(primarySupplementValue).filter((id) => deps.isUuidLike(id))
      .forEach((id) => primarySupplementRefIds.add(id));
  }

  const primarySupplementMap = primarySupplementRefIds.size > 0
    ? await deps.bulkFetchReferenceItemsFromDB(workspaceId, boardId, [...primarySupplementRefIds])
    : new Map();

  return { budgetProfilesMap, primarySupplementMap, budgetParticipantProfileIds };
}

function createBudgetDateHelpers(stmtTimezone) {
  const monthLabelLookupLocal = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const getMonthLabelFromDate = (dateValue) => {
    if (!dateValue) return '';
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return '';
    const monthNum = parseInt(
      new Intl.DateTimeFormat('en-AU', { timeZone: stmtTimezone, month: 'numeric' }).format(date),
      10,
    );
    return monthLabelLookupLocal[monthNum - 1] || '';
  };

  const getYearFromDate = (dateValue) => {
    if (!dateValue) return '';
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-AU', { timeZone: stmtTimezone, year: 'numeric' }).format(date);
  };

  return { getMonthLabelFromDate, getYearFromDate };
}

export async function transformMonthlyStatementBudgetItemsBatch({
  rawItems,
  workspaceId,
  boardId,
  folderIdToName,
  folderIdToCode,
  ATTRIBUTE_NAMES,
  REF_ATTRIBUTE_NAMES,
  BUDGET_CATEGORY_CONFIG,
  headOfficeTimezone = 'Australia/Sydney',
  bulkFetchReferenceItemsFromDB,
  extractRefId,
  extractAllRefIds,
  isUuidLike,
  getParticipantNameFromProfile,
  getReferenceDisplayName,
  getValueFromFlatData,
  getCachedMSBudget = () => null,
  setCachedMSBudget = () => {},
}) {
  const itemDataHelpers = createItemDataHelpers();
  const { getValueFromItemMulti, accessors } = itemDataHelpers;
  const { getMonthLabelFromDate, getYearFromDate } = createBudgetDateHelpers(headOfficeTimezone);

  const { budgetProfilesMap, primarySupplementMap } = await loadBudgetReferenceMaps(
    rawItems,
    workspaceId,
    boardId,
    {
      ATTRIBUTE_NAMES,
      bulkFetchReferenceItemsFromDB,
      extractRefId,
      extractAllRefIds,
      isUuidLike,
      getValueFromItemMulti,
    },
    accessors,
  );

  const resolveParticipantName = (participantProfileIdValue) => {
    if (!participantProfileIdValue) return '';
    const profileIdStr = extractRefId(participantProfileIdValue);
    if (!profileIdStr) return '';
    return getParticipantNameFromProfile(budgetProfilesMap.get(profileIdStr)) || '';
  };

  const budgetTransformContext = {
    workspaceId,
    boardId,
    folderIdToName,
    folderIdToCode,
    BUDGET_CATEGORY_CONFIG,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    accessors,
    getValueFromItemMulti,
    parseNumberValue: parseMonthlyStatementNumberValue,
    resolveParticipantName,
    resolveReferenceValue: (value, refMap) =>
      resolveReferenceValue(value, refMap, isUuidLike, getReferenceDisplayName),
    primarySupplementMap,
    getCachedMSBudget,
    setCachedMSBudget,
    getFirstReferenceId: accessors.getFirstReferenceId,
    getNumberFromItem: accessors.getNumberFromItem,
    getMonthLabelFromDate,
    getYearFromDate,
    determineCategoryCodeForBudget: (item) =>
      determineCategoryCodeForBudgetItem(item, folderIdToCode, getValueFromFlatData, ATTRIBUTE_NAMES),
  };

  return rawItems.map((item) => transformMonthlyStatementBudgetItem(item, budgetTransformContext));
}

function filterBudgetItems(transformedAllBudgetItems, { participant, month, year }) {
  const normalizeString = (value) => (value || '').toString().trim().toLowerCase().replace(/\.+$/, '');
  const isIdLike = (value) => typeof value === 'string' && value.includes('-');
  const normalizedParticipant = normalizeString(participant);

  const monthLabelLookup = {
    '01': 'January', '02': 'February', '03': 'March', '04': 'April',
    '05': 'May', '06': 'June', '07': 'July', '08': 'August',
    '09': 'September', '10': 'October', '11': 'November', '12': 'December',
  };
  const normalizedMonth = typeof month === 'string' ? month.padStart(2, '0') : null;
  const targetMonthLabel = normalizedMonth && monthLabelLookup[normalizedMonth]
    ? monthLabelLookup[normalizedMonth]
    : null;

  return {
    filteredBudgetItems: transformedAllBudgetItems.filter((item) => {
      const matchesParticipant = normalizedParticipant
        ? (isIdLike(participant)
          ? item.participantProfileId === participant
          : normalizeString(item.participantName) === normalizedParticipant)
        : true;
      const matchesYear = year ? normalizeString(item.year) === normalizeString(year) : true;
      const matchesMonth = targetMonthLabel
        ? normalizeString(item.month) === normalizeString(targetMonthLabel)
        : true;
      return matchesParticipant && matchesYear && matchesMonth;
    }),
    normalizedMonth,
    targetMonthLabel,
    monthLabelLookup,
  };
}

function paginateBudgetItems(filteredBudgetItems, budgetPage, budgetLimitParam, BUDGET_CATEGORY_ORDER) {
  const getCategoryOrderIndex = (code) => {
    const normalizedCode = (code || 'HSQ').toString();
    const idx = BUDGET_CATEGORY_ORDER.indexOf(normalizedCode);
    return idx === -1 ? BUDGET_CATEGORY_ORDER.length : idx;
  };

  filteredBudgetItems.sort((a, b) => {
    const orderDiff = getCategoryOrderIndex(a.categoryCode) - getCategoryOrderIndex(b.categoryCode);
    if (orderDiff !== 0) return orderDiff;
    return (a.folderName || '').localeCompare(b.folderName || '');
  });

  const hasBudgetLimit = budgetLimitParam !== undefined && budgetLimitParam !== null && budgetLimitParam !== '';
  let budgetLimitNumber = hasBudgetLimit ? parseInt(budgetLimitParam, 10) : null;
  if (hasBudgetLimit && (isNaN(budgetLimitNumber) || budgetLimitNumber <= 0)) budgetLimitNumber = 10;
  const budgetPageNumber = hasBudgetLimit
    ? (parseInt(budgetPage, 10) > 0 ? parseInt(budgetPage, 10) : 1)
    : 1;

  const groupedBudgetItems = filteredBudgetItems.reduce((acc, item) => {
    const folderName = item.folderName || 'Uncategorized';
    if (!acc[folderName]) acc[folderName] = [];
    acc[folderName].push(item);
    return acc;
  }, {});

  const paginatedGroupedBudgetItems = {};
  Object.keys(groupedBudgetItems).forEach((folderName) => {
    const itemsInGroup = groupedBudgetItems[folderName];
    const totalItems = itemsInGroup.length;
    const paginatedItems = hasBudgetLimit && budgetLimitNumber
      ? itemsInGroup.slice((budgetPageNumber - 1) * budgetLimitNumber, budgetPageNumber * budgetLimitNumber)
      : itemsInGroup;
    paginatedGroupedBudgetItems[folderName] = {
      items: paginatedItems,
      total: totalItems,
      page: budgetPageNumber,
      limit: budgetLimitNumber || totalItems,
    };
  });

  return { paginatedGroupedBudgetItems, budgetTotal: filteredBudgetItems.length, budgetPageNumber, budgetLimitNumber };
}

async function fetchServiceItems(workspaceId, boardId, getFolderIdsForQuery, Item, error, req) {
  const serviceFolderIds = await getFolderIdsForQuery('Master Plan,Shift Planning and Reporting');
  const serviceBaseQuery = {
    workspaceId: mongoEq(workspaceId),
    boardId: mongoEq(boardId),
  };
  if (serviceFolderIds?.length > 0) serviceBaseQuery.folderId = { $in: serviceFolderIds };

  try {
    return await Item.find(serviceBaseQuery).lean();
  } catch (dbErr) {
    error('Items-Service', 'Database query error for service items', {
      message: dbErr.message,
      stack: dbErr.stack,
      workspaceId,
      boardId,
    }, req ?? null);
    return { error: { status: 500, body: { message: 'Error fetching service items for monthly statement', error: dbErr.message } } };
  }
}

async function loadServiceProfileMaps(allServiceItems, workspaceId, boardId, ATTRIBUTE_NAMES, deps) {
  const serviceParticipantProfileIds = new Set();
  const serviceFundingSourceIds = new Set();
  for (const item of allServiceItems) {
    const ppId = deps.extractRefId(getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE));
    if (ppId) serviceParticipantProfileIds.add(ppId);
    deps.extractAllRefIds(getValueFromItem(item, ATTRIBUTE_NAMES.FUNDING_SOURCE))
      .forEach((id) => serviceFundingSourceIds.add(id));
  }

  const earlyRefIds = [...serviceParticipantProfileIds, ...serviceFundingSourceIds];
  const serviceProfilesAndFsMap = await deps.bulkFetchReferenceItemsFromDB(workspaceId, boardId, earlyRefIds);

  const serviceProfilesMap = new Map();
  const fundingSourceRefMap = new Map();
  for (const [key, value] of serviceProfilesAndFsMap) {
    if (serviceParticipantProfileIds.has(key)) serviceProfilesMap.set(key, value);
    if (serviceFundingSourceIds.has(key)) fundingSourceRefMap.set(key, value);
  }

  return { serviceProfilesMap, fundingSourceRefMap, serviceParticipantProfileIds, serviceFundingSourceIds };
}

function processServiceItemsForFiltering(allServiceItems, ATTRIBUTE_NAMES, deps, serviceProfilesMap, fundingSourceRefMap, TRANSACTION_STATUS_USE_ACTUAL_END) {
  const normalizeString = (value) => (value || '').toString().trim().toLowerCase().replace(/\.+$/, '');

  return allServiceItems.map((item) => {
    const scheduledStart = getValueFromItem(item, ATTRIBUTE_NAMES.SCHEDULED_START);
    const actualEnd = getValueFromItem(item, ATTRIBUTE_NAMES.ACTUAL_END);
    const participantProfileValue = getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
    const transactionStatusFormatted = formatMonthlyStatementStatus(getValueFromItem(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS));
    const useActualEndForFilter = normalizeString(transactionStatusFormatted) === normalizeString(TRANSACTION_STATUS_USE_ACTUAL_END);
    const scheduledStartDate = parseDate(scheduledStart);
    const actualEndDate = parseDate(actualEnd);
    const filterDate = useActualEndForFilter ? actualEndDate : scheduledStartDate;

    let participantName = '';
    const participantId = deps.extractRefId(participantProfileValue);
    if (participantId) {
      participantName = deps.getParticipantNameFromProfile(serviceProfilesMap.get(participantId)) || '';
    }
    if (!participantName) {
      participantName = getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
    }

    let fundingSourceResolved = '';
    const fsIds = deps.extractAllRefIds(getValueFromItem(item, ATTRIBUTE_NAMES.FUNDING_SOURCE));
    if (fsIds.length > 0) {
      fundingSourceResolved = fsIds
        .map((fsId) => deps.getFundingSourceNameFromItem(fundingSourceRefMap.get(fsId)))
        .filter(Boolean)
        .join(', ');
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
      unitValue: getValueFromItem(item, ATTRIBUTE_NAMES.UNIT) || '',
    };
  });
}

function filterServiceItems(processedServiceItems, filters, warn, req) {
  let filteredServiceItems = processedServiceItems;
  const { participant, startDate, endDate, fundingSourceFilter, serviceTransactionStatusFilter } = filters;

  if (participant) {
    try {
      const escapedParticipant = participant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const participantRegex = new RegExp(escapedParticipant, 'i');
      filteredServiceItems = filteredServiceItems.filter((p) =>
        participantRegex.test(p.participantName) ||
        (p.participantProfileValue && (
          (typeof p.participantProfileValue === 'string' && participantRegex.test(p.participantProfileValue)) ||
          (Array.isArray(p.participantProfileValue) && p.participantProfileValue.some((v) => participantRegex.test(String(v)))) ||
          (typeof p.participantProfileValue === 'object' && p.participantProfileValue.id && participantRegex.test(String(p.participantProfileValue.id)))
        )),
      );
    } catch (regexErr) {
      warn('Items-Service', 'Invalid participant regex pattern', { pattern: participant, error: regexErr.message }, req ?? null);
    }
  }

  if (startDate) {
    const startDateObj = new Date(startDate);
    filteredServiceItems = filteredServiceItems.filter((p) => p.filterDate && p.filterDate >= startDateObj);
  }
  if (endDate) {
    const endDateObj = new Date(endDate);
    filteredServiceItems = filteredServiceItems.filter((p) => p.filterDate && p.filterDate <= endDateObj);
  }
  if (fundingSourceFilter && fundingSourceFilter !== 'all') {
    const fsFilterValue = String(fundingSourceFilter).trim();
    filteredServiceItems = filteredServiceItems.filter((p) =>
      p.fundingSourceResolved && p.fundingSourceResolved === fsFilterValue,
    );
  }
  if (serviceTransactionStatusFilter && String(serviceTransactionStatusFilter).trim() !== '' && String(serviceTransactionStatusFilter).toLowerCase() !== 'all') {
    const filterValue = String(serviceTransactionStatusFilter).trim();
    filteredServiceItems = filteredServiceItems.filter((p) =>
      p.transactionStatusFormatted && p.transactionStatusFormatted === filterValue,
    );
  }

  return filteredServiceItems;
}

function paginateServiceItems(filteredServiceItems, servicePage, serviceLimitParam, serviceSortBy, serviceSortOrder) {
  const sortByDate = serviceSortBy === 'scheduledServiceDate' || serviceSortBy === 'serviceDeliveryDate';
  const useDeliveryDate = serviceSortBy === 'serviceDeliveryDate';
  filteredServiceItems.sort((a, b) => compareServiceItems(a, b, { sortByDate, useDeliveryDate, serviceSortOrder }));

  const serviceTotal = filteredServiceItems.length;
  const hasServiceLimit = serviceLimitParam !== undefined && serviceLimitParam !== null && serviceLimitParam !== '';
  let serviceLimitNumber = hasServiceLimit ? parseInt(serviceLimitParam, 10) : null;
  if (hasServiceLimit && (isNaN(serviceLimitNumber) || serviceLimitNumber <= 0)) serviceLimitNumber = 10;
  const servicePageNumber = hasServiceLimit
    ? (parseInt(servicePage, 10) > 0 ? parseInt(servicePage, 10) : 1)
    : 1;
  const serviceSkip = hasServiceLimit && serviceLimitNumber
    ? (servicePageNumber - 1) * serviceLimitNumber
    : 0;
  const paginatedServiceItems = hasServiceLimit && serviceLimitNumber
    ? filteredServiceItems.slice(serviceSkip, serviceSkip + serviceLimitNumber)
    : filteredServiceItems;

  return { paginatedServiceItems, serviceTotal, servicePageNumber, serviceLimitNumber };
}

async function loadServiceTransformRefMap(serviceItems, serviceProfilesMap, workspaceId, boardId, ATTRIBUTE_NAMES, deps) {
  const msServicePlanIds = new Set();
  const msParticipantProfileIds = new Set();
  const msFundingSourceIds = new Set();
  const msAssociatedProviderIds = new Set();

  for (const item of serviceItems) {
    const getValue = (attributeName) => (item.data ? item.data[attributeName] ?? null : null);
    const spId = deps.extractRefId(getValue(ATTRIBUTE_NAMES.SERVICE_PLAN));
    if (spId) msServicePlanIds.add(spId);
    const ppId = deps.extractRefId(getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE));
    if (ppId) msParticipantProfileIds.add(ppId);
    deps.extractAllRefIds(getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE)).forEach((id) => msFundingSourceIds.add(id));
    const apId = deps.extractRefId(getValue(ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER));
    if (apId) msAssociatedProviderIds.add(apId);
  }

  const msParticipantProfileIdsToFetch = [...msParticipantProfileIds].filter((id) => !serviceProfilesMap.has(id));
  const msAllRefIds = [...msServicePlanIds, ...msParticipantProfileIdsToFetch, ...msFundingSourceIds, ...msAssociatedProviderIds];
  const msRefItemsMap = await deps.bulkFetchReferenceItemsFromDB(workspaceId, boardId, msAllRefIds);
  for (const [key, value] of serviceProfilesMap) msRefItemsMap.set(key, value);

  return { msRefItemsMap, msServicePlanIds, msParticipantProfileIds, msParticipantProfileIdsToFetch, msFundingSourceIds };
}

function createBudgetAggregate() {
  return {
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
    hscmItemCount: 0,
  };
}

function determineServiceCategoryCodeFromItem(p, ATTRIBUTE_NAMES) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map((v) => String(v || '')).join(' ').toLowerCase();
    return (value || '').toString().toLowerCase();
  };
  const haystack = `${normalize(getValueFromItem(p.item, ATTRIBUTE_NAMES.FUNDING_SOURCE))} ${normalize(getValueFromItem(p.item, ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '')}`;
  return determineCategoryCodeForService({ fundingSource: haystack, service: '', notes: '' });
}

function buildSummaryAndAggregates(filteredServiceItems, filteredBudgetItems, ATTRIBUTE_NAMES) {
  const budgetCategoryAggregates = {};

  const summaryTotals = filteredServiceItems.reduce((acc, p) => {
    const quantity = p.quantityNum || 0;
    const unit = (p.unitValue || '').toString().toLowerCase();
    const hours = unit.includes('hour') ? quantity : 0;
    return {
      totalServices: acc.totalServices + 1,
      totalHours: acc.totalHours + hours,
      totalAmount: acc.totalAmount + (p.totalAmountNum || 0),
      govSubsidy: acc.govSubsidy + (p.govSubsidyNum || 0),
      participantContribution: acc.participantContribution + (p.participantContributionNum || 0),
    };
  }, { totalServices: 0, totalHours: 0, totalAmount: 0, govSubsidy: 0, participantContribution: 0 });

  filteredServiceItems.forEach((p) => {
    const code = determineServiceCategoryCodeFromItem(p, ATTRIBUTE_NAMES);
    if (!budgetCategoryAggregates[code]) budgetCategoryAggregates[code] = createBudgetAggregate();
    const aggregate = budgetCategoryAggregates[code];
    aggregate.govSubsidyAmount += p.govSubsidyNum || 0;
    aggregate.participantContributionAmount += p.participantContributionNum || 0;
    aggregate.serviceCount += 1;
  });

  filteredBudgetItems.forEach((item) => {
    const code = item.categoryCode || 'HSQ';
    if (!budgetCategoryAggregates[code]) budgetCategoryAggregates[code] = createBudgetAggregate();
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
    if (monthLabel) aggregate.months.add(monthLabel);
  });

  Object.values(budgetCategoryAggregates).forEach((aggregate) => {
    if (aggregate.months?.size > 0) {
      aggregate.expenditurePeriodLabel = Array.from(aggregate.months).join(', ');
    }
    if (aggregate.fundingStartDate || aggregate.fundingEndDate) {
      aggregate.availableBalanceRangeLabel = [aggregate.fundingStartDate, aggregate.fundingEndDate].filter(Boolean).join(' - ');
    }
    const visibilityFields = [
      aggregate.availableFunds, aggregate.remainingBudget, aggregate.serviceDeliveredAmount,
      aggregate.adjustmentAmount, aggregate.committedFunds, aggregate.previousMonthSpending,
      aggregate.fundAmount, aggregate.hscmTotalAllocatedTime, aggregate.hscmTotalReceivedAmount,
      aggregate.hscmTotalAllocatedAmount, aggregate.hscmItemCount,
    ];
    aggregate.shouldDisplay = visibilityFields.some((value) => Math.abs(value || 0) > 0.009);
    delete aggregate.months;
  });

  return {
    summary: {
      ...summaryTotals,
      averageServiceCost: summaryTotals.totalServices > 0
        ? summaryTotals.totalAmount / summaryTotals.totalServices
        : 0,
    },
    budgetCategoryAggregates,
  };
}


function applyFundingStreamProfileEntry(budgetDataFromProfile, fsNameLower, getValue, ATTRIBUTE_NAMES, REF_ATTRIBUTE_NAMES) {
  if (fsNameLower.includes('home support') || fsNameLower.includes('hs')) {
    budgetDataFromProfile.homeSupport = {
      totalAvailableBudget: getValue('Total Available Budget for Home Support ($)') || getValue('Remaining Home Support Balance as at the End of the Month ($)') || 0,
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
      fundAmount: getValue(ATTRIBUTE_NAMES.FUND_AMOUNT) || 0,
    };
    return;
  }
  if (fsNameLower.includes('restorative care')) {
    budgetDataFromProfile.restorativeCare = {
      totalAvailableBudget: getValue('Total Available Budget for Restorative Care ($)') || 0,
      remainingBalance: getValue(REF_ATTRIBUTE_NAMES.REMAINING_RESTORATIVE_END_OF_MONTH) || 0,
      fundingEndDate: getValue('Funding End Date') || null,
    };
    return;
  }
  if (fsNameLower.includes('end-of-life') || fsNameLower.includes('end of life')) {
    budgetDataFromProfile.endOfLife = {
      totalAvailableBudget: getValue('Total Available Budget for End-of-Life Care ($)') || 0,
      remainingBalance: getValue(REF_ATTRIBUTE_NAMES.REMAINING_END_OF_LIFE_END_OF_MONTH) || 0,
      fundingEndDate: getValue('Funding End Date') || null,
    };
    return;
  }
  if (fsNameLower.includes('assistive') && fsNameLower.includes('short')) {
    budgetDataFromProfile.assistiveTechShortTerm = {
      totalAvailableBudget: getValue('Total Available Budget for Assistive Technology - Short-term ($)') || 0,
      remainingBalance: getValue('Remaining AT - Short-term Balance for Allocation Period ($)') || 0,
      fundingEndDate: getValue('Funding End Date') || null,
      committedFunds: getValue('Committed AT Short-term Funds - to be delivered ($-)') || 0,
    };
    return;
  }
  if (fsNameLower.includes('assistive') && fsNameLower.includes('ongoing')) {
    budgetDataFromProfile.assistiveTechOngoing = {
      totalAvailableBudget: getValue('Total Available Budget for Assistive Technology - Ongoing ($)') || 0,
      remainingBalance: getValue('Remaining AT - Ongoing Balance for Allocation Period ($)') || 0,
      fundingEndDate: getValue('Funding End Date') || null,
      committedFunds: getValue('Committed AT Ongoing Funds - to be delivered ($-)') || 0,
    };
    return;
  }
  if (fsNameLower.includes('modification')) {
    budgetDataFromProfile.homeModification = {
      totalAvailableBudget: getValue('Total Available Budget for Home Modification ($)') || 0,
      remainingBalance: getValue('Remaining HM Balance for Allocation Period ($)') || 0,
      fundingEndDate: getValue('Funding End Date') || null,
      committedFunds: getValue('Committed HM Funds - to be delivered ($-)') || 0,
    };
  }
}

async function fetchBudgetDataFromProfile(participantProfileId, workspaceId, boardId, deps, warn, req) {
  if (!participantProfileId) return null;
  try {
    const participantProfileItem = await deps.Item.findOne({
      workspaceId: mongoEq(workspaceId),
      boardId: mongoEq(boardId),
      itemId: mongoEq(participantProfileId),
    }).lean();
    if (!participantProfileItem?.data) return null;

    const fundingSourceIds = deps.extractAllRefIds(
      deps.getValueFromFlatData(participantProfileItem, deps.ATTRIBUTE_NAMES.FUNDING_SOURCE),
    );
    if (!fundingSourceIds.length) return null;

    const fundingStreamItemsMap = await deps.bulkFetchReferenceItemsFromDB(workspaceId, boardId, fundingSourceIds);
    const budgetDataFromProfile = {
      homeSupport: null,
      restorativeCare: null,
      endOfLife: null,
      assistiveTechShortTerm: null,
      assistiveTechOngoing: null,
      homeModification: null,
    };

    for (const fsId of fundingSourceIds) {
      const fsItem = fundingStreamItemsMap.get(fsId);
      if (!fsItem?.data) continue;
      const fsName = deps.getFundingSourceNameFromItem(fsItem);
      if (!fsName) continue;

      const getValue = (attrName) => {
        const value = deps.getValueFromFlatData(fsItem, attrName);
        if (!value) return null;
        if (attrName.includes('Date')) return value.toString();
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && value.includes('$')) return parseFloat(value.replace(/[^0-9.-]/g, '')) || 0;
        return parseFloat(value) || 0;
      };

      applyFundingStreamProfileEntry(
        budgetDataFromProfile,
        fsName.toLowerCase(),
        getValue,
        deps.ATTRIBUTE_NAMES,
        deps.REF_ATTRIBUTE_NAMES,
      );
    }
    return budgetDataFromProfile;
  } catch (err) {
    warn('Items-Service', 'Failed to fetch budget data from profile', { message: err.message, participantProfileId }, req ?? null);
    return null;
  }
}

function extractProfileString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value.name) return value.name;
  return value.toString ? value.toString() : '';
}

function resolveParticipantProfileId({
  filteredBudgetItems,
  transformedServiceItems,
  allServiceItems,
  ATTRIBUTE_NAMES,
}) {
  let participantProfileId = filteredBudgetItems.find((item) => item.participantProfileId)?.participantProfileId || null;
  if (participantProfileId) return participantProfileId;

  participantProfileId = transformedServiceItems.find((service) => service.participantProfileId)?.participantProfileId || null;
  if (participantProfileId) return participantProfileId;

  const rawServiceWithProfile = allServiceItems.find((rawItem) => rawItem?.data?.[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]);
  if (!rawServiceWithProfile) return null;

  const profileValue = rawServiceWithProfile.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE];
  if (Array.isArray(profileValue) && profileValue.length > 0) return profileValue[0].toString();
  if (profileValue) return profileValue.toString();
  return null;
}

function parseParticipantStateValue(stateValue) {
  if (!stateValue) return '';
  if (typeof stateValue === 'object' && stateValue.name) return stateValue.name;
  if (typeof stateValue === 'string') return stateValue;
  if (Array.isArray(stateValue) && stateValue.length > 0) {
    const first = stateValue[0];
    return typeof first === 'object' && first.name ? first.name : String(first);
  }
  return '';
}

function populateProfileDetailsFromValues(participantProfileValues, ATTRIBUTE_NAMES, getValueFromFlatData, participantFallback) {
  const getProfileValue = (attributeName) => {
    const value = getValueFromFlatData(participantProfileValues, attributeName);
    return value ? extractProfileString(value) : '';
  };

  return {
    participantFullName: getProfileValue(ATTRIBUTE_NAMES.FULL_NAME)
      || getProfileValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME)
      || participantFallback,
    participantAddress: getProfileValue(ATTRIBUTE_NAMES.ADDRESS),
    participantSuburb: getProfileValue(ATTRIBUTE_NAMES.SUBURB),
    participantState: parseParticipantStateValue(getValueFromFlatData(participantProfileValues, ATTRIBUTE_NAMES.STATE)),
    participantPostcode: getProfileValue(ATTRIBUTE_NAMES.POSTCODE) || getProfileValue(ATTRIBUTE_NAMES.POST_CODE),
    myAgedCareIdNumber: getProfileValue(ATTRIBUTE_NAMES.MY_AGED_CARE_ID) || getProfileValue(ATTRIBUTE_NAMES.MY_AGED_CARE_ID_ALT),
    providerIdFromProfile: getProfileValue(ATTRIBUTE_NAMES.PROVIDER_ID),
  };
}

function resolveParticipantProfileDetails(params) {
  const {
    filteredBudgetItems,
    transformedServiceItems,
    allServiceItems,
    msRefItemsMap,
    budgetProfilesMap,
    participant,
    ATTRIBUTE_NAMES,
    getValueFromFlatData,
  } = params;

  const participantProfileId = resolveParticipantProfileId({
    filteredBudgetItems,
    transformedServiceItems,
    allServiceItems,
    ATTRIBUTE_NAMES,
  });

  const participantFallback = typeof participant === 'string' ? participant : '';
  const participantProfileValues = participantProfileId
    ? (msRefItemsMap.get(participantProfileId) || budgetProfilesMap.get(participantProfileId))
    : null;

  const details = participantProfileValues
    ? populateProfileDetailsFromValues(participantProfileValues, ATTRIBUTE_NAMES, getValueFromFlatData, participantFallback)
    : {
      participantFullName: participantFallback,
      participantAddress: '',
      participantSuburb: '',
      participantState: '',
      participantPostcode: '',
      myAgedCareIdNumber: '',
      providerIdFromProfile: '',
    };

  return { participantProfileId, ...details };
}

function buildSingleBudgetCategory(config, context) {
  const {
    profileData,
    budgetAggregate,
    quarterMonths,
    yearStr,
    defaultFundingEndDate,
  } = context;

  const categoryName = config.code === 'HSQ'
    ? `Home Support Quarterly Budget ${quarterMonths.start} ~ ${quarterMonths.end} ${yearStr}`
    : config.folderName;
  const isAllocationCategory = ['ATS', 'ATO', 'HMB'].includes(config.code);
  const fundingEndDate = isAllocationCategory
    ? (budgetAggregate.fundingEndDate || null)
    : (budgetAggregate.fundingEndDate || profileData.fundingEndDate || defaultFundingEndDate);
  const remainingBalanceAllocationPeriod = isAllocationCategory
    ? (budgetAggregate.remainingBalanceAllocationPeriod ?? budgetAggregate.remainingBudget ?? profileData.remainingBalance ?? 0)
    : undefined;
  const remainingBalanceEndOfMonth = isAllocationCategory
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
      hscmItemCount: budgetAggregate.hscmItemCount || 0,
    }),
    deliveredAmount: budgetAggregate.serviceDeliveredAmount || 0,
    totalAvailableBudget: budgetAggregate.availableFunds || profileData.totalAvailableBudget || 0,
  };
}

function getQuarterMonthsForMonth(monthNum) {
  const numericMonth = parseInt(monthNum, 10) || 1;
  if (numericMonth >= 1 && numericMonth <= 3) return { start: 'January', end: 'March' };
  if (numericMonth >= 4 && numericMonth <= 6) return { start: 'April', end: 'June' };
  if (numericMonth >= 7 && numericMonth <= 9) return { start: 'July', end: 'September' };
  return { start: 'October', end: 'December' };
}

function resolveBudgetParticipantName(participantProfileIdValue, deps, budgetProfilesMap) {
  if (!participantProfileIdValue) return '';
  const profileIdStr = deps.extractRefId(participantProfileIdValue);
  if (!profileIdStr) return '';
  return deps.getParticipantNameFromProfile(budgetProfilesMap.get(profileIdStr)) || '';
}

function buildBudgetCategories({
  BUDGET_CATEGORY_CONFIG,
  budgetDataFromProfile,
  budgetCategoryAggregates,
  month,
  year,
}) {
  const monthNum = parseInt(month, 10) || 1;
  const yearStr = (year || new Date().getFullYear().toString()).toString();
  const quarterMonths = getQuarterMonthsForMonth(monthNum);
  const defaultFundingEndDate = new Date(parseInt(yearStr, 10), 11, 31).toISOString();

  return BUDGET_CATEGORY_CONFIG.map((config) => buildSingleBudgetCategory(config, {
    profileData: budgetDataFromProfile?.[config.profileKey] || {},
    budgetAggregate: budgetCategoryAggregates[config.code] || createBudgetAggregate(),
    quarterMonths,
    yearStr,
    defaultFundingEndDate,
  }));
}

export async function getMonthlyStatementData({ workspaceId, boardId, query, req }, deps) {
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
    serviceFundingSource: fundingSourceFilter = '',
  } = query;

  const {
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    BUDGET_CATEGORY_CONFIG,
    BUDGET_CATEGORY_ORDER,
    TRANSACTION_STATUS_USE_ACTUAL_END,
  } = deps;

  let businessProfile = null;
  try {
    businessProfile = await deps.Business.findOne({ workspaceId: mongoEq(workspaceId) })
      .select('name phone email companyRegistrationId address headOfficeTimezone')
      .lean();
  } catch (err) {
    deps.warn('Items-Service', 'Failed to fetch business name', { message: err.message, workspaceId }, req ?? null);
  }

  let folders = [];
  try {
    const { folder } = await deps.getFolder(workspaceId, boardId);
    folders = Array.isArray(folder) ? folder : [];
  } catch (folderErr) {
    deps.warn('Items-Service', 'Failed to fetch folders', { message: folderErr.message, workspaceId, boardId }, req ?? null);
  }

  const { folderIdToName, folderIdToCode } = buildFolderMaps(folders, BUDGET_CATEGORY_CONFIG);
  const getFolderIdsForQuery = createFolderIdResolver(folders);
  const itemDataHelpers = createItemDataHelpers();
  const { getValueFromItemMulti, accessors } = itemDataHelpers;
  const stmtTimezone = businessProfile?.headOfficeTimezone || 'Australia/Sydney';
  const { getMonthLabelFromDate, getYearFromDate } = createBudgetDateHelpers(stmtTimezone);

  const allBudgetItemsResult = await fetchBudgetItems(workspaceId, boardId, getFolderIdsForQuery, deps.Item, deps.error, req);
  if (allBudgetItemsResult?.error) return allBudgetItemsResult;
  const allBudgetItems = allBudgetItemsResult;

  const { budgetProfilesMap, primarySupplementMap, budgetParticipantProfileIds } = await loadBudgetReferenceMaps(
    allBudgetItems,
    workspaceId,
    boardId,
    { ...deps, getValueFromItemMulti },
    accessors,
  );

  deps.info('Items-Service', 'Bulk fetched participant profiles from DB (monthly-statement budget)', {
    profileIds: budgetParticipantProfileIds.size,
    foundProfiles: budgetProfilesMap.size,
  }, req ?? null);

  const resolveParticipantName = (participantProfileIdValue) =>
    resolveBudgetParticipantName(participantProfileIdValue, deps, budgetProfilesMap);

  const budgetTransformContext = {
    workspaceId,
    boardId,
    folderIdToName,
    folderIdToCode,
    BUDGET_CATEGORY_CONFIG,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    accessors,
    getValueFromItemMulti,
    parseNumberValue: parseMonthlyStatementNumberValue,
    resolveParticipantName,
    resolveReferenceValue: (value, refMap) =>
      resolveReferenceValue(value, refMap, deps.isUuidLike, deps.getReferenceDisplayName),
    primarySupplementMap,
    getCachedMSBudget: deps.getCachedMSBudget,
    setCachedMSBudget: deps.setCachedMSBudget,
    getFirstReferenceId: accessors.getFirstReferenceId,
    getNumberFromItem: accessors.getNumberFromItem,
    getMonthLabelFromDate,
    getYearFromDate,
    determineCategoryCodeForBudget: (item) =>
      determineCategoryCodeForBudgetItem(item, folderIdToCode, deps.getValueFromFlatData, ATTRIBUTE_NAMES),
  };

  const transformedAllBudgetItems = allBudgetItems.map((item) =>
    transformMonthlyStatementBudgetItem(item, budgetTransformContext),
  );

  const { filteredBudgetItems, normalizedMonth, targetMonthLabel, monthLabelLookup } = filterBudgetItems(
    transformedAllBudgetItems,
    { participant, month, year },
  );

  const {
    paginatedGroupedBudgetItems,
    budgetTotal,
    budgetPageNumber,
    budgetLimitNumber,
  } = paginateBudgetItems(filteredBudgetItems, budgetPage, budgetLimitParam, BUDGET_CATEGORY_ORDER);

  const allServiceItemsResult = await fetchServiceItems(workspaceId, boardId, getFolderIdsForQuery, deps.Item, deps.error, req);
  if (allServiceItemsResult?.error) return allServiceItemsResult;
  const allServiceItems = allServiceItemsResult;

  const {
    serviceProfilesMap,
    fundingSourceRefMap,
    serviceParticipantProfileIds,
    serviceFundingSourceIds,
  } = await loadServiceProfileMaps(allServiceItems, workspaceId, boardId, ATTRIBUTE_NAMES, deps);

  deps.info('Items-Service', 'Bulk fetched participant profiles and funding sources from DB (monthly-statement service processing)', {
    profileIds: serviceParticipantProfileIds.size,
    foundProfiles: serviceProfilesMap.size,
    fundingSourceIds: serviceFundingSourceIds.size,
    foundFundingSources: fundingSourceRefMap.size,
  }, req ?? null);

  const processedServiceItems = processServiceItemsForFiltering(
    allServiceItems,
    ATTRIBUTE_NAMES,
    deps,
    serviceProfilesMap,
    fundingSourceRefMap,
    TRANSACTION_STATUS_USE_ACTUAL_END,
  );

  const filteredServiceItems = filterServiceItems(processedServiceItems, {
    participant,
    startDate,
    endDate,
    fundingSourceFilter,
    serviceTransactionStatusFilter,
  }, deps.warn, req);

  const distinctTransactionStatuses = [...new Set(
    filteredServiceItems.map((p) => p.transactionStatusFormatted).filter((status) => Boolean(status)),
  )].sort((a, b) => a.localeCompare(b));
  const distinctFundingSources = [...new Set(
    filteredServiceItems.map((p) => p.fundingSourceResolved).filter((source) => Boolean(source)),
  )].sort((a, b) => a.localeCompare(b));

  const {
    paginatedServiceItems,
    serviceTotal,
    servicePageNumber,
    serviceLimitNumber,
  } = paginateServiceItems(filteredServiceItems, servicePage, serviceLimitParam, serviceSortBy, serviceSortOrder);

  const serviceItems = paginatedServiceItems.map((p) => p.item);
  const {
    msRefItemsMap,
    msServicePlanIds,
    msParticipantProfileIds,
    msParticipantProfileIdsToFetch,
    msFundingSourceIds,
  } = await loadServiceTransformRefMap(serviceItems, serviceProfilesMap, workspaceId, boardId, ATTRIBUTE_NAMES, deps);

  deps.info('Items-Service', 'Bulk fetched reference items from DB (monthly-statement service)', {
    servicePlans: msServicePlanIds.size,
    participantProfiles: msParticipantProfileIds.size,
    participantProfilesAlreadyFetched: serviceProfilesMap.size,
    participantProfilesNewlyFetched: msParticipantProfileIdsToFetch.length,
    fundingSources: msFundingSourceIds.size,
    totalFound: msRefItemsMap.size,
  }, req ?? null);

  const serviceTransformContext = {
    workspaceId,
    boardId,
    msRefItemsMap,
    businessProfile,
    ATTRIBUTE_NAMES,
    deps,
  };
  const transformedServiceItems = serviceItems.map((item) =>
    transformMonthlyStatementServiceItem(item, serviceTransformContext),
  );

  const { summary, budgetCategoryAggregates } = buildSummaryAndAggregates(
    filteredServiceItems,
    filteredBudgetItems,
    ATTRIBUTE_NAMES,
  );

  const profileDetails = resolveParticipantProfileDetails({
    filteredBudgetItems,
    transformedServiceItems,
    allServiceItems,
    msRefItemsMap,
    budgetProfilesMap,
    participant,
    ATTRIBUTE_NAMES,
    getValueFromFlatData: deps.getValueFromFlatData,
  });

  const budgetDataFromProfile = await fetchBudgetDataFromProfile(
    profileDetails.participantProfileId,
    workspaceId,
    boardId,
    deps,
    deps.warn,
    req,
  );

  const budgetCategories = buildBudgetCategories({
    BUDGET_CATEGORY_CONFIG,
    budgetDataFromProfile,
    budgetCategoryAggregates,
    month,
    year,
  });

  const providerIdValue = businessProfile?.companyRegistrationId || profileDetails.providerIdFromProfile || null;
  const monthLabelForResponse = targetMonthLabel
    || (normalizedMonth && monthLabelLookup[normalizedMonth])
    || normalizedMonth
    || '';
  const monthNumberForResponse = normalizedMonth || (typeof month === 'string' ? month : '');
  const participantNameForResponse = profileDetails.participantFullName || (typeof participant === 'string' ? participant : '');

  return {
    budgetItems: {
      items: paginatedGroupedBudgetItems,
      total: budgetTotal,
      page: budgetPageNumber,
      limit: budgetLimitNumber || budgetTotal,
    },
    serviceItems: {
      items: transformedServiceItems,
      total: serviceTotal,
      page: servicePageNumber,
      limit: serviceLimitNumber,
      distinctTransactionStatuses,
      distinctFundingSources,
    },
    budgetCategories,
    participant: participantNameForResponse,
    participantProfile: participantNameForResponse,
    participantAddress: profileDetails.participantAddress,
    participantSuburb: profileDetails.participantSuburb,
    participantState: profileDetails.participantState,
    participantPostcode: profileDetails.participantPostcode,
    myAgedCareIdNumber: profileDetails.myAgedCareIdNumber,
    providerId: providerIdValue,
    month: monthLabelForResponse,
    monthNumber: monthNumberForResponse,
    year: (year || new Date().getFullYear().toString()).toString(),
    summary,
    fundingSources: distinctFundingSources,
  };
}
