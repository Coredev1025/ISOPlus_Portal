import { parseListPagination, matchesStatusFilter } from './itemsRouteHelpers.js';
import { getCachedTransform, setCachedTransform } from './transformCache.js';
import { toRequiredQueryString } from './securityHelpers.js';

function getValueFromItem(item, attributeName) {
  if (!item.data) return null;
  return item.data[attributeName] ?? null;
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

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function getLabelNames(item, attributeName) {
  if (!item.data) return [];
  const statusData = item.data[attributeName];
  if (!statusData) return [];

  if (Array.isArray(statusData) && statusData.length > 0) {
    return statusData.map((entry) => {
      if (typeof entry === 'object' && entry.name) return entry.name;
      return String(entry);
    });
  }
  if (typeof statusData === 'object' && statusData.name) return [statusData.name];
  if (typeof statusData === 'string') return [statusData];
  return [String(statusData)];
}

function getRawStatusData(item, attributeName) {
  if (!item.data) return null;
  return item.data[attributeName] ?? null;
}

async function processInvoiceGeneratorItems(allItems, ATTRIBUTE_NAMES, REF_ATTRIBUTE_NAMES, Item) {
  return Promise.all(allItems.map(async (item) => {
    const scheduledStart = getValueFromItem(item, ATTRIBUTE_NAMES.SCHEDULED_START);
    const actualEnd = getValueFromItem(item, ATTRIBUTE_NAMES.ACTUAL_END);
    const participantIds = getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE) || '';
    const participantId = participantIds.length > 0 ? participantIds[0] : '';
    let participantName = '';
    if (participantId) {
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
    };
  }));
}

function filterByDateRange(filteredItems, field, dateValue) {
  if (!dateValue) return filteredItems;
  const dateObj = new Date(dateValue);
  return filteredItems.filter((p) => p[field] && p[field] >= dateObj);
}

function filterByEndDate(filteredItems, field, dateValue) {
  if (!dateValue) return filteredItems;
  const dateObj = new Date(dateValue);
  return filteredItems.filter((p) => p[field] && p[field] <= dateObj);
}

function filterByParticipant(filteredItems, participant, warn, req) {
  if (!participant) return filteredItems;
  try {
    const escapedParticipant = participant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const participantRegex = new RegExp(escapedParticipant, 'i');
    return filteredItems.filter((p) => participantRegex.test(p.participantName));
  } catch (regexErr) {
    warn('Items-Service', 'Invalid participant regex pattern', {
      pattern: participant,
      error: regexErr.message,
    }, req ?? null);
    return filteredItems;
  }
}

function applyInvoiceGeneratorFilters(processedItems, filters, warn, req) {
  let filteredItems = processedItems;
  filteredItems = filterByDateRange(filteredItems, 'scheduledStartDate', filters.startDate);
  filteredItems = filterByEndDate(filteredItems, 'scheduledStartDate', filters.endDate);
  filteredItems = filterByDateRange(filteredItems, 'actualEndDate', filters.serviceDeliveryStart);
  filteredItems = filterByEndDate(filteredItems, 'actualEndDate', filters.serviceDeliveryEnd);
  filteredItems = filterByParticipant(filteredItems, filters.participant, warn, req);

  if (filters.transactionStatusFilter && filters.transactionStatusFilter !== 'all') {
    filteredItems = filteredItems.filter((p) =>
      matchesStatusFilter(p.transactionStatusNames, p.transactionStatusRaw, filters.transactionStatusFilter),
    );
  }

  if (filters.paymentStatusFilter && filters.paymentStatusFilter !== 'all') {
    filteredItems = filteredItems.filter((p) =>
      matchesStatusFilter(p.paymentStatusNames, p.paymentStatusRaw, filters.paymentStatusFilter),
    );
  }

  return filteredItems;
}

function computeInvoiceGeneratorTotals(filteredItems) {
  const totalsData = { totalAmount: 0, totalGovSubsidy: 0, totalParticipantContribution: 0, total: 0 };
  filteredItems.forEach((p) => {
    totalsData.totalAmount += p.totalAmountNum;
    totalsData.totalGovSubsidy += p.govSubsidyNum;
    totalsData.totalParticipantContribution += p.participantContributionNum;
    totalsData.total += 1;
  });
  return totalsData;
}

