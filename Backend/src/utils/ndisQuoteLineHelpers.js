import { isEmpty } from './helpers.js';

function buildQuoteItemDescription(itemNumber, refValues, fallback, unitLabel) {
  const namePart = refValues?.itemName ? `-${refValues.itemName}` : '';
  const base = (`${itemNumber || ''}${namePart}` || fallback);
  return unitLabel ? `${base} - ${unitLabel}` : base;
}

function buildDirectSupportQuoteLine(NDISQuoteValues, directSupportValues, gstType) {
  if (!NDISQuoteValues['Quantity (Direct Support)'] || !NDISQuoteValues['Unit Price for Direct Support($)']) return null;
  return {
    description: buildQuoteItemDescription(
      NDISQuoteValues['Direct Support Item Number'],
      directSupportValues,
      'Direct Support',
      NDISQuoteValues['Unit (Direct Support)'],
    ),
    unit: NDISQuoteValues['Unit (Direct Support)'] || '',
    quantity: Number(NDISQuoteValues['Quantity (Direct Support)']) || 0,
    unitAmount: Number(NDISQuoteValues['Unit Price for Direct Support($)']) || 0,
    taxType: gstType,
  };
}

function buildProviderTravelQuoteLine(NDISQuoteValues, providerTravelValues, gstType) {
  if (!NDISQuoteValues['Quantity (Provider Travel)'] || !NDISQuoteValues['Unit Price for Provider Travel($)']) return null;
  return {
    description: buildQuoteItemDescription(
      NDISQuoteValues['Provider Travel - Non-Labour Cost Item Number'],
      providerTravelValues,
      'Provider Travel - Non-Labour Cost',
      NDISQuoteValues['Unit (Provider Travel - Non-Labour Cost)'],
    ),
    unit: NDISQuoteValues['Unit (Provider Travel - Non-Labour Cost)'] || '',
    quantity: Number(NDISQuoteValues['Quantity (Provider Travel)']) || 0,
    unitAmount: Number(NDISQuoteValues['Unit Price for Provider Travel($)']) || 0,
    taxType: gstType,
  };
}

function buildActivityTransportQuoteLine(NDISQuoteValues, activityBasedTransportValues, gstType) {
  if (!NDISQuoteValues['Quantity (Activity Based Transport)'] || !NDISQuoteValues['Unit Price for Activity Based Transport($)']) return null;
  return {
    description: buildQuoteItemDescription(
      NDISQuoteValues['Activity Based Transport Item Number'],
      activityBasedTransportValues,
      'Activity Based Transport',
      NDISQuoteValues['Unit (Activity Based Transport)'],
    ),
    unit: NDISQuoteValues['Unit (Activity Based Transport)'] || '',
    quantity: Number(NDISQuoteValues['Quantity (Activity Based Transport)']) || 0,
    unitAmount: Number(NDISQuoteValues['Unit Price for Activity Based Transport($)']) || 0,
    taxType: gstType,
  };
}

function buildCentreCapitalQuoteLine(NDISQuoteValues, centreCapitalCostsValues, gstType) {
  if (!NDISQuoteValues['Quantity (Centre Capital Costs)'] || !NDISQuoteValues['Unit Price for Centre Capital Costs($)']) return null;
  return {
    description: buildQuoteItemDescription(
      NDISQuoteValues['Centre Capital Costs Item'],
      centreCapitalCostsValues,
      'Centre Capital Costs',
      NDISQuoteValues['Unit (Centre Capital Costs)'],
    ),
    unit: NDISQuoteValues['Unit (Centre Capital Costs)'] || '',
    quantity: Number(NDISQuoteValues['Quantity (Centre Capital Costs)']) || 0,
    unitAmount: Number(NDISQuoteValues['Unit Price for Centre Capital Costs($)']) || 0,
    taxType: gstType,
  };
}

