export const NDIS_AMOUNT_VALIDATION_MSG =
  'Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.';

export function formatNdisAmount(val) {
  const num = Number(val);
  if (!isNaN(num)) {
    const factor = Math.pow(10, 2);
    return (Math.round(num * factor) / factor).toFixed(2);
  }
  return val;
}

export async function assertNdisAmountMatches(ctx, amountValue, calculatedAmount) {
  if (parseFloat(formatNdisAmount(amountValue)) === parseFloat(formatNdisAmount(calculatedAmount))) {
    return;
  }
  const { workspaceId, boardId, itemId, setIntegrationMessage, awaitIntegrationMessage = true } = ctx;
  if (awaitIntegrationMessage) {
    await setIntegrationMessage(workspaceId, boardId, itemId, NDIS_AMOUNT_VALIDATION_MSG);
  } else {
    setIntegrationMessage(workspaceId, boardId, itemId, NDIS_AMOUNT_VALIDATION_MSG);
  }
  throw new Error(NDIS_AMOUNT_VALIDATION_MSG);
}

function formatShiftTime(value, timezone) {
  if (!value) return '';
  return new Date(value).toLocaleString('en-AU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  });
}

export async function buildDirectSupportHourLine(ctx) {
  const { servicePlanValues, invoiceValues, groupSize, timezone } = ctx;
  if (servicePlanValues?.directSupportUnit !== 'Hour(H)') return null;

  const unitPrice = Number(servicePlanValues?.directSupportUnitPrice) / groupSize || 0;
  const itemNumber = servicePlanValues?.directSupportItemNumber || '';
  const itemName = servicePlanValues?.directSupportItemName || '';
  const startTime = formatShiftTime(invoiceValues['Actual Shift Start Date and Time'], timezone);
  const endTime = formatShiftTime(invoiceValues['Actual Shift End Date and Time'], timezone);
  const actualShiftDuration = Number(invoiceValues['Actual Shift Duration(Hr.)']);
  const qty = (typeof actualShiftDuration === 'number' && !isNaN(actualShiftDuration))
    ? Number(actualShiftDuration.toFixed(1))
    : 0;
  const amountValue = formatNdisAmount(Number(invoiceValues['Direct Support Value($) - Time Based Support'])) || 0;
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(amountValue > 0)) return null;

  let desc = itemName;
  if (itemNumber) desc += ` - ${itemNumber}`;
  if (startTime && endTime) desc += ` - from ${startTime} to ${endTime}`;
  if (desc === '') desc = 'Direct Support - Hour based';
  if (groupSize !== 1) desc += ` - Group Size: ${groupSize}`;
  if (servicePlanValues?.directSupportUnit) desc += ` - Unit: ${servicePlanValues.directSupportUnit}`;

  await assertNdisAmountMatches(ctx, amountValue, amount);
  return {
    desc,
    unit: servicePlanValues?.directSupportUnit || ' ',
    qty,
    unitPrice,
    amount,
  };
}

export async function buildDirectSupportNonHourLine(ctx) {
  const { servicePlanValues, invoiceValues } = ctx;
  if (servicePlanValues?.directSupportUnit === 'Hour(H)') return null;

  const unitPrice = Number(servicePlanValues?.directSupportUnitPrice) || 0;
  const itemNumber = servicePlanValues?.directSupportItemNumber || '';
  const itemName = servicePlanValues?.directSupportItemName || '';
  const quantity = invoiceValues['Quantity (Direct Support - Non Time Based Support)'] || 0;
  const unit = servicePlanValues?.directSupportUnit || '';
  const qty = Number(quantity) || 0;
  const amountValue = formatNdisAmount(Number(invoiceValues['Direct Support Value($) - Non Time Based Support'])) || 0;
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(amountValue > 0)) return null;

  let desc = itemName;
  if (itemNumber) desc += ` - ${itemNumber}`;
  if (quantity && unit) desc += ` - ${quantity} ${unit}`;
  if (desc === '') desc = 'Direct Support - NOT Hour based';
  if (servicePlanValues?.directSupportUnit) desc += ` - ${servicePlanValues.directSupportUnit}`;

  await assertNdisAmountMatches(ctx, amountValue, amount);
  return { desc, unit: unit || ' ', qty, unitPrice, amount };
}

