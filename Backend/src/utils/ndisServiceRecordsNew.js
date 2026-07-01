import {
  NDIS_MASTERPLAN_ATTR,
  NDIS_SERVICEPLAN_ATTR,
  formatLabelValue,
  getParticipantDisplayName,
  getValue,
  getValueMulti,
  parseNumberValue,
  resolveNdisClaimType,
  round1,
  buildServiceItemDescription,
  isHourUnitLabel,
} from './ndisServiceRecords.js';

const SYDNEY_TIME_ZONE = 'Australia/Sydney';

function getMasterPlanLabel(masterPlanItem, attributeNames) {
  const raw = getValueMulti(masterPlanItem, attributeNames);
  return formatLabelValue(raw).trim();
}

function getMasterPlanNumber(masterPlanItem, attributeNames) {
  const raw = getValueMulti(masterPlanItem, attributeNames);
  return parseNumberValue(raw);
}

function getServicePlanLabel(servicePlanItem, attributeNames) {
  const raw = getValueMulti(servicePlanItem, attributeNames);
  return formatLabelValue(raw).trim();
}

function getServicePlanNumber(servicePlanItem, attributeNames) {
  const raw = getValueMulti(servicePlanItem, attributeNames);
  return parseNumberValue(raw);
}

function getSupportItemNumber(catalogueItem, fallbackRaw) {
  const fromCatalogue = catalogueItem?.data?.['Support Item Number'] ?? catalogueItem?.data?.['Item Number'];
  const catalogueStr = fromCatalogue ? String(fromCatalogue).trim() : '';
  if (catalogueStr) return catalogueStr;
  const fallback = formatLabelValue(fallbackRaw).trim();
  return fallback;
}

function getSupportItemName(catalogueItem, fallback = '') {
  const fromCatalogue = catalogueItem?.data?.['Support Item Name'] ?? catalogueItem?.data?.['Name'];
  const catalogueStr = fromCatalogue ? String(fromCatalogue).trim() : '';
  return catalogueStr || fallback;
}

function buildSimpleItemDesc({ itemNumber, itemName, fallback, unit, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd, timeZone }) {
  return buildServiceItemDescription({
    itemNumber,
    itemName,
    unit,
    jobStatus,
    actualStart,
    actualEnd,
    scheduledStart,
    scheduledEnd,
    fallback: fallback || 'Service',
    timeZone,
  });
}

