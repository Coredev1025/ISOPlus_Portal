export function mapRawItemToProcessedInvoiceRow(item, helpers) {
  const { getValue, ATTRIBUTE_NAMES, parseDate, parseNumber, formatStatus, extractRefId, extractAllRefIds } = helpers;
  const scheduledStart = getValue(item, ATTRIBUTE_NAMES.SCHEDULED_START);
  const actualEnd = getValue(item, ATTRIBUTE_NAMES.ACTUAL_END);
  return {
    item,
    scheduledStartDate: parseDate(scheduledStart),
    actualEndDate: parseDate(actualEnd),
    participantName: '',
    totalAmountNum: parseNumber(getValue(item, ATTRIBUTE_NAMES.TOTAL_AMOUNT)),
    govSubsidyNum: parseNumber(getValue(item, ATTRIBUTE_NAMES.GOV_SUBSIDY)),
    participantContributionNum: parseNumber(getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)),
    transactionStatus: formatStatus(getValue(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS)),
    paymentStatus: formatStatus(getValue(item, ATTRIBUTE_NAMES.PAYMENT_STATUS)),
    servicePlanId: extractRefId(getValue(item, ATTRIBUTE_NAMES.SERVICE_PLAN)),
    participantProfileId: extractRefId(getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE)),
    fundingSourceIds: extractAllRefIds(getValue(item, ATTRIBUTE_NAMES.FUNDING_SOURCE)),
  };
}

export function applyInvoiceCsvDateAndStatusFilters(processedItems, filters) {
  const {
    startDate, endDate, serviceDeliveryStart, serviceDeliveryEnd,
    transactionStatusFilter, paymentStatusFilter,
  } = filters;
  let result = processedItems;
  if (startDate) {
    const startDateObj = new Date(startDate);
    result = result.filter((p) => p.scheduledStartDate && p.scheduledStartDate >= startDateObj);
  }
  if (endDate) {
    const endDateObj = new Date(endDate);
    result = result.filter((p) => p.scheduledStartDate && p.scheduledStartDate <= endDateObj);
  }
  if (serviceDeliveryStart) {
    const serviceDeliveryStartObj = new Date(serviceDeliveryStart);
    result = result.filter((p) => p.actualEndDate && p.actualEndDate >= serviceDeliveryStartObj);
  }
  if (serviceDeliveryEnd) {
    const serviceDeliveryEndObj = new Date(serviceDeliveryEnd);
    result = result.filter((p) => p.actualEndDate && p.actualEndDate <= serviceDeliveryEndObj);
  }
  if (transactionStatusFilter && transactionStatusFilter !== 'all') {
    result = result.filter((p) => p.transactionStatus === transactionStatusFilter);
  }
  if (paymentStatusFilter && paymentStatusFilter !== 'all') {
    result = result.filter((p) => p.paymentStatus === paymentStatusFilter);
  }
  return result;
}

export function sortProcessedInvoiceItems(processedItems, sortBy, sortOrder) {
  const sortFieldMap = {
    scheduledServiceDate: 'scheduledStartDate',
    serviceDeliveryDate: 'actualEndDate',
  };
  const selectedSortField = sortFieldMap[sortBy] || 'scheduledStartDate';
  const sortMultiplier = sortOrder === 'desc' ? -1 : 1;
  return [...processedItems].sort((a, b) => {
    const aVal = a[selectedSortField];
    const bVal = b[selectedSortField];
    if (aVal === null && bVal === null) return 0;
    if (aVal === null) return 1;
    if (bVal === null) return -1;
    const aTime = aVal instanceof Date ? aVal.getTime() : aVal;
    const bTime = bVal instanceof Date ? bVal.getTime() : bVal;
    return (aTime < bTime ? -1 : aTime > bTime ? 1 : 0) * sortMultiplier;
  });
}

