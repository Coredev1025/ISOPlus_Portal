import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import Business from '../../../src/models/Business.js';
import { updateExistingBusiness } from '../../../src/utils/businessProfileUpdate.js';
import { initialNumberSetPaths } from '../../../src/utils/documentNumberingInitial.js';
import { up } from '../../../migrations/1791050490815-backfill-document-numbering-initialized.js';

const raw = () => mongoose.connection.collection('businesses');
// A business as the backfill migration leaves it: every counter is stored.
const FULL_NUMBERING = {
  invoice: { prefix: 'INV-', nextNumber: 1 },
  purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
  quote: { prefix: 'QT-', nextNumber: 1 },
  statementOfAccount: { prefix: 'SOA-', nextNumber: 1 },
  statement: { prefix: 'STM-', nextNumber: 1 },
};
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
    const { insertedId } = await raw().insertOne({
      workspaceId: 'ws-ok', name: 'Ok', documentNumbering: FULL_NUMBERING,
    });

    const out = await updateExistingBusiness(insertedId, { name: 'Ok' }, initialNumberSetPaths(CHOSEN));

    expect(out.initialNumbersWritten).toBe(true);
    const stored = await raw().findOne({ _id: insertedId });
    expect(stored.documentNumberingInitialized).toBe(true);
    expect(stored.documentNumbering.invoice.nextNumber).toBe(1001);
    expect(stored.documentNumbering.statementOfAccount.nextNumber).toBe(7);
  });

  // A counter missing from the stored document means the backfill migration has
  // not run. A copy of the business loaded earlier carries Mongoose's default for
  // it and would write that default back over the number just chosen, so the
  // numbers are not written until the document is complete.
  it.each(['invoice', 'purchaseOrder', 'quote', 'statementOfAccount'])(
    'does not write the numbers while the %s counter is missing, and says so',
    async (missing) => {
      const numbering = JSON.parse(JSON.stringify(FULL_NUMBERING));
      delete numbering[missing];
      const { insertedId } = await raw().insertOne({
        workspaceId: `ws-missing-${missing}`, name: 'Old', documentNumbering: numbering,
      });

      const out = await updateExistingBusiness(insertedId, { name: 'New' }, initialNumberSetPaths(CHOSEN));

      expect(out.initialNumbersWritten).toBe(false);
      const stored = await raw().findOne({ _id: insertedId });
      expect(stored.name).toBe('New');
      expect(stored.documentNumberingInitialized).not.toBe(true);
      // Nothing was written: the missing series is still missing, the rest are untouched.
      expect(stored.documentNumbering[missing]).toBeUndefined();
      for (const [series, value] of Object.entries(numbering)) {
        expect(stored.documentNumbering[series].nextNumber).toBe(value.nextNumber);
      }
    },
  );

  it('still writes the numbers when only the statement counter is missing', async () => {
    const numbering = JSON.parse(JSON.stringify(FULL_NUMBERING));
    delete numbering.statement;
    const { insertedId } = await raw().insertOne({ workspaceId: 'ws-no-stm', documentNumbering: numbering });

    const out = await updateExistingBusiness(insertedId, {}, initialNumberSetPaths(CHOSEN));

    // The statement series is not set by the user, and a default of 1 written
    // back over a missing 1 changes nothing.
    expect(out.initialNumbersWritten).toBe(true);
  });

  it('does not write over a counter that moved after the caller looked, and says so', async () => {
    const { insertedId } = await raw().insertOne({
      workspaceId: 'ws-moved',
      documentNumbering: FULL_NUMBERING,
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
    const { insertedId } = await raw().insertOne({
      workspaceId: 'ws-none', name: 'None', documentNumbering: FULL_NUMBERING,
    });
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

  // The stale copy bumps the quote counter and saves: that read-then-increment
  // is the quote and purchase-order race tracked as KAN-291, so the quote number
  // is overwritten here and is deliberately asserted as 2, not as the chosen 501.
  // What the backfill protects is everything the stale copy did NOT touch.
  it('keeps the flag, invoice and statement of account numbers once the backfill has run on a legacy document', async () => {
    await raw().insertOne({
      workspaceId: 'ws-stale-legacy',
      documentNumbering: { invoice: { prefix: 'INV-', nextNumber: 1 } },
    });
    await up(mongoose.connection);

    const stored = await loadStaleThenSetNumbers('ws-stale-legacy');

    expect(stored.documentNumberingInitialized).toBe(true);
    expect(stored.documentNumbering.invoice.nextNumber).toBe(1001);
    expect(stored.documentNumbering.statementOfAccount.nextNumber).toBe(7);
    expect(stored.documentNumbering.quote.nextNumber).toBe(2); // KAN-291, see above
  });

  // The case the review reproduced: a legacy business with no statementOfAccount
  // counter. Until the backfill has run the numbers are refused, so a stale save
  // cannot reset the statement of account number to 1.
  it('refuses the numbers on a legacy business, so a stale save cannot reset a counter', async () => {
    await raw().insertOne({
      workspaceId: 'ws-stale-premigration',
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
        quote: { prefix: 'QT-', nextNumber: 1 },
      },
    });
    const stale = await Business.findOne({ workspaceId: 'ws-stale-premigration' });

    const out = await updateExistingBusiness(stale._id, {}, initialNumberSetPaths(CHOSEN));
    stale.name = 'Renamed';
    await stale.save();

    expect(out.initialNumbersWritten).toBe(false);
    const stored = await raw().findOne({ workspaceId: 'ws-stale-premigration' });
    expect(stored.documentNumberingInitialized).not.toBe(true);
    expect(stored.documentNumbering.statementOfAccount.nextNumber).toBe(1);
  });
});