export async function buildProviderTravelNonLabourLine(ctx) {
  const { servicePlanValues, invoiceValues } = ctx;
  const unitPrice = 1;
  const mileage = invoiceValues['Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a Vehicle is Used.'] || '';
  const others = invoiceValues['Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied.'] || '';
  const itemName = servicePlanValues?.providerTravelItemName || '';
  const itemNumber = servicePlanValues?.providerTravelItemNumber || '';
  const qty = Number(invoiceValues['Provider Travel - Non-Labour Cost Amount($)']) || 0;
  const amountValue = formatNdisAmount(Number(invoiceValues['Provider Travel - Non-Labour Cost Amount($)'])) || 0;
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(amountValue > 0)) return null;

  let desc = itemName;
  if (itemNumber) desc += ` - ${itemNumber}`;
  if (mileage) desc += ` - ${mileage}km`;
  if (others) desc += ` - Others: ${others}`;
  if (desc === '') desc = 'Provider Travel - Non-Labour Cost Item';
  if (servicePlanValues?.nonLabourTravelUnit) desc += ` - ${servicePlanValues.nonLabourTravelUnit}`;

  await assertNdisAmountMatches(ctx, amountValue, amount);
  return { desc, unit: servicePlanValues?.nonLabourTravelUnit || ' ', qty, unitPrice, amount };
}

export async function buildActivityBasedTransportLine(ctx) {
  const { servicePlanValues, invoiceValues } = ctx;
  const unitPrice = 1;
  const mileage = invoiceValues['Activity Base Transport Mileage(Kms) as per the Service Plan, if a Vehicle is Used.'] || '';
  const others = invoiceValues['Activity Base Transport Costs as per the Service Plan, if other costs are applied.'] || '';
  const itemName = servicePlanValues?.activityBasedTransportItemName || '';
  const itemNumber = servicePlanValues?.activityBasedTransportItemNumber || '';
  const qty = Number(invoiceValues['Activity Base Transport Amount($)']) || 0;
  const amountValue = formatNdisAmount(Number(invoiceValues['Activity Base Transport Amount($)'])) || 0;
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(amountValue > 0)) return null;

  let desc = itemName;
  if (itemNumber) desc += ` - ${itemNumber}`;
  if (mileage) desc += ` - ${mileage}km`;
  if (others) desc += ` - Others: ${others}`;
  if (desc === '') desc = 'Activity Based Transport Item';
  if (servicePlanValues?.activityBasedTransportUnit) desc += ` - ${servicePlanValues.activityBasedTransportUnit}`;

  await assertNdisAmountMatches(ctx, amountValue, amount);
  return { desc, unit: servicePlanValues?.activityBasedTransportUnit || ' ', qty, unitPrice, amount };
}

export async function buildCentreCapitalCostsLine(ctx) {
  const { servicePlanValues, invoiceValues } = ctx;
  const unitPrice = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
  const itemName = servicePlanValues?.centreCapitalCostsItemName || '';
  const itemNumber = servicePlanValues?.centreCapitalCostsItemNumber || '';
  const actualShiftDuration = Number(invoiceValues['Actual Shift Duration(Hr.)']);
  const qty = (typeof actualShiftDuration === 'number' && !isNaN(actualShiftDuration))
    ? Number(actualShiftDuration.toFixed(1))
    : 0;
  const amountValue = formatNdisAmount(Number(invoiceValues['Centre Capital Costs Amount($)'])) || 0;
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(amountValue > 0)) return null;

  let desc = itemName;
  if (itemNumber) desc += ` - ${itemNumber}`;
  if (desc === '') desc = 'Centre Capital Costs Item';
  if (servicePlanValues?.centreCapitalCostsUnit) desc += ` - ${servicePlanValues.centreCapitalCostsUnit}`;

  await assertNdisAmountMatches(ctx, amountValue, amount);
  return { desc, unit: servicePlanValues?.centreCapitalCostsUnit || ' ', qty, unitPrice, amount };
}

