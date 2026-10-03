import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import {
  up,
  down,
} from '../../../migrations/1791050490815-backfill-document-numbering-initialized.js';

const businesses = () => mongoose.connection.collection('businesses');
const counter = (doc, series) => doc?.documentNumbering?.[series]?.nextNumber;

// KAN-292. A business that predates the first-numbers feature may lack the
// initialized flag and some counters (statementOfAccount and statement were added
// later). Mongoose fills a missing path with its default when it loads the
// business and writes that default back on a later save(), so a stale save could
// wind a chosen number back to 1. The backfill makes the stored document complete.
describe('backfill-document-numbering-initialized migration', () => {
  it('adds the counters and prefixes a legacy business lacks, and marks it not initialized when nothing has moved', async () => {
    await businesses().insertOne({
      workspaceId: 'ws-legacy',
      name: 'Legacy',
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
        quote: { prefix: 'QT-', nextNumber: 1 },
      },
    });

    await up(mongoose.connection);

    const doc = await businesses().findOne({ workspaceId: 'ws-legacy' });
    expect(doc.documentNumberingInitialized).toBe(false);
    expect(doc.documentNumbering.statementOfAccount).toEqual({ prefix: 'SOA-', nextNumber: 1 });
    expect(doc.documentNumbering.statement).toEqual({ prefix: 'STM-', nextNumber: 1 });
  });

  it('marks a business whose counter has moved as initialized, and leaves its numbers alone', async () => {
    await businesses().insertOne({
      workspaceId: 'ws-live',
      name: 'Live',
      documentNumbering: {
        invoice: { prefix: 'TAX-', nextNumber: 57 },
        quote: { prefix: 'QT-', nextNumber: 1 },
      },
    });

    await up(mongoose.connection);

    const doc = await businesses().findOne({ workspaceId: 'ws-live' });
    expect(doc.documentNumberingInitialized).toBe(true);
    expect(doc.documentNumbering.invoice).toEqual({ prefix: 'TAX-', nextNumber: 57 });
    expect(counter(doc, 'purchaseOrder')).toBe(1);
  });

  it('does not count the statement series when deciding', async () => {
    await businesses().insertOne({
      workspaceId: 'ws-stm',
      documentNumbering: { statement: { prefix: 'STM-', nextNumber: 9 } },
    });

    await up(mongoose.connection);

    expect((await businesses().findOne({ workspaceId: 'ws-stm' })).documentNumberingInitialized).toBe(false);
  });

  it('fills a business with no numbering at all', async () => {
    await businesses().insertOne({ workspaceId: 'ws-bare', name: 'Bare' });

    await up(mongoose.connection);

    const doc = await businesses().findOne({ workspaceId: 'ws-bare' });
    expect(doc.documentNumberingInitialized).toBe(false);
    expect(counter(doc, 'invoice')).toBe(1);
    expect(doc.documentNumbering.invoice.prefix).toBe('INV-');
  });

  it('keeps a flag and numbers the user already set', async () => {
    await businesses().insertOne({
      workspaceId: 'ws-set',
      documentNumberingInitialized: true,
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
        quote: { prefix: 'QT-', nextNumber: 1 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 1 },
        statement: { prefix: 'STM-', nextNumber: 1 },
      },
    });

    await up(mongoose.connection);

    expect((await businesses().findOne({ workspaceId: 'ws-set' })).documentNumberingInitialized).toBe(true);
  });

  it('is safe to run twice', async () => {
    await businesses().insertOne({
      workspaceId: 'ws-twice',
      documentNumbering: { invoice: { prefix: 'INV-', nextNumber: 12 } },
    });

    await up(mongoose.connection);
    const once = await businesses().findOne({ workspaceId: 'ws-twice' });
    await up(mongoose.connection);
    const twice = await businesses().findOne({ workspaceId: 'ws-twice' });

    expect(twice).toEqual(once);
  });

  it('down removes the flag and nothing else', async () => {
    await businesses().insertOne({
      workspaceId: 'ws-down',
      documentNumbering: { invoice: { prefix: 'INV-', nextNumber: 12 } },
    });
    await up(mongoose.connection);

    await down(mongoose.connection);

    const doc = await businesses().findOne({ workspaceId: 'ws-down' });
    expect(doc).not.toHaveProperty('documentNumberingInitialized');
    expect(counter(doc, 'invoice')).toBe(12);
    expect(counter(doc, 'statementOfAccount')).toBe(1);
  });
});