function buildLabourTravelQuoteLine(NDISQuoteValues, providerTravelLabourTravelTime, gstType) {
  if (!NDISQuoteValues['Quantity (Labour Travel Time)']) return null;
  const labourDesc =
    ('Provider Travel - Labour Travel Time Costs' +
      (providerTravelLabourTravelTime?.itemName ? `-${providerTravelLabourTravelTime.itemName}` : '') ||
      'Provider Travel - Labour Travel Time Costs') +
    (NDISQuoteValues['Unit (Labour Travel Time)'] ? ` - ${NDISQuoteValues['Unit (Labour Travel Time)']}` : '');
  return {
    description: labourDesc,
    unit: NDISQuoteValues['Unit (Labour Travel Time)'] || '',
    quantity: Number(NDISQuoteValues['Quantity (Labour Travel Time)']) || 0,
    unitAmount: Number(NDISQuoteValues['Unit Price for Labour Travel Time ($)']) || 1,
    taxType: gstType,
  };
}

function buildAllowancesQuoteLine(NDISQuoteValues, gstType) {
  if (!NDISQuoteValues.Allowances || !NDISQuoteValues['Allowances Amount($)']) return null;
  const desc = isEmpty(NDISQuoteValues.Allowances)
    ? 'Allowances'
    : `Allowances - ${NDISQuoteValues.Allowances}` +
      (NDISQuoteValues['Unit (Allowances)'] ? ` - ${NDISQuoteValues['Unit (Allowances)']}` : '');
  return {
    description: desc,
    unit: NDISQuoteValues['Unit (Allowances)'] || ' ',
    quantity: 1,
    unitAmount: Number(NDISQuoteValues['Allowances Amount($)']) || 0,
    taxType: gstType,
  };
}

function buildNonFaceToFaceQuoteLine(NDISQuoteValues, gstType) {
  if (!NDISQuoteValues['Non-Face-to-Face Supports'] || !NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) return null;
  const desc = isEmpty(NDISQuoteValues['Non-Face-to-Face Supports'])
    ? 'Non-Face-to-Face Support'
    : `Non-Face-to-Face Support - ${NDISQuoteValues['Non-Face-to-Face Supports']}` +
      (NDISQuoteValues['Unit (Non-Face-to-Face Support)'] ? ` - ${NDISQuoteValues['Unit (Non-Face-to-Face Support)']}` : '');
  return {
    description: desc,
    unit: NDISQuoteValues['Unit (Non-Face-to-Face Support)'] || ' ',
    quantity: Number(NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) || 0,
    unitAmount: Number(NDISQuoteValues['Unit Price for Non-Face-to-Face Support ($)']) || 1,
    taxType: gstType,
  };
}

export function buildNdisQuoteXeroLineItems(NDISQuoteValues, refs, options = {}) {
  const [
    directSupportValues,
    providerTravelValues,
    activityBasedTransportValues,
    centreCapitalCostsValues,
    providerTravelLabourTravelTime,
  ] = refs;
  const gstType = options.gstType || 'EXEMPTOUTPUT';
  const accountCode = options.accountCode;
  const lines = [
    buildDirectSupportQuoteLine(NDISQuoteValues, directSupportValues, gstType),
    buildProviderTravelQuoteLine(NDISQuoteValues, providerTravelValues, gstType),
    buildActivityTransportQuoteLine(NDISQuoteValues, activityBasedTransportValues, gstType),
    buildCentreCapitalQuoteLine(NDISQuoteValues, centreCapitalCostsValues, gstType),
    buildLabourTravelQuoteLine(NDISQuoteValues, providerTravelLabourTravelTime, gstType),
    buildAllowancesQuoteLine(NDISQuoteValues, gstType),
    buildNonFaceToFaceQuoteLine(NDISQuoteValues, gstType),
  ].filter(Boolean);

  if (!accountCode) return lines;
  return lines.map((line) => ({ ...line, accountCode }));
}