export async function buildLabourTravelTimeLine(ctx) {
  const { servicePlanValues, invoiceValues } = ctx;
  const unitPrice = Number(servicePlanValues?.labourTravelTimeUnitPrice) || 0;
  const qty = Number(invoiceValues['Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.']) || 0;
  const amountValue = formatNdisAmount(Number(invoiceValues['Labour Travel Time Amount($)'])) || 0;
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(amountValue > 0)) return null;

  let desc = 'Provider Travel - Labour Travel Time Costs';
  if (servicePlanValues?.labourTravelTimeUnit) desc += ` - ${servicePlanValues.labourTravelTimeUnit}`;

  await assertNdisAmountMatches(ctx, amountValue, amount);
  return { desc, unit: servicePlanValues?.labourTravelTimeUnit || ' ', qty, unitPrice, amount };
}

export async function buildAllowancesLine(ctx) {
  const { servicePlanValues, invoiceValues } = ctx;
  const unitPrice = Number(invoiceValues['Used Allowance Amount($) as per the Service Plan']) || 0;
  const qty = 1;
  const amountValue = formatNdisAmount(Number(invoiceValues['Allowances Amount($)'])) || 0;
  const amount = formatNdisAmount(unitPrice);
  if (!(amountValue > 0)) return null;

  let desc = `Allowances - ${invoiceValues.Allowances}`;
  if (servicePlanValues?.usedAllowanceUnit) desc += ` - ${servicePlanValues.usedAllowanceUnit}`;

  await assertNdisAmountMatches(ctx, amountValue, amount);
  return { desc, unit: servicePlanValues?.usedAllowanceUnit || ' ', qty, unitPrice, amount };
}

export async function buildNonFaceToFaceLine(ctx) {
  const { servicePlanValues, invoiceValues } = ctx;
  const unitPrice = Number(servicePlanValues?.nonFaceToFaceSupportUnitPrice) || 0;
  const qty = Number(invoiceValues['Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)']) || 0;
  const amountValue = formatNdisAmount(Number(invoiceValues['Non-Face-to-Face Amount($)'])) || 0;
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(amountValue > 0)) return null;

  let desc = `Non-Face-to-Face Support - ${invoiceValues['Non-Face-to-Face Supports']}`;
  if (servicePlanValues?.nonFaceToFaceSupportUnit) desc += ` - ${servicePlanValues.nonFaceToFaceSupportUnit}`;

  await assertNdisAmountMatches(ctx, amountValue, amount);
  return { desc, unit: servicePlanValues?.nonFaceToFaceSupportUnit || ' ', qty, unitPrice, amount };
}

const DELIVERED_LINE_BUILDERS = [
  buildDirectSupportHourLine,
  buildDirectSupportNonHourLine,
  buildProviderTravelNonLabourLine,
  buildActivityBasedTransportLine,
  buildCentreCapitalCostsLine,
  buildLabourTravelTimeLine,
  buildAllowancesLine,
  buildNonFaceToFaceLine,
];

export async function buildDeliveredNdisMasterPlanLines(ctx) {
  const lines = [];
  for (const builder of DELIVERED_LINE_BUILDERS) {
    const line = await builder(ctx);
    if (line) lines.push(line);
  }
  return lines;
}

function buildCancellationDesc(prefix, itemName, itemNumber, cancellationPercentage, groupSize, unitSuffix) {
  let desc = prefix;
  if (itemName) desc += ` - ${itemName}`;
  if (itemNumber) desc += ` - ${itemNumber}`;
  desc += ` - ${cancellationPercentage}%`;
  if (groupSize !== 1) desc += ` - Group Size: ${groupSize}`;
  if (unitSuffix) desc += ` - ${unitSuffix}`;
  return desc;
}

