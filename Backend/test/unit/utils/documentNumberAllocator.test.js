import { describe, it, expect, beforeEach } from 'vitest';

import Business from '../../../src/models/Business.js';
import {
  claimDocumentNumber,
  documentNumberingDefault,
} from '../../../src/utils/documentNumberAllocator.js';

const WS = 'ws-numbering';

async function seed(documentNumbering) {
  await Business.create({ workspaceId: WS, name: 'Numbering Co', documentNumbering });
}

describe('claimDocumentNumber', () => {
  beforeEach(async () => {
    await Business.deleteMany({ workspaceId: WS });
  });

  it('returns the number it claimed and leaves the counter one ahead', async () => {
    await seed({ invoice: { prefix: 'IN-', nextNumber: 900 } });

    expect(await claimDocumentNumber(WS, 'invoice')).toBe('IN-900');

    const after = await Business.findOne({ workspaceId: WS }).lean();
    expect(after.documentNumbering.invoice.nextNumber).toBe(901);
  });

  it('never hands the same number to two claims', async () => {
    await seed({ invoice: { prefix: 'IN-', nextNumber: 900 } });

    const claimed = await Promise.all([
      claimDocumentNumber(WS, 'invoice'),
      claimDocumentNumber(WS, 'invoice'),
      claimDocumentNumber(WS, 'invoice'),
    ]);

    // The whole point: three concurrent claims, three distinct numbers. A read,
    // render, then write-back would hand all three the same one.
    expect(new Set(claimed).size).toBe(3);
    expect([...claimed].sort()).toEqual(['IN-900', 'IN-901', 'IN-902']);
  });

  it('leaves other document types alone', async () => {
    await seed({
      invoice: { prefix: 'IN-', nextNumber: 900 },
      quote: { prefix: 'QT-', nextNumber: 5 },
    });

    await claimDocumentNumber(WS, 'invoice');

    const after = await Business.findOne({ workspaceId: WS }).lean();
    expect(after.documentNumbering.quote.nextNumber).toBe(5);
  });

  // A schema default does not backfill stored documents, so a Business saved
  // before a counter existed has no value at that path. A bare $inc would
  // create it at 1 and mint 'STM-0' — a real invoice number that is off by the
  // whole starting range.
  it('starts a missing counter at the schema default rather than at zero', async () => {
    await Business.collection.insertOne({ workspaceId: WS, name: 'Legacy Co' });

    const claimed = await claimDocumentNumber(WS, 'statement');

    const start = documentNumberingDefault('statement', 'nextNumber');
    expect(claimed).toBe(`${documentNumberingDefault('statement', 'prefix')}${start}`);

    const after = await Business.findOne({ workspaceId: WS }).lean();
    expect(after.documentNumbering.statement.nextNumber).toBe(start + 1);
  });

  it('falls back to the schema prefix when the stored one is absent', async () => {
    await Business.collection.insertOne({
      workspaceId: WS,
      name: 'Prefixless Co',
      documentNumbering: { invoice: { nextNumber: 42 } },
    });

    expect(await claimDocumentNumber(WS, 'invoice'))
      .toBe(`${documentNumberingDefault('invoice', 'prefix')}42`);
  });

  // The caller decides what a missing Business means: an invoice cannot be
  // numbered, a statement number is optional. Returning null rather than
  // throwing is what lets both be right.
  it('returns null for a workspace with no business profile', async () => {
    expect(await claimDocumentNumber('ws-nobody', 'invoice')).toBeNull();
  });
});
