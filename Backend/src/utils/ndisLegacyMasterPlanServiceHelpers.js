import {
  NDIS_MASTERPLAN_ATTR,
  NDIS_SERVICEPLAN_ATTR,
  NDIS_CANCELLATION_TYPE_ATTR,
  formatLabelValue,
  getParticipantDisplayName,
  getValue,
  getValueMulti,
  parseNumberValue,
  resolveNdisClaimType,
  round1,
  buildServiceItemDescription,
  computeProviderTravelNonLabourAmount,
  computeActivityBaseTransportAmount,
  getShortNoticeCancellationsFlag,
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
  return formatLabelValue(fallbackRaw).trim();
}

function getSupportItemName(catalogueItem, fallback = '') {
  const fromCatalogue = catalogueItem?.data?.['Support Item Name'] ?? catalogueItem?.data?.['Name'];
  const catalogueStr = fromCatalogue ? String(fromCatalogue).trim() : '';
  return catalogueStr || fallback;
}

function buildSimpleItemDesc(opts) {
  return buildServiceItemDescription({ ...opts, fallback: opts.fallback || 'Service' });
}

function computeDurationHr(startRaw, endRaw) {
  if (!startRaw || !endRaw) return 0;
  const s = new Date(startRaw);
  const e = new Date(endRaw);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  const ms = e.getTime() - s.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / (60 * 60 * 1000);
}

function buildLegacyMasterPlanContext({
  masterPlanItem, participantName, participantProfileItem, servicePlanItem,
  supportCatalogue, cancellationTypeItem, invoiceNumber, invoicePdfLink,
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
  const spDirectUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_DIRECT_SUPPORT,
    'Unit (Direct Support)',
  ]);
  const spDirectUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_DIRECT_SUPPORT,
    'Agreed Unit Price for Direct Support ($)',
    'Agreed Unit Price for Direct Support($)',
  ]);
  const spNonLabourUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_PROVIDER_TRAVEL_NON_LABOUR,
    'Unit (Provider Travel Non-Labour Cost)',
    'Unit (Provider Travel - Non-Labour Costs)',
  ]);
  const spNonLabourUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_PROVIDER_TRAVEL_NON_LABOUR,
    'Agreed Unit Price for Non-Labour Travel ($)',
    'Agreed Unit Price for Non-Labour Travel($)',
  ]);
  const spActivityUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_ACTIVITY_TRANSPORT,
    'Unit (Activity Base Transport)',
  ]);
  const spActivityUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_ACTIVITY_TRANSPORT,
    'Agreed Price for Activity Base Transport ($)',
    'Agreed Unit Price for Activity Based Transport ($)',
  ]);
  const spCentreUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_CENTRE_CAPITAL,
    'Unit (Centre Capital Cost)',
    'Unit (Centre Capital Costs)',
  ]);
  const spCentreUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_CENTRE_CAPITAL,
    'Agreed Unit Price for Centre Capital Cost($)',
    'Agreed Unit Price for Centre Capital Costs ($)',
    'Agreed Unit Price for Centre Capital Costs($)',
  ]);
  const spLabourUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_LABOUR_TRAVEL_TIME,
    'Unit (Labour Travel Time)',
  ]);
  const spLabourUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_LABOUR_TRAVEL_TIME,
    'Agreed Unit Price for Labour Travel Time ($)',
    'Agreed Unit Price for Labour Travel Time($)',
  ]);
  const spAllowancesUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_ALLOWANCES,
    'Unit (Allowances)',
  ]);
  const spNonFaceUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_NON_FACE_TO_FACE,
    'Unit (Non Face to Face Support)',
  ]);
  const spNonFaceUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_NON_FACE_TO_FACE,
    'Agreed Unit Price for Non-Face-to-Face Support($)',
    'Agreed Unit Price for Non Face to Face Support($)',
    'Agreed Unit Price for Non-Face-to-Face Support ($)',
  ]);

  const directSupportItemNumber = getSupportItemNumber(
    supportCatalogue?.directSupport,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_DIRECT_SUPPORT)
  );
  const directSupportItemName = getSupportItemName(supportCatalogue?.directSupport, '');

  const providerTravelItemNumber = getSupportItemNumber(
    supportCatalogue?.providerTravelNonLabour,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR)
  );
  const providerTravelItemName = getSupportItemName(supportCatalogue?.providerTravelNonLabour, '');

  const activityItemNumber = getSupportItemNumber(
    supportCatalogue?.activityTransport,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT)
  );
  const activityItemName = getSupportItemName(supportCatalogue?.activityTransport, '');

  const centreCapitalItemNumber = getSupportItemNumber(
    supportCatalogue?.centreCapital,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_CENTRE_CAPITAL)
  );
  const centreCapitalItemName = getSupportItemName(supportCatalogue?.centreCapital, '');

  const serviceDeliveryModeValue = getValueMulti(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE,
    'Service Delivery Mode',
  ]);

  const addRow = (row) => {
    const claimType = resolveNdisClaimType(
      row.claimType,
      serviceDeliveryModeValue,
      row.code,
      row.supportNumber || ''
    );
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
  return {
    rows, master, itemId, groupSize, jobStatus, paymentStatus,
    scheduledStart, scheduledEnd, actualStart, actualEnd,
    actualDurationHr, scheduledDurationHr, scheduledServiceDate, serviceDeliveryDate,
    status, servicePlan, spDirectUnit, spDirectUnitPrice, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice,
    spLabourUnit, spLabourUnitPrice, spAllowancesUnit, spNonFaceUnit, spNonFaceUnitPrice,
    directSupportItemNumber, directSupportItemName, providerTravelItemNumber, providerTravelItemName,
    activityItemNumber, activityItemName, centreCapitalItemNumber, centreCapitalItemName,
    serviceDeliveryModeValue, cancellationTypeItem, supportCatalogue,
    invoiceNumber, invoicePdfLink, timeZone, participantName, participantProfileItem,
    isCancelled, addRow, masterPlanItem,
  };
}

