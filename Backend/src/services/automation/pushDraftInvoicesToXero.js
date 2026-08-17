import Business from '../../models/Business.js';
import PDFLink from '../../models/PDFLink.js';
import {
  buildDraftAccRecInvoice,
  contactFieldsFromItemData,
} from '../../utils/automationXeroInvoiceHelpers.js';
import { info } from '../../utils/logger.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { loadXeroChartOptions } from '../../utils/xeroAccountTaxHelpers.js';
import {
  configure,
  createInvoice,
  createOrUpdateContact,
  ensureAuthenticated,
  getContactByEmail,
  isAccountTaxRateMatched,
} from '../xero.js';
import { findBillableItems } from './generateDocuments.js';

function assertXeroConnected(business, workspaceId) {
  if (!business) {
    throw new Error(`Business missing for workspace ${workspaceId}`);
  }
  if (!business.xeroIntegrated || !business.xeroTokens?.accessToken) {
    throw new Error(`Xero is not connected for workspace ${workspaceId}`);
  }
}

/**
 * Escape every regular-expression metacharacter so a value is matched as a
 * literal.
 *
 * ISO+ item ids are free text. Interpolated raw into a `$regex`, one containing
 * '[' or '(' is a syntax error Mongo rejects outright — failing the whole
 * board's Xero push — and one containing '.' or '+' quietly becomes a pattern
 * that can match a DIFFERENT PDF, attaching the wrong document to a Xero draft
 * invoice. Neither is acceptable on a billing path.
 *
 * The fallback below is kept rather than deleted: PDFLink.periodKey is written
 * only by the automation generators (the model's own comment says so), so a row
 * created by the UI or webhook path has none and would otherwise never be found.
 */
function escapeRegExpLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadPdfLink({ workspaceId, itemId, periodKey }) {
  const baseQuery = {
    workspaceId: mongoEq(String(workspaceId)),
    itemId: mongoEq(String(itemId)),
  };
  const current = await PDFLink.findOne({
    ...baseQuery,
    periodKey: mongoEq(String(periodKey)),
  }).lean();
  if (current) return current;

  const suffix = `${escapeRegExpLiteral(itemId)}-${escapeRegExpLiteral(periodKey)}\\.pdf$`;
  return PDFLink.findOne({
    ...baseQuery,
    pdfLink: { $regex: suffix },
  }).lean();
}

function contactAddresses(fields) {
  const address = {
    addressLine1: fields.addressLine1,
    city: fields.city,
    region: fields.region,
    postalCode: fields.postalCode,
  };
  return [
    { addressType: 'POBOX', ...address },
    { addressType: 'STREET', ...address },
  ];
}

async function ensureXeroContact(fields) {
  const existing = await getContactByEmail(fields.emailAddress);
  const contact = existing || await createOrUpdateContact({
    name: fields.name,
    emailAddress: fields.emailAddress,
    addresses: contactAddresses(fields),
  });
  const contactId = contact?.contactID || contact?.ContactID;
  if (!contactId) {
    throw new Error('Unresolvable Xero contact: no contact ID returned');
  }
  return contactId;
}

async function assertAccountTaxMatch(workspaceId, invoice, chart) {
  const { accountCode, taxType } = invoice.lineItems[0] ?? {};
  const matched = accountCode
    && await isAccountTaxRateMatched(workspaceId, accountCode, taxType, chart);
  if (!matched) {
    throw new Error('Account code and Tax rate is not matched');
  }
}

async function pushItem({ workspaceId, boardId, item, slot, timezone, periodKey, business, chart }) {
  const link = await loadPdfLink({ workspaceId, itemId: item.itemId, periodKey });
  if (!link) {
    throw new Error(`PDF missing for scheduled Xero push: ${item.itemId}`);
  }
  if (link.xeroInvoiceId) return null;

  const fields = contactFieldsFromItemData(item.data);
  const contactId = await ensureXeroContact(fields);
  const invoice = buildDraftAccRecInvoice({
    itemData: item.data,
    contactId,
    invoiceNumber: link.invoiceNumber,
    slot,
    timezone,
    business,
    accounts: chart.accounts,
  });
  await assertAccountTaxMatch(workspaceId, invoice, chart);

  const created = await createInvoice(invoice);
  const xeroInvoiceId = created.invoiceID || created.InvoiceID;
  const xeroInvoiceNumber = created.invoiceNumber || created.InvoiceNumber;
  await PDFLink.updateOne(
    { _id: link._id },
    { $set: { xeroInvoiceId, xeroInvoiceNumber } },
  );

  const result = {
    itemId: item.itemId,
    invoiceNumber: link.invoiceNumber,
    xeroInvoiceId,
    xeroInvoiceNumber,
  };
  info('Automation', 'Scheduled invoice pushed to Xero', {
    workspaceId,
    boardId,
    itemId: item.itemId,
    invoiceNumber: link.invoiceNumber,
    xeroInvoiceNumber,
    periodKey,
  });
  return result;
}

export async function pushDraftInvoicesToXero({
  workspaceId,
  boardId,
  slot,
  timezone,
  periodKey,
}) {
  const business = await Business.findOne({
    workspaceId: mongoEq(String(workspaceId)),
  }).lean();
  assertXeroConnected(business, workspaceId);
  await configure();
  await ensureAuthenticated(workspaceId);
  const chart = await loadXeroChartOptions(workspaceId);
  const items = await findBillableItems(boardId);
  const results = [];

  for (const item of items) {
    const result = await pushItem({
      workspaceId,
      boardId,
      item,
      slot,
      timezone,
      periodKey,
      business,
      chart,
    });
    if (result) results.push(result);
  }

  return results;
}
