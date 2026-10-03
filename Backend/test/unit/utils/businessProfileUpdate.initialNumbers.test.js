import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import Business from '../../../src/models/Business.js';
import { updateExistingBusiness } from '../../../src/utils/businessProfileUpdate.js';
import { initialNumberSetPaths } from '../../../src/utils/documentNumberingInitial.js';
import { up } from '../../../migrations/1791050490815-backfill-document-numbering-initialized.js';

const raw = () => mongoose.connection.collection('businesses');
const CHOSEN = {
  invoice: { nextNumber: 1001 },
  purchaseOrder: { nextNumber: 101 },
  quote: { nextNumber: 501 },
  statementOfAccount: { nextNumber: 7 },
};

// KAN-292. The conditional write is what stops the first numbers overwriting a
// counter that moved, and a stale save() must not undo them afterwards.
describe('updateExistingBusiness, setting the first numbers', () => {
  it('writes the numbers and the flag, and says it did', async () => {
    const { insertedId } = await raw().insertOne({ workspaceId: 'ws-ok', name: 'Ok' });

    const out = await updateExistingBusiness(insertedId, { name: 'Ok' }, initialNumberSetPaths(CHOSEN));

    expect(out.initialNumbersWritten).toBe(true);
    const stored = await raw().findOne({ _id: insertedId });
    expect(stored.documentNumberingInitialized).toBe(true);
    expect(stored.documentNumbering.invoice.nextNumber).toBe(1001);
    expect(stored.documentNumbering.statementOfAccount.nextNumber).toBe(7);
  });

  it('matches a business whose counters are missing from the stored document', async () => {
    const { insertedId } = await raw().insertOne({
      workspaceId: 'ws-missing',
      documentNumbering: { invoice: { prefix: 'INV-' } },
    });

    const out = await updateExistingBusiness(insertedId, {}, initialNumberSetPaths(CHOSEN));

    expect(out.initialNumbersWritten).toBe(true);
  });

  it('does not write over a counter that moved after the caller looked, and says so', async () => {
    const { insertedId } = await raw().insertOne({
      workspaceId: 'ws-moved',
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
        quote: { prefix: 'QT-', nextNumber: 1 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 1 },
      },
    });
    // A document is issued between the route's check and the write.
    await raw().updateOne({ _id: insertedId }, { $set: { 'documentNumbering.invoice.nextNumber': 2 } });

    const out = await updateExistingBusiness(insertedId, { name: 'Moved' }, initialNumberSetPaths(CHOSEN));

    expect(out.initialNumbersWritten).toBe(false);
    const stored = await raw().findOne({ _id: insertedId });
    expect(stored.documentNumbering.invoice.nextNumber).toBe(2);
    expect(stored.documentNumbering.quote.nextNumber).toBe(1);
    expect(stored.name).toBe('Moved');
    expect(stored.documentNumberingInitialized).not.toBe(true);
  });

  it('reports not written when no numbers were asked for', async () => {
    const { insertedId } = await raw().insertOne({ workspaceId: 'ws-none', name: 'None' });
    const out = await updateExistingBusiness(insertedId, { name: 'None 2' }, {});
    expect(out.initialNumbersWritten).toBe(false);
    expect(out.business.name).toBe('None 2');
  });
});

describe('a save() of a stale copy after the first numbers were set', () => {
  async function loadStaleThenSetNumbers(workspaceId) {
    const stale = await Business.findOne({ workspaceId });
    const out = await updateExistingBusiness(stale._id, {}, initialNumberSetPaths(CHOSEN));
    expect(out.initialNumbersWritten).toBe(true);
    // The quote generator's read-then-increment, on the copy loaded earlier.
    stale.documentNumbering.quote.nextNumber += 1;
    await stale.save();
    return raw().findOne({ workspaceId });
  }

  it('keeps the flag, even when the document had none stored', async () => {
    await raw().insertOne({
      workspaceId: 'ws-stale-flag',
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
        quote: { prefix: 'QT-', nextNumber: 1 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 1 },
        statement: { prefix: 'STM-', nextNumber: 1 },
      },
    });

    const stored = await loadStaleThenSetNumbers('ws-stale-flag');

    expect(stored.documentNumberingInitialized).toBe(true);
    expect(stored.documentNumbering.invoice.nextNumber).toBe(1001);
  });

  it('keeps every chosen number once the backfill has run on a legacy document', async () => {
    await raw().insertOne({
      workspaceId: 'ws-stale-legacy',
      documentNumbering: { invoice: { prefix: 'INV-', nextNumber: 1 } },
    });
    await up(mongoose.connection);

    const stored = await loadStaleThenSetNumbers('ws-stale-legacy');

    expect(stored.documentNumberingInitialized).toBe(true);
    expect(stored.documentNumbering.invoice.nextNumber).toBe(1001);
    expect(stored.documentNumbering.statementOfAccount.nextNumber).toBe(7);
  });
});