function addLegacyDirectSupportTimeRow(ctx) {
  const {
    master, masterPlanItem, groupSize, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd,
    actualDurationHr, spDirectUnit, spDirectUnitPrice, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice, spLabourUnit, spLabourUnitPrice,
    spAllowancesUnit, spNonFaceUnit, spNonFaceUnitPrice, directSupportItemNumber, directSupportItemName,
    providerTravelItemNumber, providerTravelItemName, activityItemNumber, activityItemName,
    centreCapitalItemNumber, centreCapitalItemName, timeZone, addRow,
  } = ctx;
  // 1) Direct Support - Hour based
    const directTimeAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME]);
    if (directTimeAmount > 0 && spDirectUnit.includes('Hour')) {
      let unitPrice = groupSize > 0 ? spDirectUnitPrice / groupSize : 0;
      let qty = round1(actualDurationHr);
      // If duration is not stored, derive qty using the catalog rate (before group division)
      // so that quantity reflects hours, not a doubled value for group > 1
      if (qty <= 0 && directTimeAmount > 0 && spDirectUnitPrice > 0) {
        qty = round1(directTimeAmount / spDirectUnitPrice);
      }
      // If unit price is missing but qty exists, derive unit price from amount/qty
      if (unitPrice <= 0 && directTimeAmount > 0 && qty > 0) {
        unitPrice = parseFloat((directTimeAmount / qty).toFixed(2));
      }

      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'direct_support_time',
          service: buildServiceItemDescription({
            itemNumber: directSupportItemNumber,
            itemName: directSupportItemName,
            unit: spDirectUnit || 'Hour(H)',
            jobStatus,
            actualStart,
            actualEnd,
            scheduledStart,
            scheduledEnd,
            fallback: 'Direct Support - Hour based',
            groupSize,
            timeZone,
          }),
          unit: spDirectUnit || 'Hour(H)',
          quantity: qty,
          unitPrice,
          totalAmount: parseFloat((qty * unitPrice).toFixed(2)),
          supportNumber: directSupportItemNumber,
          claimType: '',
        });
      }
    }
}