function compareSortValues(aVal, bVal, selectedSortOrder) {
  const aIsNull = aVal === null || aVal === undefined;
  const bIsNull = bVal === null || bVal === undefined;
  if (aIsNull && bIsNull) return 0;
  if (aIsNull) return 1;
  if (bIsNull) return -1;
  const aTime = aVal instanceof Date ? aVal.getTime() : aVal;
  const bTime = bVal instanceof Date ? bVal.getTime() : bVal;
  if (aTime < bTime) return -1 * selectedSortOrder;
  if (aTime > bTime) return 1 * selectedSortOrder;
  return 0;
}

function compareSecondaryUpdatedAt(a, b) {
  const aUpdated = a.item.updatedAt || a.item.createdAt || new Date(0);
  const bUpdated = b.item.updatedAt || b.item.createdAt || new Date(0);
  const aUpdTime = aUpdated instanceof Date ? aUpdated.getTime() : new Date(aUpdated).getTime();
  const bUpdTime = bUpdated instanceof Date ? bUpdated.getTime() : new Date(bUpdated).getTime();
  if (aUpdTime < bUpdTime) return 1;
  if (aUpdTime > bUpdTime) return -1;
  return 0;
}

function sortInvoiceGeneratorItems(filteredItems, sortBy, sortOrder) {
  const sortFieldMap = {
    scheduledServiceDate: 'scheduledStartDate',
    serviceDeliveryDate: 'actualEndDate',
    updatedAt: 'updatedAt',
  };
  const selectedSortField = sortFieldMap[sortBy] || 'scheduledStartDate';
  const selectedSortOrder = sortOrder === 'desc' ? -1 : 1;

  filteredItems.sort((a, b) => {
    let aVal;
    let bVal;
    if (selectedSortField === 'updatedAt') {
      aVal = a.item.updatedAt || a.item.createdAt || new Date(0);
      bVal = b.item.updatedAt || b.item.createdAt || new Date(0);
    } else {
      aVal = a[selectedSortField];
      bVal = b[selectedSortField];
    }

    const primary = compareSortValues(aVal, bVal, selectedSortOrder);
    if (primary !== 0) return primary;
    if (selectedSortField !== 'updatedAt') {
      const secondary = compareSecondaryUpdatedAt(a, b);
      if (secondary !== 0) return secondary;
    }
    return 0;
  });

  return filteredItems;
}

function collectInvoiceGeneratorRefIds(items, ATTRIBUTE_NAMES, extractRefId, extractAllRefIds) {
  const servicePlanIds = new Set();
  const participantProfileIds = new Set();
  const fundingSourceIds = new Set();

  for (const processedItem of items) {
    const item = processedItem.item;
    const getValue = (attributeName) => (item.data ? item.data[attributeName] ?? null : null);

    const spId = extractRefId(getValue(ATTRIBUTE_NAMES.SERVICE_PLAN));
    if (spId) servicePlanIds.add(spId);

    const ppId = extractRefId(getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE));
    if (ppId) participantProfileIds.add(ppId);

    extractAllRefIds(getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE)).forEach((id) => fundingSourceIds.add(id));
  }

  return { servicePlanIds, participantProfileIds, fundingSourceIds };
}

async function loadInvoiceGeneratorRefMap({
  workspaceId,
  boardId,
  servicePlanIds,
  participantProfileIds,
  fundingSourceIds,
  bulkFetchReferenceItemsFromDB,
  getValueFromFlatData,
  extractAllRefIds,
}) {
  const allRefIds = [...servicePlanIds, ...participantProfileIds, ...fundingSourceIds];
  const refItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, allRefIds);

  const nestedRefIds = new Set();
  const serviceRefAttrs = [
    'Home Support (HS)',
    'Assistive Technology (AT) - Short Term',
    'Assistive Technology (AT) - Ongoing',
    'Home Modification (HM)',
    'Health Professional',
    'Wraparound',
  ];

  for (const servicePlanId of servicePlanIds) {
    const servicePlanItem = refItemsMap.get(servicePlanId);
    if (!servicePlanItem?.data) continue;
    for (const refAttr of serviceRefAttrs) {
      extractAllRefIds(getValueFromFlatData(servicePlanItem, refAttr)).forEach((id) => nestedRefIds.add(id));
    }
  }

  if (nestedRefIds.size > 0) {
    const nestedRefItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, [...nestedRefIds]);
    for (const [key, value] of nestedRefItemsMap) {
      refItemsMap.set(key, value);
    }
  }

  return { refItemsMap, nestedRefIds };
}

