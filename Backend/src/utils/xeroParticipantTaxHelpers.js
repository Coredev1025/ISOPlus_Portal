import { lineAmountsFrom } from './invoiceLedger/lineAmounts.js';
export function resolveParticipantTaxDueDate(invoiceDateRaw, dueDateRaw, asIsoString = false) {
  let dueDate = dueDateRaw ? String(dueDateRaw).split('T')[0] : '';
  if (dueDate) {
    return asIsoString ? (dueDateRaw || dueDate) : dueDate;
  }
  const d = new Date(invoiceDateRaw);
  d.setDate(d.getDate() + 14);
  return asIsoString ? d.toISOString() : d.toISOString().split('T')[0];
}

function parseBillingAddressParts(billingAddress) {
  return (billingAddress || '').trim()
    ? billingAddress.split(',').map((p) => p.trim()).filter((p) => p)
    : [];
}

export function buildContactPayloadFromBilling({ billingContact, email, billingAddress }) {
  const nameParts = billingContact.split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  const addressParts = parseBillingAddressParts(billingAddress);
  const contactPayload = {
    Name: billingContact,
    FirstName: firstName,
    LastName: lastName,
    ContactStatus: 'ACTIVE',
    EmailAddress: email || undefined,
  };
  if (addressParts.length >= 1) {
    contactPayload.Addresses = [{
      AddressType: 'STREET',
      AddressLine1: addressParts[0],
      City: addressParts[1] || undefined,
      Region: addressParts[2] || undefined,
      PostalCode: addressParts[3] || undefined,
    }];
  }
  return contactPayload;
}

export async function buildParticipantTaxContact({
  billingContact,
  participantProfile,
  getContactByEmail,
  getContactByName,
  createOrUpdateContact,
}) {
  const email = (participantProfile.billingEmail || '').toString().trim();
  let contact = email ? await getContactByEmail(email) : null;

  if (!contact) {
    const nameContact = await getContactByName(billingContact);
    if (nameContact) {
      if (email && participantProfile.updatedAt) {
        const xeroUpdated = new Date(nameContact.updatedDateUTC);
        const isoUpdated = new Date(participantProfile.updatedAt);
        contact = (!isNaN(isoUpdated.getTime()) && !isNaN(xeroUpdated.getTime()) && isoUpdated > xeroUpdated)
          ? await createOrUpdateContact({ contactID: nameContact.contactID, EmailAddress: email })
          : nameContact;
      } else {
        contact = nameContact;
      }
    }
  }

  if (contact) return contact;

  return createOrUpdateContact(buildContactPayloadFromBilling({
    billingContact,
    email,
    billingAddress: participantProfile.billingAddress,
  }));
}

function resolveLineDescription(item) {
  if (item.service && typeof item.service === 'string' && item.service.trim()) {
    return item.service.trim();
  }
  if (item.notes && typeof item.notes === 'string' && item.notes.trim()) {
    return item.notes.replace(/<[^>]*>/g, '').trim();
  }
  if (item.worker && typeof item.worker === 'string' && item.worker.trim()) {
    return item.worker.trim();
  }
  return 'Service';
}

function buildParticipantTaxLineItem(item, ctx) {
  const {
    isLowCatBoard,
    salesAccountCode,
    gstType,
    business,
    getXeroServiceRowDate,
    appendDateSuffix,
    formatDdMmYyyy,
    round2,
    round4,
  } = ctx;

  const description = resolveLineDescription(item);
  const rowDateRaw = getXeroServiceRowDate(item);
  const rowDate = formatDdMmYyyy(rowDateRaw, business?.headOfficeTimezone || 'Australia/Sydney');
  const xeroLineDescription = appendDateSuffix(description, rowDate);

  const quantityRaw = typeof item.quantity === 'number' ? item.quantity : Number(item.quantity || 0);
  const unitPrice = typeof item.unitPrice === 'number' ? item.unitPrice : Number(item.unitPrice || 0);
  const totalItemAmount = typeof item.totalAmount === 'number' ? item.totalAmount : Number(item.totalAmount || 0);
  const participantContributionAmount = typeof item.participantContribution === 'number'
    ? item.participantContribution
    : Number(item.totalAmount || 0);
  const lineAmountRaw = isLowCatBoard ? totalItemAmount : participantContributionAmount;
  const lineAmountMoney = round2(lineAmountRaw);
  if (lineAmountMoney === 0) return null;

  const quantity = quantityRaw !== 0 ? Math.abs(quantityRaw) : 1;
  const calculatedUnitPrice = quantity > 0 ? (lineAmountMoney / quantity) : (unitPrice > 0 ? unitPrice : lineAmountMoney);
  return {
    description: xeroLineDescription,
    quantity,
    unitAmount: round4(calculatedUnitPrice),
    lineAmount: lineAmountMoney,
    accountCode: salesAccountCode,
    taxType: gstType,
  };
}

export function buildParticipantTaxLineItems(ctx) {
  const lineItems = [];
  const billedRows = [];
  let totalAmount = 0;
  for (const item of ctx.items) {
    const lineItem = buildParticipantTaxLineItem(item, ctx);
    if (!lineItem) continue;
    lineItems.push(lineItem);
    billedRows.push({ itemId: item.id, amount: lineItem.lineAmount });
    totalAmount += lineItem.lineAmount;
  }
  // What each item billed (KAN-308), from the same amounts the Xero lines carry.
  const lineAmounts = lineAmountsFrom(billedRows, 'itemId', (row) => row.amount);
  return { lineItems, totalAmount, lineAmounts };
}