function addLegacyDirectSupportNonTimeRow(ctx) {
  const {
    master, masterPlanItem, groupSize, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd,
    actualDurationHr, spDirectUnit, spDirectUnitPrice, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice, spLabourUnit, spLabourUnitPrice,
    spAllowancesUnit, spNonFaceUnit, spNonFaceUnitPrice, directSupportItemNumber, directSupportItemName,
    providerTravelItemNumber, providerTravelItemName, activityItemNumber, activityItemName,
    centreCapitalItemNumber, centreCapitalItemName, timeZone, addRow,
  } = ctx;
  // 2) Direct Support - Non hour based
    const directNonTimeAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_NON_TIME]);
    if (directNonTimeAmount > 0 && !spDirectUnit.includes('Hour')) {
      let qty = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.QUANTITY_DIRECT_SUPPORT_NON_TIME]);
      let unitPrice = spDirectUnitPrice;
      if (qty <= 0 && directNonTimeAmount > 0 && unitPrice > 0) {
        qty = parseNumberValue(parseFloat((directNonTimeAmount / unitPrice).toFixed(2)));
      }
      if (unitPrice <= 0 && directNonTimeAmount > 0 && qty > 0) {
        unitPrice = parseFloat((directNonTimeAmount / qty).toFixed(2));
      }

      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'direct_support_non_time',
          service: (() => {
            let desc = buildSimpleItemDesc({
              itemNumber: directSupportItemNumber,
              itemName: directSupportItemName,
              fallback: 'Direct Support - NOT Hour based',
            });
            if (qty && spDirectUnit) desc += ` - ${qty} ${spDirectUnit}`;
            return desc;
          })(),
          unit: spDirectUnit || '',
          quantity: qty,
          unitPrice,
          totalAmount: directNonTimeAmount,
          supportNumber: directSupportItemNumber,
          claimType: '',
        });
      }
    }
}

function addLegacyProviderTravelNonLabourRow(ctx) {
  const {
    master, masterPlanItem, groupSize, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd,
    actualDurationHr, spDirectUnit, spDirectUnitPrice, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice, spLabourUnit, spLabourUnitPrice,
    spAllowancesUnit, spNonFaceUnit, spNonFaceUnitPrice, directSupportItemNumber, directSupportItemName,
    providerTravelItemNumber, providerTravelItemName, activityItemNumber, activityItemName,
    centreCapitalItemNumber, centreCapitalItemName, timeZone, addRow,
  } = ctx;
  // 3) Provider Travel - Non-Labour Cost (unitPrice=1, quantity=amount)
    let providerAmount = getMasterPlanNumber(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT,
      'Provider Travel - Non-Labour Amount($)',
      'Provider Travel - Non-Labour Cost Amount ($)',
    ]);
    const providerMileageRaw = getValueMulti(masterPlanItem, [
        NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE,
        'Provider Travel - Non-Labour Mileage (kms) as per the Service Plan, if a vehicle is used.',
      ]);
    const providerOthersRaw = getValueMulti(masterPlanItem, [
        NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_OTHER_COSTS,
        'Provider Travel - Non-Labour - Other Costs as per the Service Plan, if other costs are applied.',
      ]);
    const providerMileageNum = parseNumberValue(providerMileageRaw);
    const providerOthersNum = parseNumberValue(providerOthersRaw);
    if (providerAmount <= 0) {
      const computed = computeProviderTravelNonLabourAmount(spNonLabourUnitPrice, providerMileageNum, providerOthersNum);
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
}