export function buildNewNdisMasterPlanServiceRows({
  masterPlanItem,
  participantName,
  participantProfileItem,
  servicePlanItem,
  supportCatalogue,
  cancellationTypeItem: _cancellationTypeItem,
  invoiceNumber,
  invoicePdfLink,
  timeZone = SYDNEY_TIME_ZONE,
}) {
  const rows = [];
  const itemId = masterPlanItem?.itemId;
  const master = masterPlanItem?.data || {};

  const groupSize = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.GROUP_SIZE]) || 1;
  const jobStatus = getMasterPlanLabel(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.JOB_STATUS,
    'Shift Status',
    'Job status',
    'JobStatus',
    'ShiftStatus',
  ]);
  const paymentStatus = getMasterPlanLabel(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.PAYMENT_STATUS,
    'Payment status',
    'PaymentStatus',
  ]);

  const scheduledStart = master[NDIS_MASTERPLAN_ATTR.SCHEDULED_START];
  const scheduledEnd = getValueMulti(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.SCHEDULED_END,
    'Scheduled Shift End Date and Time',
    'Scheduled Shift End Date & Time',
  ]);
  const actualStart = getValueMulti(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.ACTUAL_START,
    'Actual Shift Start Date & Time',
  ]);
  const actualEnd = getValueMulti(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.ACTUAL_END,
    'Actual Shift End Date & Time',
  ]);

  const computeDurationHr = (startRaw, endRaw) => {
    if (!startRaw || !endRaw) return 0;
    const s = new Date(startRaw);
    const e = new Date(endRaw);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
    const ms = e.getTime() - s.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return ms / (60 * 60 * 1000);
  };

  let actualDurationHr = getMasterPlanNumber(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.ACTUAL_DURATION_HR,
    'Actual Shift Duration (Hr.)',
    'Actual Shift Duration (Hr)',
    'Actual Shift Duration(Hrs.)',
    'Actual Shift Duration (Hrs.)',
    'Actual Shift Duration',
  ]);
  if (actualDurationHr <= 0) {
    actualDurationHr = computeDurationHr(actualStart, actualEnd);
  }

  let scheduledDurationHr = getMasterPlanNumber(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.SCHEDULED_DURATION_HR,
    'Scheduled Shift Duration (Hr.)',
    'Scheduled Shift Duration (Hr)',
    'Scheduled Shift Duration(Hrs.)',
    'Scheduled Shift Duration',
  ]);
  if (scheduledDurationHr <= 0) {
    scheduledDurationHr = computeDurationHr(scheduledStart, scheduledEnd);
  }

  const scheduledServiceDate = scheduledStart || null;
  const serviceDeliveryDate = actualStart || null;
  const status = invoiceNumber ? 'invoiced' : 'pending';
  const servicePlan = servicePlanItem || null;

  const spNonLabourUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_PROVIDER_TRAVEL_NON_LABOUR,
    'Unit (Provider Travel Non-Labour Cost)',
  ]);
  const spNonLabourUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_PROVIDER_TRAVEL_NON_LABOUR,
    'Agreed Unit Price for Non-Labour Travel ($)',
  ]);
  const spLabourUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_LABOUR_TRAVEL_TIME,
    'Unit (Labour Travel Time)',
  ]);
  const spLabourUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_LABOUR_TRAVEL_TIME,
    'Agreed Unit Price for Labour Travel Time ($)',
  ]);
  const spAllowancesUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_ALLOWANCES,
    'Unit (Allowances)',
  ]);
  const spSupportUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_SUPPORT,
    'Unit (Support)',
  ]);
  const spSupportUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_SUPPORT,
    'Agreed Unit Price for Support ($)',
  ]);
  const spCancellationUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_CANCELLATION,
    'Unit (Cancellation)',
  ]);
  const spCancellationUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_CANCELLATION,
    'Agreed Unit Price for Cancellation ($)',
  ]);
  const spActivityUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_ACTIVITY_TRANSPORT,
    'Unit (Activity Based Transport)',
  ]);
  const spActivityUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_ACTIVITY_TRANSPORT,
    'Agreed Price for Activity Based Transport ($)',
  ]);

  const supportItemNumber = getSupportItemNumber(
    supportCatalogue?.support,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT)
  );
  const supportItemName = getSupportItemName(supportCatalogue?.support, '');
  const providerTravelItemNumber = getSupportItemNumber(
    supportCatalogue?.providerTravelNonLabour,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR)
  );
  const providerTravelItemName = getSupportItemName(supportCatalogue?.providerTravelNonLabour, '');
  const labourTravelTimeItemNumber = getSupportItemNumber(
    supportCatalogue?.labourTravelTime,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME)
  );
  const labourTravelTimeItemName = getSupportItemName(supportCatalogue?.labourTravelTime, '');
  const cancellationItemNumber = getSupportItemNumber(
    supportCatalogue?.cancellation,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION)
  );
  const cancellationItemName = getSupportItemName(supportCatalogue?.cancellation, '');
  const activityItemNumber = getSupportItemNumber(
    supportCatalogue?.activityTransport,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT)
  );
  const activityItemName = getSupportItemName(supportCatalogue?.activityTransport, '');

  const serviceDeliveryModeValue = getValueMulti(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE,
    'Service Delivery Mode',
  ]);

  const addRow = (row) => {
    const claimType = resolveNdisClaimType(row.claimType, serviceDeliveryModeValue, row.code, row.supportNumber || '');
    rows.push({
      id: `${itemId}:${row.code}`,
      sourceItemId: itemId,
      status,
      participant: participantName || getParticipantDisplayName(participantProfileItem) || String(master[NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME] || ''),
      scheduledServiceDate,
      serviceDeliveryDate,
      jobStatus,
      paymentStatus,
      invoiceNumber,
      fileUrl: invoicePdfLink || null,
      gst: row.gst ?? 'GST Free',
      ...row,
      claimType,
    });
  };

  const isCancelled = jobStatus.toLowerCase() === 'cancelled';

  if (!isCancelled) {
    const supportAmount = parseNumberValue(getValueMulti(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE,
      NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME,
      NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_NON_TIME,
    ]));
    const isHourUnit = isHourUnitLabel(spSupportUnit);

    if (isHourUnit) {
      const baseUnitPrice = groupSize > 0 ? spSupportUnitPrice / groupSize : spSupportUnitPrice;
      let qty = round1(actualDurationHr);
      if (qty <= 0 && supportAmount > 0 && spSupportUnitPrice > 0) {
        qty = round1(supportAmount / spSupportUnitPrice);
      }
      let unitPrice = baseUnitPrice;
      if (unitPrice <= 0 && supportAmount > 0 && qty > 0) {
        unitPrice = parseFloat((supportAmount / qty).toFixed(2));
      }
      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'support',
          service: buildServiceItemDescription({
            itemNumber: supportItemNumber,
            itemName: supportItemName,
            unit: spSupportUnit || 'Hour',
            jobStatus,
            actualStart,
            actualEnd,
            scheduledStart,
            scheduledEnd,
            fallback: 'Support',
            groupSize,
            timeZone,
          }),
          unit: spSupportUnit || 'Hour',
          quantity: qty,
          unitPrice,
          totalAmount: parseFloat((qty * unitPrice).toFixed(2)),
          supportNumber: supportItemNumber,
          claimType: '',
        });
      }
    } else {
      let qty = parseNumberValue(getValueMulti(masterPlanItem, [
        NDIS_MASTERPLAN_ATTR.QUANTITY_NON_TIME_BASED,
        NDIS_MASTERPLAN_ATTR.QUANTITY_DIRECT_SUPPORT_NON_TIME,
      ]));
      let unitPrice = spSupportUnitPrice;
      if (qty <= 0 && supportAmount > 0 && unitPrice > 0) {
        qty = parseFloat((supportAmount / unitPrice).toFixed(2));
      }
      if (unitPrice <= 0 && supportAmount > 0 && qty > 0) {
        unitPrice = parseFloat((supportAmount / qty).toFixed(2));
      }
      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'support_non_time',
          service: (() => {
            let desc = buildSimpleItemDesc({
              itemNumber: supportItemNumber,
              itemName: supportItemName,
              fallback: 'Support',
            });
            if (qty && spSupportUnit) desc += ` - ${qty} ${spSupportUnit}`;
            return desc;
          })(),
          unit: spSupportUnit || '',
          quantity: qty,
          unitPrice,
          totalAmount: parseFloat((qty * unitPrice).toFixed(2)),
          supportNumber: supportItemNumber,
          claimType: '',
        });
      }
    }

    let providerAmount = getMasterPlanNumber(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT,
      'Provider Travel - Non-Labour Amount($)',
    ]);
    const providerMileageNum = parseNumberValue(getValueMulti(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE,
    ]));
    const providerOthersNum = parseNumberValue(getValueMulti(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_OTHER_COSTS,
      'Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied ($)',
    ]));
    if (providerAmount <= 0) {
      const computed = providerMileageNum > 0 && spNonLabourUnitPrice > 0
        ? providerMileageNum * spNonLabourUnitPrice + providerOthersNum
        : providerOthersNum;
      if (computed > 0) providerAmount = computed;
    }

    if (providerAmount > 0) {
      addRow({
        code: 'provider_travel_non_labour',
        service: (() => {
          let desc = buildSimpleItemDesc({
            itemNumber: providerTravelItemNumber,
            itemName: providerTravelItemName,
            fallback: 'Provider Travel - Non-Labour Cost Item',
          });
          if (providerMileageNum) desc += ` - ${providerMileageNum}km`;
          if (providerOthersNum) desc += ` - Others: ${providerOthersNum}`;
          return desc;
        })(),
        unit: spNonLabourUnit || '',
        quantity: providerAmount,
        unitPrice: 1,
        totalAmount: providerAmount,
        supportNumber: providerTravelItemNumber,
        claimType: '',
      });
    }

    let activityAmount = getMasterPlanNumber(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT,
      'Activity Based Transport Amount($)',
      'Activity Based Transport Amount ($)',
      'Activity Base Transport Amount ($)',
    ]);
    const activityMileageNum = parseNumberValue(getValueMulti(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_MILEAGE,
      'Activity Based Transport Mileage(Kms) as per the Service Plan, if a vehicle is used.',
    ]));
    const activityOthersNum = parseNumberValue(getValueMulti(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_OTHER_COSTS,
      'Activity Based Transport Costs as per the Service Plan, if other costs are applied.',
    ]));
    if (activityAmount <= 0) {
      const computed =
        activityMileageNum > 0 && spActivityUnitPrice > 0
          ? activityMileageNum * spActivityUnitPrice + activityOthersNum
          : activityOthersNum;
      if (computed > 0) activityAmount = computed;
    }

    if (activityAmount > 0) {
      addRow({
        code: 'activity_transport',
        service: (() => {
          let desc = buildSimpleItemDesc({
            itemNumber: activityItemNumber,
            itemName: activityItemName,
            fallback: 'Activity Based Transport Item',
          });
          if (activityMileageNum) desc += ` - ${activityMileageNum}km`;
          if (activityOthersNum) desc += ` - Others: ${activityOthersNum}`;
          return desc;
        })(),
        unit: spActivityUnit || 'Each(E)',
        quantity: activityAmount,
        unitPrice: 1,
        totalAmount: activityAmount,
        supportNumber: activityItemNumber,
        claimType: '',
      });
    }

    const labourAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT]);
    if (labourAmount > 0) {
      const labourMinRaw = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_MIN]);
      const qty = round1(labourMinRaw / 60);
      const unitPrice = spLabourUnitPrice;
      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'labour_travel_time',
          service: buildServiceItemDescription({
            itemNumber: labourTravelTimeItemNumber,
            itemName: labourTravelTimeItemName || 'Provider Travel - Labour Travel Time Costs',
            unit: spLabourUnit || 'Hour',
            jobStatus,
            actualStart,
            actualEnd,
            scheduledStart,
            scheduledEnd,
            fallback: 'Provider Travel - Labour Travel Time Costs',
            timeZone,
          }),
          unit: spLabourUnit || 'Hour',
          quantity: qty,
          unitPrice,
          totalAmount: parseFloat((qty * unitPrice).toFixed(2)),
          supportNumber: labourTravelTimeItemNumber,
          claimType: '',
        });
      }
    }

    const allowancesAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT]);
    if (allowancesAmount > 0) {
      const usedAllowanceUnitPrice = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.USED_ALLOWANCE_AMOUNT]) || allowancesAmount;
      const allowancesType = formatLabelValue(master[NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE]).trim();
      const allowancesTypeLower = allowancesType.toLowerCase();
      const isNdiaRequiredReport =
        allowancesTypeLower.includes('report') &&
        (allowancesTypeLower.includes('ndia') ||
          allowancesTypeLower.includes('required') ||
          allowancesTypeLower.includes('requested') ||
          allowancesTypeLower.includes('mandatory'));
      addRow({
        code: 'allowances',
        service: `Allowances${allowancesType ? ` - ${allowancesType}` : ''}`,
        unit: spAllowancesUnit || '',
        quantity: 1,
        unitPrice: usedAllowanceUnitPrice,
        totalAmount: allowancesAmount,
        supportNumber: supportItemNumber,
        claimType: isNdiaRequiredReport ? 'REPW' : '',
      });
    }
  } else {
    const cancellationFee = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE]);
    if (cancellationFee > 0) {
      const scheduledDuration = round1(scheduledDurationHr);
      const qty = scheduledDuration;
      const unitPrice = spCancellationUnitPrice || (qty > 0 ? parseFloat((cancellationFee / qty).toFixed(2)) : 0);
      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'canc_support',
          service: buildServiceItemDescription({
            itemNumber: cancellationItemNumber,
            itemName: cancellationItemName || 'Cancellation Fee',
            unit: spCancellationUnit,
            jobStatus: 'Cancelled',
            scheduledStart,
            scheduledEnd,
            fallback: 'Cancellation Fee',
            timeZone,
          }),
          unit: spCancellationUnit || '',
          quantity: qty,
          unitPrice,
          totalAmount: parseFloat((qty * unitPrice).toFixed(2)),
          supportNumber: cancellationItemNumber,
          claimType: '',
        });
      }
    }
  }

  return rows;
}