function formatInvoiceStatus(value) {
  if (!value) return undefined;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => {
      if (typeof entry === 'object' && entry.name) return entry.name;
      return String(entry);
    }).filter(Boolean).join(', ');
  }
  if (typeof value === 'object' && value.name) return value.name;
  if (typeof value === 'string') return value;
  return String(value);
}

function resolveItemFirstPayment(itemFirstPaymentRaw) {
  if (typeof itemFirstPaymentRaw === 'boolean') {
    return itemFirstPaymentRaw ? 'True' : 'False';
  }
  if (typeof itemFirstPaymentRaw === 'string') {
    const normalized = itemFirstPaymentRaw.trim().toLowerCase();
    return ['true', 'y', 'yes'].includes(normalized) ? 'True' : 'False';
  }
  if (itemFirstPaymentRaw !== undefined && itemFirstPaymentRaw !== null) {
    return String(itemFirstPaymentRaw).trim().toLowerCase() === 'y' ? 'True' : 'False';
  }
  return 'False';
}

function resolveItemPurchasedMethod(itemPurchasedMethod) {
  if (!itemPurchasedMethod) return undefined;
  const methodName = typeof itemPurchasedMethod === 'object'
    ? (itemPurchasedMethod.name || '')
    : String(itemPurchasedMethod || '');
  if (!methodName) return undefined;
  const normalized = methodName.toLowerCase().trim();
  return normalized.includes('loan') ? 'LOANED' : 'PURCHASED';
}

function resolveLoanedFields(itemPurchasedMethodString, ifLoanedLenderName, ifLoanedLenderInvoiceNo) {
  if (itemPurchasedMethodString !== 'LOANED') {
    return { loanedByOrganisationName: '', loanedByInvoiceNumber: '' };
  }
  const ifLoanedLenderNameString = ifLoanedLenderName
    ? (typeof ifLoanedLenderName === 'object' ? ifLoanedLenderName.name : String(ifLoanedLenderName))
    : '';
  return {
    loanedByOrganisationName: ifLoanedLenderNameString || '',
    loanedByInvoiceNumber: ifLoanedLenderInvoiceNo || '',
  };
}

function resolveServicePlanFields(servicePlanItem, refItemsMap, deps) {
  const empty = {
    service: undefined,
    serviceIdentifier: undefined,
    itemDescriptionCode: '',
    itemDescription: '',
    wraparoundDescriptionCode: '',
    wraparoundDescription: '',
    healthProfessionalTypeCode: '',
    healthProfessionalTypeOther: '',
  };
  if (!servicePlanItem) return empty;

  return {
    service: deps.getServiceFromServicePlan(servicePlanItem),
    serviceIdentifier: deps.getServiceIdentifierFromServicePlan(servicePlanItem, refItemsMap),
    ...(() => {
      const itemDesc = deps.getItemDescriptionFromServicePlan(servicePlanItem, refItemsMap);
      const wraparound = deps.getWraparoundDescriptionFromServicePlan(servicePlanItem, refItemsMap);
      const healthProf = deps.getHealthProfessionalFromServicePlan(servicePlanItem, refItemsMap);
      return {
        itemDescriptionCode: itemDesc.code,
        itemDescription: itemDesc.description,
        wraparoundDescriptionCode: wraparound.code,
        wraparoundDescription: wraparound.description,
        healthProfessionalTypeCode: healthProf.typeCode,
        healthProfessionalTypeOther: healthProf.typeOther,
      };
    })(),
  };
}

function resolveFundingSourceNames(fundingSourceData, refItemsMap, extractAllRefIds, getFundingSourceNameFromItem) {
  if (!fundingSourceData) return undefined;
  const fundingSourceNames = [];
  for (const fsId of extractAllRefIds(fundingSourceData)) {
    const fsName = getFundingSourceNameFromItem(refItemsMap.get(fsId));
    if (fsName) fundingSourceNames.push(fsName);
  }
  return fundingSourceNames.length > 0 ? fundingSourceNames.join(', ') : undefined;
}