function addLegacyActivityTransportRow(ctx) {
  const {
    master, masterPlanItem, groupSize, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd,
    actualDurationHr, spDirectUnit, spDirectUnitPrice, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice, spLabourUnit, spLabourUnitPrice,
    spAllowancesUnit, spNonFaceUnit, spNonFaceUnitPrice, directSupportItemNumber, directSupportItemName,
    providerTravelItemNumber, providerTravelItemName, activityItemNumber, activityItemName,
    centreCapitalItemNumber, centreCapitalItemName, timeZone, addRow,
  } = ctx;
  // 4) Activity Based Transport (unitPrice=1, quantity=amount)
    let activityAmount = getMasterPlanNumber(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT,
      'Activity Based Transport Amount($)',
      'Activity Based Transport Amount ($)',
      'Activity Base Transport Amount ($)',
    ]);
    const activityMileageRaw = getValueMulti(masterPlanItem, [
        NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_MILEAGE,
        'Activity Based Transport Mileage(Kms) as per the Service Plan, if a vehicle is used.',
      ]);
    const activityOthersRaw = getValueMulti(masterPlanItem, [
        NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_OTHER_COSTS,
        'Activity Based Transport Costs as per the Service Plan, if other costs are applied.',
      ]);
    const activityMileageNum = parseNumberValue(activityMileageRaw);
    const activityOthersNum = parseNumberValue(activityOthersRaw);
    if (activityAmount <= 0) {
      const computed = computeActivityBaseTransportAmount(spActivityUnitPrice, activityMileageNum, activityOthersNum);
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
}

function addLegacyCentreCapitalRow(ctx) {
  const {
    master, masterPlanItem, groupSize, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd,
    actualDurationHr, spDirectUnit, spDirectUnitPrice, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice, spLabourUnit, spLabourUnitPrice,
    spAllowancesUnit, spNonFaceUnit, spNonFaceUnitPrice, directSupportItemNumber, directSupportItemName,
    providerTravelItemNumber, providerTravelItemName, activityItemNumber, activityItemName,
    centreCapitalItemNumber, centreCapitalItemName, timeZone, addRow,
  } = ctx;
  // 5) Centre Capital Costs
    let centreAmount = getMasterPlanNumber(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.CENTRE_CAPITAL_COSTS_AMOUNT,
      'Centre Capital Cost Amount($)',
      'Centre Capital Cost Amount ($)',
      'Centre Capital Costs Amount ($)',
    ]);
    // Prefer actual duration, but if it's missing use qty = amount / unitPrice
    // (this matches the NDIS PDF invoice output where Centre Capital quantity is still shown).
    let qty = round1(actualDurationHr);
    let unitPrice = spCentreUnitPrice;
    if (qty <= 0 && centreAmount > 0 && unitPrice > 0) {
      qty = round1(centreAmount / unitPrice);
    }
    if (unitPrice <= 0 && centreAmount > 0 && qty > 0) {
      unitPrice = parseFloat((centreAmount / qty).toFixed(2));
    }
    if (centreAmount <= 0 && qty > 0 && unitPrice > 0) {
      centreAmount = qty * unitPrice;
    }

    if (centreAmount > 0) {
      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'centre_capital_costs',
          service: buildServiceItemDescription({
            itemNumber: centreCapitalItemNumber,
            itemName: centreCapitalItemName,
            unit: spCentreUnit || 'Hour(H)',
            jobStatus,
            actualStart,
            actualEnd,
            scheduledStart,
            scheduledEnd,
            fallback: 'Centre Capital Costs Item',
            timeZone,
          }),
          unit: spCentreUnit || 'Hour(H)',
          quantity: qty,
          unitPrice,
          totalAmount: centreAmount,
          supportNumber: centreCapitalItemNumber,
          claimType: '',
        });
      }
    }
}

function addLegacyLabourTravelTimeRow(ctx) {
  const {
    master, masterPlanItem, groupSize, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd,
    actualDurationHr, spDirectUnit, spDirectUnitPrice, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice, spLabourUnit, spLabourUnitPrice,
    spAllowancesUnit, spNonFaceUnit, spNonFaceUnitPrice, directSupportItemNumber, directSupportItemName,
    providerTravelItemNumber, providerTravelItemName, activityItemNumber, activityItemName,
    centreCapitalItemNumber, centreCapitalItemName, timeZone, addRow,
  } = ctx;
  // 6) Labour Travel Time (quantity in hours, derived from minutes)
    const labourAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT]);
    if (labourAmount > 0) {
      const labourMinRaw = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_MIN]);
      const qty = round1(labourMinRaw / 60);
      if (qty > 0 && spLabourUnitPrice > 0) {
        addRow({
          code: 'labour_travel_time',
          service: buildServiceItemDescription({
            itemNumber: directSupportItemNumber,
            itemName: 'Provider Travel - Labour Travel Time Costs',
            unit: spLabourUnit || 'Hour(H)',
            jobStatus,
            actualStart,
            actualEnd,
            scheduledStart,
            scheduledEnd,
            fallback: 'Provider Travel - Labour Travel Time Costs',
            timeZone,
          }),
          unit: spLabourUnit || '',
          quantity: qty,
          unitPrice: spLabourUnitPrice,
          totalAmount: labourAmount,
          supportNumber: directSupportItemNumber,
          claimType: 'TRAN',
        });
      }
    }
}

