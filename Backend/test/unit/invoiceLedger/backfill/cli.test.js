import { describe, it, expect } from 'vitest';

import { parseBackfillArgs, formatBackfillResult } from '../../../../src/utils/invoiceLedger/backfill/cli.js';

/**
 * The backfill script's pure parts (KAN-311): reading its arguments and printing its result.
 * Safe by default: a dry run, and nothing runs without naming workspaces or --all.
 */

describe('parseBackfillArgs', () => {
  it('is a dry run by default and needs the workspaces named, or --all', () => {
    expect(() => parseBackfillArgs([])).toThrow(/--workspace/);
    expect(parseBackfillArgs(['--workspace', 'w1'])).toMatchObject({ workspaceIds: ['w1'], apply: false, undo: false, acks: {} });
    expect(parseBackfillArgs(['--all'])).toMatchObject({ workspaceIds: undefined, apply: false });
  });

  it('takes several workspaces and several acknowledgements', () => {
    const options = parseBackfillArgs(['--workspace', 'w1', '--workspace', 'w2', '--apply', '--ack', 'double-billed=3', '--ack', 'stale-legacy=1']);
    expect(options).toMatchObject({ workspaceIds: ['w1', 'w2'], apply: true, acks: { doubleBilled: 3, staleLegacy: 1 } });
  });

  it('reads --undo, --json, --report-file and --allow-remote', () => {
    expect(parseBackfillArgs(['--all', '--undo'])).toMatchObject({ undo: true });
    expect(parseBackfillArgs(['--all', '--json', '--report-file', '/tmp/r.json', '--allow-remote'])).toMatchObject({
      json: true, reportFile: '/tmp/r.json', allowRemote: true,
    });
  });

  it('reads --plan, and --undo with --apply (undo previews without it)', () => {
    expect(parseBackfillArgs(['--all', '--apply', '--plan', 'abc123def456'])).toMatchObject({ apply: true, planHash: 'abc123def456' });
    expect(parseBackfillArgs(['--all', '--undo'])).toMatchObject({ undo: true, apply: false });
    expect(parseBackfillArgs(['--all', '--undo', '--apply'])).toMatchObject({ undo: true, apply: true });
  });

  it('refuses options it does not know and flags with no value', () => {
    expect(() => parseBackfillArgs(['--all', '--frobnicate'])).toThrow(/Unknown option/);
    expect(() => parseBackfillArgs(['--workspace'])).toThrow(/--workspace needs/);
  });
});

describe('formatBackfillResult', () => {
  const planned = [{ workspaceId: 'w1', plan: { report: { counts: { itemsLinked: 4, alreadyRecorded: 0, revisitedLogRows: 2 } } } }];
  const totals = {
    created: { 'log-only': 2, 'marker-only': 1 },
    found: { staleLegacy: 1, doubleBilled: 2 },
    lists: { staleLegacy: [{ itemId: 'a', number: 'INV-22' }], doubleBilled: [{ itemId: 'b' }, { itemId: 'c' }] },
  };

  it('prints the plan hash to pass back with --apply', () => {
    const text = formatBackfillResult({ applied: false, totals, planned, planHash: 'abc123def456' }).join('\n');
    expect(text).toMatch(/Plan hash: abc123def456/);
    expect(text).toMatch(/--apply --plan <hash>/);
  });

  it('says it was a dry run, what it would create, the categories with the flag to acknowledge each, and examples', () => {
    const text = formatBackfillResult({ applied: false, totals, planned }).join('\n');

    expect(text).toMatch(/DRY RUN/);
    expect(text).toMatch(/log-only\s+2/);
    expect(text).toMatch(/marker-only\s+1/);
    expect(text).toMatch(/doubleBilled\s+2\s+--ack double-billed=2/);
    expect(text).toMatch(/staleLegacy\s+1\s+--ack stale-legacy=1/);
    expect(text).toMatch(/INV-22/);
    expect(text).toMatch(/--apply/);
  });

  it('says what an applied run wrote', () => {
    const text = formatBackfillResult({
      applied: true, totals, planned, results: [{ workspaceId: 'w1', created: 3, stamped: 1, pointed: 4, xeroAttached: 0 }],
    }).join('\n');
    expect(text).toMatch(/APPLIED/);
    expect(text).toMatch(/w1\s+created 3, stamped 1, pointed 4, xero attached 0/);
  });

  it('says what an undo removed', () => {
    const text = formatBackfillResult({ applied: false, undone: { invoices: 3, stamped: 1, pointed: 4, skipped: [], preview: false } }).join('\n');
    expect(text).toMatch(/UNDO/);
    expect(text).toMatch(/removed 3 invoices/);
  });

  it('says an undo preview changed nothing, and lists what live code has changed since', () => {
    const text = formatBackfillResult({
      applied: false, undone: { invoices: 2, stamped: 1, pointed: 3, skipped: [{ number: 'INV-5', workspaceId: 'w1', reason: 'changed-since-created' }], preview: true },
    }).join('\n');
    expect(text).toMatch(/UNDO PREVIEW: nothing was changed/);
    expect(text).toMatch(/would remove 2 invoices/);
    expect(text).toMatch(/INV-5 \(w1\)/);
    expect(text).toMatch(/--undo --apply/);
  });

  it('limits the examples shown per category', () => {
    const many = { ...totals, found: { doubleBilled: 30 }, lists: { doubleBilled: Array.from({ length: 30 }, (_, i) => ({ itemId: `i${i}` })) } };
    const text = formatBackfillResult({ applied: false, totals: many, planned }).join('\n');
    expect(text).toMatch(/and 20 more/);
  });
});
