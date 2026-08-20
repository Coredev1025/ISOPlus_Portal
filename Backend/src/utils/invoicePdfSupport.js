// The one home for the four helpers every invoice/quote PDF path needs. Each
// of these existed twice — here and again in routes/webhook.js — with the
// webhook copy hardcoding 'Australia/Sydney' where this one reads
// DEFAULT_TIMEZONE. Import from here; do not re-declare.
//
// Readers: routes/webhook.js, services/automation/ndisInvoiceGeneratorPdf.js,
// and (via injected deps built in routes/webhook.js) utils/webhookNdisPdfHandlers.js,
// utils/webhookParticipantTaxPdfHelpers.js, utils/webhookMonthlyStatementPdfHelpers.js.
import InvoiceNumber from '../models/InvoiceNumber.js';
import { claimItemsForInvoice } from './invoicedMarker.js';
import { getS3File } from './uploadS3.js';
import { info, warn } from './logger.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

export function enableRepeatHeadOnTables(template) {
  if (!template?.schemas || !Array.isArray(template.schemas)) return;
  for (const pageSchemas of template.schemas) {
    if (!Array.isArray(pageSchemas)) continue;
    for (const schema of pageSchemas) {
      if (schema && schema.type === 'table') schema.repeatHead = true;
    }
  }
}

export function formatDateNumericAU(value, timeZone) {
  const zone = timeZone || DEFAULT_TIMEZONE;
  if (!value) {
    return new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric', timeZone: zone });
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric', timeZone: zone });
}

export async function getLogoData(business, req = null) {
  const logoKey = business.defaultLogo;
  if (!logoKey) return '';
  const buffer = await getS3File(logoKey, false);
  if (!buffer) throw new Error('Failed to retrieve logo from S3');
  info('Webhook-Service', 'Embedding default logo for PDF generation', {
    workspaceId: business?.workspaceId,
    hasDefaultLogo: !!business?.defaultLogo,
  }, req ?? null);
  const type = logoKey.split('.').pop();
  return `data:image/${type};base64,${buffer.toString('base64')}`;
}

/**
 * Record an invoice number against an item, and mark the item as invoiced.
 *
 * The marking is section 3.3 of the invoice selection spec: manual invoice
 * generation must set the same marker as the automated run, or the next
 * scheduled run finds those items unmarked and bills them again. This function
 * is where it belongs because it is the single point every path that allocates
 * an invoice number already passes through — the manual NDIS and SaH webhook
 * generators, the Xero routes, and the scheduled generator.
 *
 * `claimItemsForInvoice` rather than an unconditional set, so a second document
 * covering the same item (typically the Xero push following the PDF run) does
 * not overwrite the claim naming the invoice the participant received. Either
 * marker excludes the item from selection, so the guard holds either way.
 *
 * The marker write is best-effort, matching what this function has always done
 * with its own write. A failure here means an item that was invoiced is not
 * marked, and the next run would bill it again — so it is warned separately and
 * explicitly rather than folded into the invoice-number warning.
 */
export async function saveInvoiceNumber(workspaceId, boardId, itemId, invoiceNumber, type, pdfLink = null) {
  try {
    await InvoiceNumber.findOneAndUpdate(
      { itemId, workspaceId, boardId, type },
      {
        $set: {
          itemId, workspaceId, boardId, invoiceNumber, type, pdfLink, updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    warn('Webhook-Service', 'Failed to save invoice number to database', {
      workspaceId, boardId, itemId, invoiceNumber, type, error: err.message,
    }, {});
  }

  try {
    await claimItemsForInvoice({
      workspaceId, boardId, itemIds: [itemId], invoiceNumber, periodKey: null,
    });
  } catch (err) {
    warn('Webhook-Service', 'Failed to mark item as invoiced; it may be billed again', {
      workspaceId, boardId, itemId, invoiceNumber, type, error: err.message,
    }, {});
  }
}