function addLegacyAllowancesRow(ctx) {
  const {
    master, masterPlanItem, groupSize, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd,
    actualDurationHr, spDirectUnit, spDirectUnitPrice, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice, spLabourUnit, spLabourUnitPrice,
    spAllowancesUnit, spNonFaceUnit, spNonFaceUnitPrice, directSupportItemNumber, directSupportItemName,
    providerTravelItemNumber, providerTravelItemName, activityItemNumber, activityItemName,
    centreCapitalItemNumber, centreCapitalItemName, timeZone, addRow,
  } = ctx;
  // 7) Allowances (quantity=1, unitPrice=Used Allowance Amount)
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
        supportNumber: directSupportItemNumber,
        claimType: isNdiaRequiredReport ? 'REPW' : '',
      });
    }
}

function addLegacyNonFaceToFaceRow(ctx) {
  const {
    master, masterPlanItem, groupSize, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd,
    actualDurationHr, spDirectUnit, spDirectUnitPrice, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice, spLabourUnit, spLabourUnitPrice,
    spAllowancesUnit, spNonFaceUnit, spNonFaceUnitPrice, directSupportItemNumber, directSupportItemName,
    providerTravelItemNumber, providerTravelItemName, activityItemNumber, activityItemName,
    centreCapitalItemNumber, centreCapitalItemName, timeZone, addRow,
  } = ctx;
  // 8) Non-Face-to-Face Support (quantity=hours)
    const nonFaceAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_AMOUNT]);
    if (nonFaceAmount > 0) {
      const qty = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_TIME_HR]);
      const nf2fType = formatLabelValue(master[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS]).trim();
      if (qty > 0 && spNonFaceUnitPrice > 0) {
        addRow({
          code: 'non_face_to_face',
          service: buildServiceItemDescription({
            itemNumber: directSupportItemNumber,
            itemName: `Non-Face-to-Face Support${nf2fType ? ` - ${nf2fType}` : ''}`,
            unit: spNonFaceUnit || 'Hour(H)',
            jobStatus,
            actualStart,
            actualEnd,
            scheduledStart,
            scheduledEnd,
            fallback: 'Non-Face-to-Face Support',
            timeZone,
          }),
          unit: spNonFaceUnit || '',
          quantity: qty,
          unitPrice: spNonFaceUnitPrice,
          totalAmount: nonFaceAmount,
          supportNumber: directSupportItemNumber,
          claimType: 'NF2F',
        });
      }
    }
}

function buildCancellationServiceDesc({ itemNumber, itemName, unit, scheduledStart, scheduledEnd, groupSize, timeZone, billablePct }) {
  let desc = buildServiceItemDescription({
    itemNumber,
    itemName: itemName ? `Cancellation Fee - ${itemName}` : 'Cancellation Fee',
    unit,
    jobStatus: 'Cancelled',
    scheduledStart,
    scheduledEnd,
    groupSize,
    timeZone,
  });
  if (billablePct) desc += ` - ${billablePct}%`;
  return desc;
}

function addLegacyCancellationComponentRow(ctx, config) {
  const {
    shortNotice, code, itemNumber, itemName, unit, unitPriceBase, qty,
    scheduledStart, scheduledEnd, groupSize, timeZone, billablePct, addRow,
  } = config;
  if (!shortNotice) return;
  const unitPriceRaw = unitPriceBase * (billablePct / 100);
  const unitPrice = parseFloat(unitPriceRaw.toFixed(2));
  const totalAmount = parseFloat((qty * unitPrice).toFixed(2));
  if (qty <= 0 || unitPrice <= 0) return;
  addRow({
    code,
    service: buildCancellationServiceDesc({ itemNumber, itemName, unit, scheduledStart, scheduledEnd, groupSize, timeZone, billablePct }),
    unit: unit || '',
    quantity: qty,
    unitPrice,
    totalAmount,
    supportNumber: itemNumber,
    claimType: 'CANC',
  });
}