export function calculateInvoiceCsvTotals(processedItems) {
  return processedItems.reduce(
    (acc, p) => ({
      totalAmount: acc.totalAmount + p.totalAmountNum,
      totalGovSubsidy: acc.totalGovSubsidy + p.govSubsidyNum,
      totalParticipantContribution: acc.totalParticipantContribution + p.participantContributionNum,
      total: acc.total + 1,
    }),
    { totalAmount: 0, totalGovSubsidy: 0, totalParticipantContribution: 0, total: 0 },
  );
}

export function collectInvoiceCsvReferenceIds(processedItems) {
  const servicePlanIds = new Set();
  const participantProfileIds = new Set();
  const fundingSourceIds = new Set();
  for (const p of processedItems) {
    if (p.servicePlanId) servicePlanIds.add(p.servicePlanId);
    if (p.participantProfileId) participantProfileIds.add(p.participantProfileId);
    for (const fsId of p.fundingSourceIds) {
      if (fsId) fundingSourceIds.add(fsId);
    }
  }
  return { servicePlanIds, participantProfileIds, fundingSourceIds };
}

export function populateInvoiceCsvParticipantNames(processedItems, refItemsMap, helpers) {
  const { getValue, ATTRIBUTE_NAMES, getParticipantNameFromProfile } = helpers;
  for (const p of processedItems) {
    if (p.participantProfileId) {
      const profileName = getParticipantNameFromProfile(refItemsMap.get(p.participantProfileId));
      p.participantName = profileName || String(getValue(p.item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '');
    } else {
      p.participantName = String(getValue(p.item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '');
    }
  }
}

export function applyInvoiceCsvParticipantAndFundingFilters(processedItems, filters, refItemsMap, getFundingSourceNameFromItem) {
  const { participant, fundingSourceFilter } = filters;
  let result = processedItems;
  if (participant && participant !== 'all') {
    const escapedParticipant = participant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const participantRegex = new RegExp(escapedParticipant, 'i');
    result = result.filter((p) => participantRegex.test(p.participantName));
  }
  if (fundingSourceFilter && fundingSourceFilter !== 'all') {
    result = result.filter((item) => {
      const fundingSource = item.fundingSourceIds
        .map((fsId) => getFundingSourceNameFromItem(refItemsMap.get(fsId)))
        .join(', ');
      return fundingSource && fundingSource.includes(fundingSourceFilter);
    });
  }
  return result;
}

export async function loadNestedInvoiceServiceRefs(servicePlanIds, refItemsMap, workspaceId, boardId, helpers) {
  const { getValue, extractAllRefIds, bulkFetchItemsFromDB } = helpers;
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
      extractAllRefIds(getValue(servicePlanItem, refAttr)).forEach((id) => nestedRefIds.add(id));
    }
  }
  if (!nestedRefIds.size) return refItemsMap;
  const nestedRefItemsMap = await bulkFetchItemsFromDB(workspaceId, boardId, [...nestedRefIds]);
  for (const [key, value] of nestedRefItemsMap) {
    refItemsMap.set(key, value);
  }
  return refItemsMap;
}

function formatDateOnlyFromValue(value) {
  if (!value || typeof value !== 'string') return null;
  return value.includes('T') ? value.split('T')[0] : value.split(' ')[0];
}

