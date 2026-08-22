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

  it('leaves rows whose periodKey is explicitly null outside the index', async () => {
    // `$exists: true` matches a field that is present and null, not only a
    // field that holds a value. A filter written that way pulls null rows into
    // the unique index, where two of them sharing an itemId collide — and the
    // failure surfaces on whichever path wrote the null, which has nothing to
    // do with automation. `$type: 'string'` is what actually expresses "has a
    // period key".
    await PDFLink.create({ ...BASE, itemId: 'i1', periodKey: null });
    await expect(
      PDFLink.create({ ...BASE, itemId: 'i1', periodKey: null }),
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

describe('the migration against data that already has duplicates', () => {
  /**
   * `periodKey` predates this migration — KAN-10's first pass already wrote it
   * — so a deployed database can hold two rows for the same item and period.
   * `createIndex` then fails with the driver's E11000, which names one pair and
   * gives no way to find the rest. On a billing collection, on a manual
   * migration run, that is the wrong thing to hand an operator.
   */
  it('names every offending key, not just the first one the driver hits', async () => {
    await connection().collection('pdflinks').dropIndexes().catch(() => {});
    const clash = (itemId) => ({
      ...BASE, itemId, periodKey: '2026-01', createdBy: '', isDeleted: false,
    });
    await connection().collection('pdflinks').insertMany([
      clash('i-dup-a'), clash('i-dup-a'), clash('i-dup-b'), clash('i-dup-b'),
    ]);

    // The driver's own E11000 names one pair. An operator running this by hand
    // on a billing collection then fixes that one, re-runs, and finds the next
    // — once per duplicate. One run should tell them the whole extent.
    const failure = await up(connection()).catch((err) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/duplicate/i);
    expect(failure.message).toContain('i-dup-a');
    expect(failure.message).toContain('i-dup-b');
    expect(failure.message).toContain('2026-01');
  });

  it('creates the index when the duplicates are outside the partial filter', async () => {
    await connection().collection('pdflinks').dropIndexes().catch(() => {});
    // No periodKey: legitimately repeatable, and the partial filter keeps these
    // out of the index entirely.
    const legacy = { ...BASE, itemId: 'i-legacy', createdBy: '', isDeleted: false };
    await connection().collection('pdflinks').insertMany([{ ...legacy }, { ...legacy }]);

    await expect(up(connection())).resolves.toBeUndefined();
  });
});