function addLegacyCancelledServiceRows(ctx) {
  const {
    master, cancellationTypeItem, scheduledDurationHr, supportCatalogue,
    spDirectUnit, spDirectUnitPrice, groupSize, spNonLabourUnit, spNonLabourUnitPrice,
    spActivityUnit, spActivityUnitPrice, spCentreUnit, spCentreUnitPrice,
    directSupportItemNumber, directSupportItemName, providerTravelItemNumber, providerTravelItemName,
    activityItemNumber, activityItemName, centreCapitalItemNumber, centreCapitalItemName,
    scheduledStart, scheduledEnd, timeZone, addRow,
  } = ctx;
  const cancellationFee = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE]);
  if (cancellationFee <= 0) return;
  const billablePct = parseNumberValue(getValue(cancellationTypeItem, NDIS_CANCELLATION_TYPE_ATTR.BILLABLE_TO_CLIENT_PCT));
  const scheduledDuration = round1(scheduledDurationHr);
  const rowBase = { scheduledStart, scheduledEnd, groupSize, timeZone, billablePct, addRow, qty: scheduledDuration };
  const directQty = spDirectUnit.includes('Hour')
    ? scheduledDuration
    : parseNumberValue(master[NDIS_MASTERPLAN_ATTR.QUANTITY_DIRECT_SUPPORT_NON_TIME]);
  const directUnitPriceBase = spDirectUnit.includes('Hour')
    ? (groupSize > 0 ? spDirectUnitPrice / groupSize : 0)
    : spDirectUnitPrice;
  addLegacyCancellationComponentRow(ctx, {
    ...rowBase,
    shortNotice: getShortNoticeCancellationsFlag(supportCatalogue?.directSupport),
    code: 'canc_direct_support', itemNumber: directSupportItemNumber, itemName: directSupportItemName,
    unit: spDirectUnit, unitPriceBase: directUnitPriceBase, qty: directQty,
  });
  addLegacyCancellationComponentRow(ctx, {
    ...rowBase,
    shortNotice: getShortNoticeCancellationsFlag(supportCatalogue?.providerTravelNonLabour),
    code: 'canc_provider_travel', itemNumber: providerTravelItemNumber, itemName: providerTravelItemName,
    unit: spNonLabourUnit, unitPriceBase: spNonLabourUnitPrice,
  });
  addLegacyCancellationComponentRow(ctx, {
    ...rowBase,
    shortNotice: getShortNoticeCancellationsFlag(supportCatalogue?.activityTransport),
    code: 'canc_activity_transport', itemNumber: activityItemNumber, itemName: activityItemName,
    unit: spActivityUnit, unitPriceBase: spActivityUnitPrice,
  });
  addLegacyCancellationComponentRow(ctx, {
    ...rowBase,
    shortNotice: getShortNoticeCancellationsFlag(supportCatalogue?.centreCapital),
    code: 'canc_centre_capital', itemNumber: centreCapitalItemNumber, itemName: centreCapitalItemName,
    unit: spCentreUnit, unitPriceBase: spCentreUnitPrice,
  });
}

export function buildLegacyNdisMasterPlanServiceRows(args) {
  const ctx = buildLegacyMasterPlanContext(args);
  if (!ctx.isCancelled) {
    addLegacyDirectSupportTimeRow(ctx);
    addLegacyDirectSupportNonTimeRow(ctx);
    addLegacyProviderTravelNonLabourRow(ctx);
    addLegacyActivityTransportRow(ctx);
    addLegacyCentreCapitalRow(ctx);
    addLegacyLabourTravelTimeRow(ctx);
    addLegacyAllowancesRow(ctx);
    addLegacyNonFaceToFaceRow(ctx);
  } else {
    addLegacyCancelledServiceRows(ctx);
  }
  return ctx.rows;
}
