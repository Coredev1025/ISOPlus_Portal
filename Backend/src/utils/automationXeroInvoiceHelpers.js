import { buildNdisQuoteXeroLineItems } from './ndisQuoteLineHelpers.js';
import { resolveSalesLineMapping } from './xeroLineItemMapping.js';
import { getDateOnlyIso } from './ndisServiceRecords.js';

function trim(value) {
  return value == null ? '' : String(value).trim();
}

export function contactFieldsFromItemData(data = {}) {
  const name = trim(data['Recipient of the Quote'] || data.Participant);
  const emailAddress = trim(data['Recipient Email']);
  if (!name && !emailAddress) {
    throw new Error('Unresolvable Xero contact: name and email are both missing');
  }
  return {
    name,
    emailAddress,
    addressLine1: trim(data['Recipient Address']),
    city: trim(data.Suburb),
    region: trim(data.State),
    postalCode: trim(data.Postcode),
  };
}

export function buildDraftAccRecInvoice({
  itemData,
  contactId,
  invoiceNumber,
  slot,
  timezone,
  business,
  accounts,
}) {
  const { accountCode, taxType } = resolveSalesLineMapping(
    business,
    'invoice',
    'GST Free',
    accounts,
  );
  const lineItems = buildNdisQuoteXeroLineItems(itemData, [], { gstType: taxType, accountCode });
  const date = getDateOnlyIso(slot, timezone);
  return {
    type: 'ACCREC',
    contact: { contactID: contactId },
    reference: invoiceNumber,
    date,
    dueDate: date,
    lineAmountTypes: 'Exclusive',
    status: 'DRAFT',
    lineItems,
  };
}