function resolveServicePlanExportFields(p, refItemsMap, helpers) {
  const {
    getServiceFromServicePlan,
    getServiceIdentifierFromServicePlan,
    getItemDescriptionFromServicePlan,
    getWraparoundDescriptionFromServicePlan,
    getHealthProfessionalFromServicePlan,
  } = helpers;
  if (!p.servicePlanId) {
    return {
      service: '',
      serviceIdentifier: '',
      itemDescriptionCode: '',
      itemDescription: '',
      wraparoundDescriptionCode: '',
      wraparoundDescription: '',
      healthProfessionalTypeCode: '',
      healthProfessionalTypeOther: '',
    };
  }
  const servicePlanItem = refItemsMap.get(p.servicePlanId);
  if (!servicePlanItem) {
    return {
      service: '',
      serviceIdentifier: '',
      itemDescriptionCode: '',
      itemDescription: '',
      wraparoundDescriptionCode: '',
      wraparoundDescription: '',
      healthProfessionalTypeCode: '',
      healthProfessionalTypeOther: '',
    };
  }
  const itemDesc = getItemDescriptionFromServicePlan(servicePlanItem, refItemsMap);
  const wraparound = getWraparoundDescriptionFromServicePlan(servicePlanItem, refItemsMap);
  const healthProf = getHealthProfessionalFromServicePlan(servicePlanItem, refItemsMap);
  return {
    service: getServiceFromServicePlan(servicePlanItem) || '',
    serviceIdentifier: getServiceIdentifierFromServicePlan(servicePlanItem, refItemsMap) || '',
    itemDescriptionCode: itemDesc.code,
    itemDescription: itemDesc.description,
    wraparoundDescriptionCode: wraparound.code,
    wraparoundDescription: wraparound.description,
    healthProfessionalTypeCode: healthProf.typeCode,
    healthProfessionalTypeOther: healthProf.typeOther,
  };
}

function resolveFundingSourceExportNames(p, refItemsMap, getFundingSourceNameFromItem) {
  if (!p.fundingSourceIds.length) return '';
  const fundingSourceNames = [];
  for (const fsId of p.fundingSourceIds) {
    const fsName = getFundingSourceNameFromItem(refItemsMap.get(fsId));
    if (fsName) fundingSourceNames.push(fsName);
  }
  return fundingSourceNames.join(', ');
}

function resolveItemFirstPaymentValue(itemFirstPaymentRaw) {
  if (typeof itemFirstPaymentRaw === 'boolean') return itemFirstPaymentRaw ? 'True' : 'False';
  if (typeof itemFirstPaymentRaw === 'string') {
    const normalized = itemFirstPaymentRaw.trim().toLowerCase();
    return ['true', 'y', 'yes'].includes(normalized) ? 'True' : 'False';
  }
  return 'False';
}

function resolveItemPurchasedMethodString(itemPurchasedMethod) {
  if (!itemPurchasedMethod) return undefined;
  const methodName = typeof itemPurchasedMethod === 'object'
    ? itemPurchasedMethod.name || ''
    : String(itemPurchasedMethod || '');
  if (!methodName) return undefined;
  return methodName.toLowerCase().includes('loan') ? 'LOANED' : 'PURCHASED';
}

function resolveLoanExportFields(item, itemPurchasedMethodString, getValue) {
  const ifLoanedLenderName = getValue(item, 'If Loaned, Lender Name');
  const ifLoanedLenderNameString = ifLoanedLenderName
    ? (typeof ifLoanedLenderName === 'object' ? ifLoanedLenderName.name : String(ifLoanedLenderName))
    : '';
  const ifLoanedLenderInvoiceNo = getValue(item, 'If Loaned, Lender Invoice No.') || '';
  if (itemPurchasedMethodString !== 'LOANED') {
    return { loanedByOrganisationName: '', loanedByInvoiceNumber: '' };
  }
  return {
    loanedByOrganisationName: ifLoanedLenderNameString || '',
    loanedByInvoiceNumber: ifLoanedLenderInvoiceNo || '',
  };
}