export function buildDirectSupportCancellationLine(ctx) {
  const { servicePlanValues, invoiceValues, cancellationTypeValues, groupSize } = ctx;
  if (servicePlanValues?.directSupportShortNoticeCancellations !== 'Y') return null;

  const cancellationPercentage = Number(cancellationTypeValues?.billableToClient) || 0;
  const scheduledShiftDuration = (invoiceValues['Scheduled Shift Duration(Hr.)'] > 0)
    ? Number(invoiceValues['Scheduled Shift Duration(Hr.)']).toFixed(1)
    : 0;
  const amountValue = formatNdisAmount(Number(invoiceValues['Cancellation Fee($)'])) || 0;
  if (!(amountValue > 0)) return null;

  const baseUnitPrice = groupSize > 0 ? Number(servicePlanValues?.directSupportUnitPrice) / groupSize : 0;
  const itemName = servicePlanValues?.directSupportItemName || '';
  const itemNumber = servicePlanValues?.directSupportItemNumber || '';
  let qty = scheduledShiftDuration;
  let unitPrice;
  if (servicePlanValues?.directSupportUnit === 'Hour(H)') {
    unitPrice = Number(formatNdisAmount(baseUnitPrice * (cancellationPercentage / 100)));
  } else {
    const nonTimeBasedValue = Number(servicePlanValues.directSupportUnitPrice) || 0;
    unitPrice = Number(formatNdisAmount(nonTimeBasedValue * (cancellationPercentage / 100)));
    qty = Number(invoiceValues['Quantity (Direct Support - Non Time Based Support)']) || 0;
  }
  const amount = formatNdisAmount(qty * unitPrice);
  const desc = buildCancellationDesc(
    'Cancellation Fee',
    itemName,
    itemNumber,
    cancellationPercentage,
    groupSize,
    servicePlanValues?.directSupportUnit ? `Unit: ${servicePlanValues.directSupportUnit}` : '',
  );
  return {
    desc,
    unit: servicePlanValues?.directSupportUnit || ' ',
    qty,
    unitPrice,
    amount,
    cancellationAmount: Number(amount),
  };
}

export function buildProviderTravelCancellationLine(ctx) {
  const { servicePlanValues, invoiceValues, cancellationTypeValues } = ctx;
  if (servicePlanValues?.providerTravelShortNoticeCancellations !== 'Y') return null;

  const cancellationPercentage = Number(cancellationTypeValues?.billableToClient) || 0;
  const scheduledShiftDuration = (invoiceValues['Scheduled Shift Duration(Hr.)'] > 0)
    ? Number(invoiceValues['Scheduled Shift Duration(Hr.)']).toFixed(1)
    : 0;
  const baseUnitPrice = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
  const itemName = servicePlanValues?.providerTravelItemName || '';
  const itemNumber = servicePlanValues?.providerTravelItemNumber || '';
  const qty = scheduledShiftDuration;
  const unitPrice = Number(formatNdisAmount(baseUnitPrice * (cancellationPercentage / 100)));
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(amount > 0)) return null;

  const desc = buildCancellationDesc(
    'Cancellation Fee',
    itemName,
    itemNumber,
    cancellationPercentage,
    1,
    servicePlanValues?.nonLabourTravelUnit || '',
  );
  return {
    desc,
    unit: servicePlanValues?.nonLabourTravelUnit || ' ',
    qty,
    unitPrice,
    amount,
    cancellationAmount: Number(amount),
  };
}

