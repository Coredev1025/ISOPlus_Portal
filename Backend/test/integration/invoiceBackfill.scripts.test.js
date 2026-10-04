import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';

import Board from '../../src/models/Board.js';
import Invoice from '../../src/models/Invoice.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';
import Item from '../../src/models/Item.js';
import { up as buildInvoiceIndexes } from '../../migrations/1791102300000-invoice-ledger-indexes.js';

/**
 * KAN-311: the two scripts, run as real child processes against the in-memory database the
 * test setup starts (its URI is local, so the script's guard lets it through). What they
 * must do: be safe by default, refuse a remote database, print the report, exit non-zero when
 * something needs a person.
 */

const execFileAsync = promisify(execFile);
const WS = 'ws-script';

const script = (name, args, env = {}) => execFileAsync('node', [`scripts/${name}`, ...args], {
  cwd: new URL('../..', import.meta.url).pathname,
  env: { ...process.env, ...env },
}).then((r) => ({ code: 0, ...r })).catch((e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

beforeEach(async () => {
  await Promise.all([Board, Invoice, InvoiceNumber, Item].map((m) => m.deleteMany({})));
  await Board.create({ boardId: 'b1', workspaceId: WS, name: 'NDIS', label: 'Care Management NDIS 2026 Pricing' });
  await Item.insertMany(['a', 'b'].map((itemId) => ({
    workspaceId: WS, boardId: 'b1', folderId: 'f', itemId, data: { 'Participant Full Name': 'Jane Smith' },
  })));
  await InvoiceNumber.insertMany(['a', 'b'].map((itemId) => ({
    workspaceId: WS, boardId: 'b1', itemId, invoiceNumber: 'INV-24 (ISO+™)', type: 'PDF', pdfLink: 'https://s3/24.pdf',
  })));
  await buildInvoiceIndexes(mongoose.connection);
});

describe('invoice-backfill.mjs', () => {
  it('refuses to run without naming workspaces', async () => {
    const result = await script('invoice-backfill.mjs', []);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--workspace/);
  });

  it('refuses a database that is not local, before connecting', async () => {
    const result = await script('invoice-backfill.mjs', ['--all'], { MONGODB_URI: 'mongodb://user:secret@prod.example.com:27017/db' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/does not look local/);
    expect(result.stderr).not.toMatch(/secret/);
  });

  it('is a dry run by default: prints the report and writes nothing', async () => {
    const result = await script('invoice-backfill.mjs', ['--workspace', WS]);
    // The total derivation needs the real NDIS references, which this workspace lacks, so the
    // invoice is reported as unplaceable rather than guessed; the point here is the shape.
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/DRY RUN: nothing was written/);
    expect(result.stdout).toMatch(/unplaceable/);
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('refuses --apply without the plan hash the dry run printed', async () => {
    const result = await script('invoice-backfill.mjs', ['--workspace', WS, '--apply']);
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/--plan/);
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('prints a plan hash, and refuses --apply with that hash until each category is acknowledged', async () => {
    const dry = await script('invoice-backfill.mjs', ['--workspace', WS]);
    const hash = /Plan hash: ([0-9a-f]{12})/.exec(dry.stdout)?.[1];
    expect(hash).toBeTruthy();

    const result = await script('invoice-backfill.mjs', ['--workspace', WS, '--apply', '--plan', hash]);
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/--ack/);
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('writes the report file readable by its owner only', async () => {
    const { mkdtempSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = `${mkdtempSync(`${tmpdir()}/bf-`)}/report.json`;
    await script('invoice-backfill.mjs', ['--workspace', WS, '--report-file', path]);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
  });

  it('previews an undo and changes nothing', async () => {
    const result = await script('invoice-backfill.mjs', ['--workspace', WS, '--undo']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/UNDO PREVIEW: nothing was changed/);
  });
});

describe('invoice-audit.mjs', () => {
  it('reads its arguments strictly', async () => {
    expect((await script('invoice-audit.mjs', ['--workspace', '--all'])).code).toBe(2);
    expect((await script('invoice-audit.mjs', ['--all', '--frobnicate'])).code).toBe(2);
  });

  it('needs workspaces named, and reports a clean workspace', async () => {
    expect((await script('invoice-audit.mjs', [])).code).toBe(2);
    const clean = await script('invoice-audit.mjs', ['--workspace', WS]);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toMatch(/No violations/);
  });

  it('exits 1 and names the violation when a marker has no invoice', async () => {
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'INV-3' } });
    const result = await script('invoice-audit.mjs', ['--workspace', WS]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/markerWithoutInvoice 1/);
  });
});