export function transformInvoiceCsvItem(p, refItemsMap, invoiceNumberMap, helpers) {
  const {
    getValue,
    ATTRIBUTE_NAMES,
    parseNumber,
    formatStatus,
    getMyAgedCareIdFromProfile,
    getFundingSourceNameFromItem,
    getServiceFromServicePlan,
    getServiceIdentifierFromServicePlan,
    getItemDescriptionFromServicePlan,
    getWraparoundDescriptionFromServicePlan,
    getHealthProfessionalFromServicePlan,
  } = helpers;

  const item = p.item;
  const itemId = item.itemId;
  const participant = p.participantName || '';
  const scheduledStart = getValue(item, ATTRIBUTE_NAMES.SCHEDULED_START);
  const actualEnd = getValue(item, ATTRIBUTE_NAMES.ACTUAL_END);
  const unit = getValue(item, ATTRIBUTE_NAMES.UNIT) || '';
  const quantity = parseNumber(getValue(item, ATTRIBUTE_NAMES.QUANTITY));
  const unitPrice = parseNumber(getValue(item, ATTRIBUTE_NAMES.UNIT_PRICE));
  const totalAmount = parseNumber(getValue(item, ATTRIBUTE_NAMES.TOTAL_AMOUNT));
  const govSubsidy = parseNumber(getValue(item, ATTRIBUTE_NAMES.GOV_SUBSIDY));
  const participantContribution = parseNumber(getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION));
  const notes = getValue(item, ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';

  const serviceFields = resolveServicePlanExportFields(p, refItemsMap, {
    getServiceFromServicePlan,
    getServiceIdentifierFromServicePlan,
    getItemDescriptionFromServicePlan,
    getWraparoundDescriptionFromServicePlan,
    getHealthProfessionalFromServicePlan,
  });

  let careRecipientIdentifier = '';
  if (p.participantProfileId) {
    careRecipientIdentifier = getMyAgedCareIdFromProfile(refItemsMap.get(p.participantProfileId)) || '';
  }

  const fundingSource = resolveFundingSourceExportNames(p, refItemsMap, getFundingSourceNameFromItem);
  const serviceDeliveryDate = formatDateOnlyFromValue(actualEnd);
  const scheduledServiceDate = formatDateOnlyFromValue(scheduledStart);
  const deliveredBy = formatStatus(getValue(item, ATTRIBUTE_NAMES.DELIVERED_BY));
  const deliveredByThirdParty = deliveredBy && deliveredBy.toLowerCase().includes('associated') ? 'True' : 'False';
  const paymentStatusFormatted = formatStatus(getValue(item, ATTRIBUTE_NAMES.PAYMENT_STATUS));
  const transactionStatusFormatted = formatStatus(getValue(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS));
  const prescribedItem = getValue(item, 'Prescribed Item');
  const prescribedItemValue = prescribedItem === true || prescribedItem === 'true' || prescribedItem === 'Y' ? 'Y' : 'N';
  const itemFirstPaymentValue = resolveItemFirstPaymentValue(getValue(item, 'Item First Payment'));
  const itemPurchasedMethodString = resolveItemPurchasedMethodString(formatStatus(getValue(item, 'Item Purchased Method')));
  const { loanedByOrganisationName, loanedByInvoiceNumber } = resolveLoanExportFields(item, itemPurchasedMethodString, getValue);

  const normalizedUnit = typeof unit === 'string' ? unit.toLowerCase() : '';
  const isItemUnit = normalizedUnit === 'item';
  const serviceLabel = serviceFields.service || '';
  const isWraparound = serviceLabel.toLowerCase().includes('wraparound');

  return {
    id: item.itemId,
    paymentStatus: paymentStatusFormatted,
    participant,
    service: serviceLabel,
    scheduledServiceDate,
    serviceDeliveryDate,
    unit,
    quantity,
    unitPrice,
    totalAmount,
    govSubsidy,
    participantContribution,
    fundingSource,
    transactionStatus: transactionStatusFormatted,
    notes,
    invoiceNumber: invoiceNumberMap.get(itemId),
    careRecipientIdentifier,
    serviceIdentifier: serviceFields.serviceIdentifier,
    deliveredByThirdParty,
    itemOrWraparound: isItemUnit ? 'Item' : (isWraparound ? 'Wraparound' : ''),
    itemDescriptionCode: isItemUnit ? serviceFields.itemDescriptionCode : '',
    itemDescription: isItemUnit ? serviceFields.itemDescription : '',
    wraparoundDescriptionCode: isWraparound ? serviceFields.wraparoundDescriptionCode : '',
    wraparoundDescription: isWraparound ? serviceFields.wraparoundDescription : '',
    prescribedItem: prescribedItemValue,
    itemPurchasedMethod: itemPurchasedMethodString,
    loanedByOrganisationName,
    loanedByInvoiceNumber,
    healthProfessionalTypeCode: serviceFields.healthProfessionalTypeCode,
    healthProfessionalTypeOther: serviceFields.healthProfessionalTypeOther,
    itemFirstPayment: itemFirstPaymentValue,
  };
}

