import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';

import PDFLink from '../../../src/models/PDFLink.js';
import {
  down,
  up,
} from '../../../migrations/1787186180650-pdflink-invoice-period.js';

/**
 * Section 3.2 of the invoice selection spec, first mechanism: period fields on
 * the document ledger plus a unique constraint, so a period cannot be invoiced
 * twice.
 *
 * The ledger is `pdflinks`, not `invoicenumber`. The spec names the latter
 * because that is what production shows for the manual path, but the scheduled
 * runs already read and write `pdflinks` keyed on `periodKey` — adding period
 * fields to `invoicenumber` would create the second, parallel ledger the spec
 * is warning against, rather than avoid it.
 *
 * The constraint carries `itemId` because `pdflinks` holds one row per item,
 * not one per invoice: `recordPdfLinks` in services/automation/generateDocuments.js
 * writes a row for every item on the invoice, so a tuple without `itemId` is
 * duplicated by design and a unique index on it would reject the second row of
 * every multi-item invoice.
 */

const BASE = {
  workspaceId: 'ws-1',
  boardId: 'board-1',
  type: 'NDIS Invoice',
  pdfLink: 'https://example.com/a.pdf',
};

const connection = () => mongoose.connection;

beforeEach(async () => {
  await up(connection());
});

afterEach(async () => {
  // The suite truncates collections between tests but not indexes.
  await connection().collection('pdflinks').dropIndexes().catch(() => {});
});

describe('PDFLink period fields', () => {
  it('persists the period the document covers', async () => {
    const row = await PDFLink.create({
      ...BASE,
      itemId: 'i1',
      periodKey: '2025-01',
      periodStart: new Date('2024-12-31T13:00:00.000Z'),
      periodEnd: new Date('2025-01-31T12:59:59.999Z'),
      invoiceType: 'ndis-certification',
    });
    expect(row.periodStart).toBeInstanceOf(Date);
    expect(row.periodEnd).toBeInstanceOf(Date);
    expect(row.invoiceType).toBe('ndis-certification');
  });

  it('keeps the fields absent on a document that has no period, rather than defaulting them', async () => {
    const row = await PDFLink.create({ ...BASE, itemId: 'i2' });
    expect(row.periodStart).toBeUndefined();
    expect(row.invoiceType).toBeUndefined();
  });
});

describe('the period uniqueness constraint', () => {
  it('rejects the same item being recorded twice for one period and type', async () => {
    await PDFLink.create({ ...BASE, itemId: 'i1', periodKey: '2025-01' });
    await expect(
      PDFLink.create({ ...BASE, itemId: 'i1', periodKey: '2025-01' }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('allows the other items on the same invoice', async () => {
    await PDFLink.create({ ...BASE, itemId: 'i1', periodKey: '2025-01' });
    await expect(
      PDFLink.create({ ...BASE, itemId: 'i2', periodKey: '2025-01' }),
    ).resolves.toBeTruthy();
  });

  it('allows the same item in a different period', async () => {
    await PDFLink.create({ ...BASE, itemId: 'i1', periodKey: '2025-01' });
    await expect(
      PDFLink.create({ ...BASE, itemId: 'i1', periodKey: '2025-02' }),
    ).resolves.toBeTruthy();
  });

  it('allows the same item and period for a different document type', async () => {
    // An invoice and a statement covering one item in one period are two
    // different documents, and both are legitimate.
    await PDFLink.create({ ...BASE, itemId: 'i1', periodKey: '2025-01' });
    await expect(
      PDFLink.create({ ...BASE, itemId: 'i1', periodKey: '2025-01', type: 'Monthly Statement' }),
    ).resolves.toBeTruthy();
  });

  it('allows the same item and period on a different board', async () => {
    await PDFLink.create({ ...BASE, itemId: 'i1', periodKey: '2025-01' });
    await expect(
      PDFLink.create({ ...BASE, itemId: 'i1', periodKey: '2025-01', boardId: 'board-2' }),
    ).resolves.toBeTruthy();
  });

  it('leaves rows with no periodKey alone, so legacy documents still insert', async () => {
    // Every PDF generated before the scheduler existed has no periodKey. The
    // index is partial so those rows are outside it entirely — without that,
    // two UI-generated PDFs for one item would collide.
    await PDFLink.create({ ...BASE, itemId: 'i1' });
    await expect(PDFLink.create({ ...BASE, itemId: 'i1' })).resolves.toBeTruthy();
  });
});

describe('the migration reverses cleanly', () => {
  it('drops the index and removes the fields it introduced', async () => {
    await PDFLink.create({
      ...BASE,
      itemId: 'i1',
      periodKey: '2025-01',
      periodStart: new Date('2024-12-31T13:00:00.000Z'),
      periodEnd: new Date('2025-01-31T12:59:59.999Z'),
      invoiceType: 'ndis-certification',
    });

    await down(connection());

    const names = (await connection().collection('pdflinks').indexes()).map((i) => i.name);
    expect(names).not.toContain('automation_period_item_unique');

    const row = await connection().collection('pdflinks').findOne({ itemId: 'i1' });
    expect(row.periodStart).toBeUndefined();
    expect(row.invoiceType).toBeUndefined();
    // periodKey predates this migration and is not ours to remove.
    expect(row.periodKey).toBe('2025-01');
  });
});
