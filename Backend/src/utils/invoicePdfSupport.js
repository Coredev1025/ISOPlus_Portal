import InvoiceNumber from '../models/InvoiceNumber.js';
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
}