export function transformInvoiceGeneratorProcessedItem(processedItem, context) {
  const {
    workspaceId,
    boardId,
    refItemsMap,
    invoiceNumberMap,
    invoiceFileUrlMap,
    ATTRIBUTE_NAMES,
    deps,
  } = context;

  const item = processedItem.item;
  const itemId = item.itemId;
  const itemUpdatedAt = item.updatedAt || item.createdAt;
  const cachedData = getCachedTransform(workspaceId, boardId, itemId, itemUpdatedAt);

  if (cachedData) {
    return {
      ...cachedData,
      invoiceNumber: invoiceNumberMap.get(itemId) || cachedData.invoiceNumber,
      fileUrl: invoiceFileUrlMap.get(itemId) || cachedData.fileUrl,
    };
  }

  const getValue = (attributeName) => (item.data ? item.data[attributeName] ?? null : null);
  const invoiceNumber = invoiceNumberMap.get(itemId);
  const fileUrl = invoiceFileUrlMap.get(itemId) || null;

  const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START) || null;
  const unit = getValue(ATTRIBUTE_NAMES.UNIT) || '';
  const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;
  const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
  const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
  const govSubsidy = Number(getValue(ATTRIBUTE_NAMES.GOV_SUBSIDY)) || 0;
  const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;
  const notes = getValue(ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';

  const servicePlanRefId = deps.extractRefId(getValue(ATTRIBUTE_NAMES.SERVICE_PLAN));
  const servicePlanItem = servicePlanRefId ? refItemsMap.get(servicePlanRefId) : null;
  const serviceFields = resolveServicePlanFields(servicePlanItem, refItemsMap, deps);

  let careRecipientIdentifier;
  const participantProfileRefId = deps.extractRefId(getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE));
  const participantProfileItem = participantProfileRefId ? refItemsMap.get(participantProfileRefId) : null;
  if (participantProfileItem) {
    careRecipientIdentifier = deps.getMyAgedCareIdFromProfile(participantProfileItem);
  }

  const prescribedItem = getValue('Prescribed Item');
  const prescribedItemValue =
    prescribedItem === true || prescribedItem === 'true' || prescribedItem === 'Y' ? 'Y' : 'N';

  const itemFirstPaymentValue = resolveItemFirstPayment(getValue('Item First Payment'));
  const itemPurchasedMethodString = resolveItemPurchasedMethod(formatInvoiceStatus(getValue('Item Purchased Method')));
  const { loanedByOrganisationName, loanedByInvoiceNumber } = resolveLoanedFields(
    itemPurchasedMethodString,
    getValue('If Loaned, Lender Name'),
    getValue('If Loaned, Lender Invoice No.') || '',
  );

  const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END) || null;
  const deliveredBy = formatInvoiceStatus(getValue(ATTRIBUTE_NAMES.DELIVERED_BY));
  const deliveredByThirdParty = deliveredBy && deliveredBy.includes('Associated') ? 'True' : 'False';
  const paymentStatusFormatted = formatInvoiceStatus(
    getValue(ATTRIBUTE_NAMES.PAYMENT_STATUS) || getValue('Payment Status'),
  );
  const transactionStatusFormatted = formatInvoiceStatus(getValue(ATTRIBUTE_NAMES.TRANSACTION_STATUS));
  const fundingSource = resolveFundingSourceNames(
    getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE),
    refItemsMap,
    deps.extractAllRefIds,
    deps.getFundingSourceNameFromItem,
  );

  const normalizedUnit = typeof unit === 'string' ? unit.toLowerCase() : '';
  const isItemUnit = normalizedUnit === 'item';
  const serviceLabel = serviceFields.service || '';
  const isWraparound = serviceLabel.toLowerCase().includes('wraparound');

  const transformedData = {
    id: item.itemId,
    paymentStatus: paymentStatusFormatted,
    participant: processedItem?.participantName || '',
    service: serviceLabel,
    scheduledServiceDate: scheduledStart || null,
    serviceDeliveryDate: actualEnd || null,
    unit,
    quantity,
    unitPrice,
    totalAmount,
    govSubsidy,
    participantContribution,
    fundingSource,
    transactionStatus: transactionStatusFormatted,
    notes,
    fileUrl,
    invoiceNumber,
    careRecipientIdentifier,
    serviceIdentifier: serviceFields.serviceIdentifier,
    deliveredByThirdParty,
    itemOrWraparound: isItemUnit ? 'Item' : (isWraparound ? 'Wraparound' : ''),
    itemDescriptionCode: isItemUnit ? (serviceFields.itemDescriptionCode || '') : '',
    itemDescription: isItemUnit ? (serviceFields.itemDescription || '') : '',
    wraparoundDescriptionCode: isWraparound ? (serviceFields.wraparoundDescriptionCode || '') : '',
    wraparoundDescription: isWraparound ? (serviceFields.wraparoundDescription || '') : '',
    prescribedItem: prescribedItemValue,
    itemPurchasedMethod: itemPurchasedMethodString,
    loanedByOrganisationName,
    loanedByInvoiceNumber,
    healthProfessionalTypeCode: serviceFields.healthProfessionalTypeCode,
    healthProfessionalTypeOther: serviceFields.healthProfessionalTypeOther,
    itemFirstPayment: itemFirstPaymentValue,
  };

  setCachedTransform(workspaceId, boardId, item.itemId, transformedData);
  return transformedData;
}