export async function handleInvoiceCsvExport(req, res, deps) {
  const startTime = Date.now();
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
      sortBy = 'scheduledServiceDate',
      sortOrder = 'asc',
    } = req.query;
    const fundingSourceFilter = req.query.fundingSource || '';

    if (!workspaceId || !boardId) {
      return res.status(400).json({
        message: 'Invoice CSV export could not start because the workspace or board is missing. Return to your workspace list, open the board again, and try the export again.',
      });
    }

    deps.info('Export-Service', 'Starting optimized CSV export (DB only)', { workspaceId, boardId, participant }, req ?? null);

    const folderIds = await deps.getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
    const baseQuery = { workspaceId, boardId };
    if (folderIds.length > 0) baseQuery.folderId = { $in: folderIds };

    const allItems = await deps.Item.find(baseQuery).lean();
    deps.info('Export-Service', 'Fetched items from database', { count: allItems.length }, req ?? null);

    let processedItems = allItems.map((item) => mapRawItemToProcessedInvoiceRow(item, deps));
    processedItems = applyInvoiceCsvDateAndStatusFilters(processedItems, {
      startDate, endDate, serviceDeliveryStart, serviceDeliveryEnd, transactionStatusFilter, paymentStatusFilter,
    });
    let totals = calculateInvoiceCsvTotals(processedItems);
    processedItems = sortProcessedInvoiceItems(processedItems, sortBy, sortOrder);

    const { servicePlanIds, participantProfileIds, fundingSourceIds } = collectInvoiceCsvReferenceIds(processedItems);
    deps.info('Export-Service', 'Bulk fetching reference data from DB', {
      servicePlans: servicePlanIds.size,
      participantProfiles: participantProfileIds.size,
      fundingSources: fundingSourceIds.size,
    }, req ?? null);

    let refItemsMap = await deps.bulkFetchItemsFromDB(workspaceId, boardId, [...servicePlanIds, ...participantProfileIds, ...fundingSourceIds]);
    populateInvoiceCsvParticipantNames(processedItems, refItemsMap, deps);
    processedItems = applyInvoiceCsvParticipantAndFundingFilters(processedItems, { participant, fundingSourceFilter }, refItemsMap, deps.getFundingSourceNameFromItem);
    totals = calculateInvoiceCsvTotals(processedItems);
    refItemsMap = await loadNestedInvoiceServiceRefs(servicePlanIds, refItemsMap, workspaceId, boardId, deps);

    const itemIdsForInvoice = processedItems.map((p) => p.item.itemId);
    const invoiceNumbers = await deps.InvoiceNumber.find({ workspaceId, boardId, itemId: { $in: itemIdsForInvoice } }).lean();
    const invoiceNumberMap = new Map(invoiceNumbers.map((inv) => [inv.itemId, inv.invoiceNumber]));
    const transformedItems = processedItems.map((p) => transformInvoiceCsvItem(p, refItemsMap, invoiceNumberMap, deps));

    const duration = Date.now() - startTime;
    deps.info('Export-Service', 'Completed optimized CSV export (DB only)', {
      workspaceId, boardId, itemCount: transformedItems.length, durationMs: duration,
    }, req ?? null);

    return res.status(200).json({
      items: transformedItems,
      total: totals.total,
      totalAmount: totals.totalAmount,
      totalGovSubsidy: totals.totalGovSubsidy,
      totalParticipantContribution: totals.totalParticipantContribution,
      exportDurationMs: duration,
    });
  } catch (err) {
    deps.error('Export-Service', 'Failed to export invoice CSV', { err }, req);
    return res.status(500).json({
      message: 'Invoice CSV export failed due to a server problem. Please try again. If this keeps happening, contact support.',
    });
  }
}