export function buildActivityTransportCancellationLine(ctx) {
  const { servicePlanValues, invoiceValues, cancellationTypeValues } = ctx;
  if (servicePlanValues?.activityBasedTransportShortNoticeCancellations !== 'Y') return null;

  const cancellationPercentage = Number(cancellationTypeValues?.billableToClient) || 0;
  const scheduledShiftDuration = (invoiceValues['Scheduled Shift Duration(Hr.)'] > 0)
    ? Number(invoiceValues['Scheduled Shift Duration(Hr.)']).toFixed(1)
    : 0;
  const baseUnitPrice = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
  const itemName = servicePlanValues?.activityBasedTransportItemName || '';
  const itemNumber = servicePlanValues?.activityBasedTransportItemNumber || '';
  const qty = scheduledShiftDuration;
  const unitPrice = Number(formatNdisAmount(baseUnitPrice * (cancellationPercentage / 100)));
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(amount > 0)) return null;

  const desc = buildCancellationDesc(
    'Cancellation Fee',
    itemName,
    itemNumber,
    cancellationPercentage,
    1,
    servicePlanValues?.activityBasedTransportUnit || '',
  );
  return {
    desc,
    unit: servicePlanValues?.activityBasedTransportUnit || ' ',
    qty,
    unitPrice,
    amount,
    cancellationAmount: Number(amount),
  };
}

export function buildCentreCapitalCancellationLine(ctx) {
  const { servicePlanValues, invoiceValues, cancellationTypeValues } = ctx;
  if (servicePlanValues?.centreCapitalCostsShortNoticeCancellations !== 'Y') return null;

  const cancellationPercentage = Number(cancellationTypeValues?.billableToClient) || 0;
  const scheduledShiftDuration = (invoiceValues['Scheduled Shift Duration(Hr.)'] > 0)
    ? Number(invoiceValues['Scheduled Shift Duration(Hr.)']).toFixed(1)
    : 0;
  const baseUnitPrice = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
  const itemName = servicePlanValues?.centreCapitalCostsItemName || '';
  const itemNumber = servicePlanValues?.centreCapitalCostsItemNumber || '';
  const qty = scheduledShiftDuration;
  const unitPrice = Number(formatNdisAmount(baseUnitPrice * (cancellationPercentage / 100)));
  const amount = formatNdisAmount(qty * unitPrice);
  if (!(baseUnitPrice > 0 && amount > 0)) return null;

  const desc = buildCancellationDesc(
    'Cancellation Fee',
    itemName,
    itemNumber,
    cancellationPercentage,
    1,
    servicePlanValues?.centreCapitalCostsUnit || '',
  );
  return {
    desc,
    unit: servicePlanValues?.centreCapitalCostsUnit || ' ',
    qty,
    unitPrice,
    amount,
    cancellationAmount: Number(amount),
  };
}

const CANCELLATION_LINE_BUILDERS = [
  buildDirectSupportCancellationLine,
  buildProviderTravelCancellationLine,
  buildActivityTransportCancellationLine,
  buildCentreCapitalCancellationLine,
];

export async function buildCancelledNdisMasterPlanLines(ctx) {
  const { cancellationTypeValues, workspaceId, boardId, itemId, setIntegrationMessage, awaitIntegrationMessage = true } = ctx;
  if (!cancellationTypeValues) {
    const msg = 'Cancellation Type Item not found';
    if (awaitIntegrationMessage) {
      await setIntegrationMessage(workspaceId, boardId, itemId, msg);
    } else {
      setIntegrationMessage(workspaceId, boardId, itemId, msg);
    }
    throw new Error(msg);
  }

  const lines = [];
  let totalCancellationFee = 0;
  for (const builder of CANCELLATION_LINE_BUILDERS) {
    const line = builder(ctx);
    if (line) {
      lines.push(line);
      totalCancellationFee += line.cancellationAmount;
    }
  }

  const amountValue = formatNdisAmount(Number(ctx.invoiceValues['Cancellation Fee($)'])) || 0;
  await assertNdisAmountMatches(ctx, amountValue, totalCancellationFee);
  return lines;
}

export async function buildNdisMasterPlanInvoiceLines(ctx) {
  if (ctx.invoiceValues['Job Status'] !== 'Cancelled') {
    return buildDeliveredNdisMasterPlanLines(ctx);
  }
  return buildCancelledNdisMasterPlanLines(ctx);
}