export async function getInvoiceGeneratorData({ workspaceId, boardId, query, req }, deps) {
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
    sortOrder = 'asc',
  } = query;

  const { ATTRIBUTE_NAMES, REF_ATTRIBUTE_NAMES } = deps;
  const { limitNumber, applyPagination, skip } = parseListPagination(page, limitParam);

  const safeWorkspaceId = toRequiredQueryString(workspaceId);
  const safeBoardId = toRequiredQueryString(boardId);
  const baseQuery = { workspaceId: safeWorkspaceId, boardId: safeBoardId };
  const folderIds = await deps.getFolderIds('Master Plan,Shift Planning and Reporting', safeWorkspaceId, safeBoardId);
  if (folderIds?.length > 0) {
    baseQuery.folderId = { $in: folderIds };
  }

  let allItems;
  try {
    allItems = await deps.Item.find(baseQuery).lean();
  } catch (dbErr) {
    deps.error('Items-Service', 'Database query error', {
      message: dbErr.message,
      stack: dbErr.stack,
      workspaceId,
      boardId,
    }, req ?? null);
    return {
      error: { status: 500, body: { message: 'Error fetching invoice generator data', error: dbErr.message } },
    };
  }

  const processedItems = await processInvoiceGeneratorItems(
    allItems,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    deps.Item,
  );

  let filteredItems = applyInvoiceGeneratorFilters(processedItems, {
    startDate,
    endDate,
    serviceDeliveryStart,
    serviceDeliveryEnd,
    participant,
    transactionStatusFilter,
    paymentStatusFilter,
  }, deps.warn, req);

  const totalsData = computeInvoiceGeneratorTotals(filteredItems);
  filteredItems = sortInvoiceGeneratorItems(filteredItems, sortBy, sortOrder);

  const items = applyPagination && limitNumber
    ? filteredItems.slice(skip, skip + limitNumber)
    : filteredItems;

  const refIds = collectInvoiceGeneratorRefIds(items, ATTRIBUTE_NAMES, deps.extractRefId, deps.extractAllRefIds);
  const { refItemsMap, nestedRefIds } = await loadInvoiceGeneratorRefMap({
    workspaceId: safeWorkspaceId,
    boardId: safeBoardId,
    ...refIds,
    bulkFetchReferenceItemsFromDB: deps.bulkFetchReferenceItemsFromDB,
    getValueFromFlatData: deps.getValueFromFlatData,
    extractAllRefIds: deps.extractAllRefIds,
  });

  deps.info('Items-Service', 'Bulk fetched reference items from DB (invoice-generator)', {
    servicePlans: refIds.servicePlanIds.size,
    participantProfiles: refIds.participantProfileIds.size,
    fundingSources: refIds.fundingSourceIds.size,
    nestedRefs: nestedRefIds.size,
    totalFound: refItemsMap.size,
  }, req ?? null);

  const itemIdsForInvoice = items.map((p) => p.item.itemId);
  const invoiceNumbers = await deps.InvoiceNumber.find({
    workspaceId: safeWorkspaceId,
    boardId: safeBoardId,
    itemId: { $in: itemIdsForInvoice },
    type: 'PDF',
  }).lean();
  const invoiceNumberMap = new Map(invoiceNumbers.map((inv) => [inv.itemId, inv.invoiceNumber]));
  const invoiceFileUrlMap = new Map(invoiceNumbers.map((inv) => [inv.itemId, inv.pdfLink || null]));

  const transformContext = {
    workspaceId: safeWorkspaceId,
    boardId: safeBoardId,
    refItemsMap,
    invoiceNumberMap,
    invoiceFileUrlMap,
    ATTRIBUTE_NAMES,
    deps,
  };

  const transformedItems = items.map((processedItem) =>
    transformInvoiceGeneratorProcessedItem(processedItem, transformContext),
  );

  return {
    items: transformedItems,
    total: totalsData.total || 0,
    totalAmount: totalsData.totalAmount || 0,
    totalGovSubsidy: totalsData.totalGovSubsidy || 0,
    totalParticipantContribution: totalsData.totalParticipantContribution || 0,
  };
}