function pushPdfOrder(ordersArr, subTotalRef, formatValue, gstLabel, desc, unit, qty, unitPrice) {
  const amount = qty * unitPrice;
  ordersArr.push([desc || 'Service', unit || '', formatValue(qty), formatValue(unitPrice), gstLabel, formatValue(amount)]);
  subTotalRef.value += amount;
}

export function buildNdisQuotePdfOrders(NDISQuoteValues, refs, formatValue) {
  const gstLabel = 'GST Free';
  const ordersArr = [];
  const subTotalRef = { value: 0 };

  const xeroLines = buildNdisQuoteXeroLineItems(NDISQuoteValues, refs);
  for (const line of xeroLines) {
    pushPdfOrder(
      ordersArr,
      subTotalRef,
      formatValue,
      gstLabel,
      line.description,
      line.unit || '',
      line.quantity,
      line.unitAmount,
    );
  }

  return { ordersArr, subTotal: subTotalRef.value };
}

export function buildNdisQuoteRecipientAddresses(NDISQuoteValues) {
  const shared = {
    addressLine1: NDISQuoteValues['Recipient Address'],
    city: NDISQuoteValues.Suburb,
    region: NDISQuoteValues.State,
    postalCode: NDISQuoteValues.Postcode.toString(),
  };
  return [
    { addressType: 'POBOX', ...shared },
    { addressType: 'STREET', ...shared },
  ];
}

export async function resolveNdisQuoteRecipientContact({
  NDISQuoteValues,
  getContactByEmail,
  createOrUpdateContact,
  setIntegrationMessage,
  workspaceId,
  boardId,
  itemId,
}) {
  let contact = await getContactByEmail(NDISQuoteValues['Recipient Email']);
  const contactPayload = {
    name: NDISQuoteValues['Recipient of the Quote'],
    addresses: buildNdisQuoteRecipientAddresses(NDISQuoteValues),
    emailAddress: NDISQuoteValues['Recipient Email'],
  };

  if (!contact) {
    await setIntegrationMessage(workspaceId, boardId, itemId, 'The contact does not exist in Xero, creating...');
    return createOrUpdateContact(contactPayload);
  }

  const xeroUpdatedDate = new Date(contact.updatedDateUTC);
  const isoplusUpdatedDate = new Date(NDISQuoteValues.updatedAt);
  if (xeroUpdatedDate >= isoplusUpdatedDate) {
    return contact;
  }

  return createOrUpdateContact({
    contactID: contact.contactID,
    ...contactPayload,
  });
}

export function buildNdisQuoteMappedAndXeroPayload({
  NDISQuoteValues,
  lineItems,
  contact,
  business,
  nowISO,
}) {
  const firstLine = lineItems[0] || {};
  const mappedQuote = {
    issueDate: NDISQuoteValues['Issue Date'] || nowISO,
    expiryDate: NDISQuoteValues['Expiry Date'] || nowISO,
    jobTitle: NDISQuoteValues['Job Title'] || firstLine.description || '',
    unitPrice: NDISQuoteValues['Unit Price($) - GST Excl.'] || firstLine.unitAmount || 0,
    quantity: NDISQuoteValues.Quantity || firstLine.quantity || 0,
    jobDescription: NDISQuoteValues['Job Description']
      ? NDISQuoteValues['Job Description'].toString().replace(/<[^>]*>/g, '')
      : (firstLine.description || ''),
    quoteChecklist: lineItems.map((li) => li.description || ''),
  };
  const xeroQuote = {
    contact: { contactID: contact.contactID },
    date: NDISQuoteValues['Issue Date'] || nowISO,
    expiryDate: NDISQuoteValues['Expiry Date'] || nowISO,
    lineItems,
    terms: `Terms & Conditions\n- This quote remains valid until the expiry date indicated above.\n- Payment Terms: ${business?.bankDetails?.accountsReceivableTerms ? business.bankDetails.accountsReceivableTerms : ' '}\n- All prices are subject to change with prior notice.\n- A cancellation fee may apply as per the terms of the service agreement.`,
  };
  return { mappedQuote, xeroQuote };
}