export function ndisLinesToXeroItems(lines, { gstType, salesAccountCode, serviceDate, formatValue = formatNdisAmount }) {
  return lines.map((line) => ({
    description: serviceDate ? `${line.desc} - ${serviceDate}` : line.desc,
    quantity: formatValue(line.qty),
    unitAmount: line.unitPrice,
    taxType: gstType,
    accountCode: salesAccountCode,
  }));
}

export function ndisLinesToPdfOrders(lines, { gstLabel, serviceDate, formatValue = formatNdisAmount }) {
  return lines.map((line) => [
    serviceDate || ' ',
    line.desc,
    line.unit,
    formatValue(line.qty),
    formatValue(line.unitPrice),
    gstLabel,
    formatValue(line.amount),
  ]);
}

export function sumNdisLineAmounts(lines) {
  return lines.reduce((sum, line) => sum + Number(line.amount), 0);
}

export function buildParticipantProfileAddresses(participantProfileValues) {
  const addressLine = participantProfileValues.address || ' ';
  const suburb = participantProfileValues.suburb || ' ';
  const state = participantProfileValues.state || ' ';
  const postalCode = participantProfileValues.postcode?.toString() || ' ';
  return [
    {
      addressType: 'POBOX',
      addressLine1: addressLine,
      city: suburb,
      region: state,
      postalCode,
    },
    {
      addressType: 'STREET',
      addressLine1: addressLine,
      city: suburb,
      region: state,
      postalCode,
    },
  ];
}

export async function resolveNdisParticipantContact({
  participantProfileValues,
  getContactByEmail,
  createOrUpdateContact,
  setIntegrationMessage,
  workspaceId,
  boardId,
  itemId,
}) {
  let firstName = (participantProfileValues.firstName || '').toString().trim();
  let lastName = (participantProfileValues.lastName || '').toString().trim();
  let contact = await getContactByEmail(participantProfileValues.email);
  if (!contact) {
    await setIntegrationMessage(workspaceId, boardId, itemId, 'The contact does not exist in Xero, creating...');
    if (!firstName || !lastName) {
      throw new Error('First name and last name are required for NDIS invoice contact creation. Please ensure the participant profile contains both first and last name.');
    }
    contact = await createOrUpdateContact({
      name: participantProfileValues.fullName || `${firstName} ${lastName}`,
      firstName,
      lastName,
      addresses: buildParticipantProfileAddresses(participantProfileValues),
      emailAddress: participantProfileValues.email,
    });
    return contact;
  }

  const xeroUpdatedDate = new Date(contact.updatedDateUTC);
  const isoplusUpdatedDate = new Date(participantProfileValues.updatedAt);
  if (xeroUpdatedDate >= isoplusUpdatedDate || !firstName || !lastName) {
    return contact;
  }

  return createOrUpdateContact({
    contactID: contact.contactID,
    name: participantProfileValues.fullName || `${firstName} ${lastName}`,
    firstName,
    lastName,
    addresses: buildParticipantProfileAddresses(participantProfileValues),
    emailAddress: participantProfileValues.email,
  });
}

export function computeNdisServiceDate(invoiceValues, timezone) {
  const dateOnly = (d) => (d
    ? new Date(d).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timezone })
    : '');
  const scheduledShiftStart =
    invoiceValues['Scheduled Shift Start Date & Time'] ||
    invoiceValues['Scheduled Shift Start Date and Time'] ||
    '';
  const actualShiftStart =
    invoiceValues['Actual Shift Start Date and Time'] ||
    invoiceValues['Actual Shift Start Date & Time'] ||
    '';
  return invoiceValues['Job Status'] === 'Cancelled'
    ? dateOnly(scheduledShiftStart || actualShiftStart)
    : dateOnly(actualShiftStart || scheduledShiftStart);
}
