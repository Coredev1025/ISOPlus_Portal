import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { server } from '../msw/server.js';
import { createApp } from '../../src/app.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import Business from '../../src/models/Business.js';
import {
  CONNECTED,
  DISCONNECTED,
  NEEDS_REAUTH,
} from '../../src/utils/automationConnectionStatus.js';
import PDFLink from '../../src/models/PDFLink.js';
import ScheduledJob from '../../src/models/ScheduledJob.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../src/constants/automation.js';
import { authenticatedAgent } from '../helpers/auth.js';

/**
 * Lets one test make a single schedule write fail the way infrastructure does
 * — after the block before it has already been written. Everything else calls
 * through to the real implementation.
 */
const failing = vi.hoisted(() => ({ kind: null }));

vi.mock('../../src/services/scheduler/schedules.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    upsertSchedule: async (args) => {
      if (args?.kind === failing.kind) throw new Error('connect ECONNREFUSED 10.0.0.5:27017');
      return actual.upsertSchedule(args);
    },
  };
});

const WS = 'ws-automation-1';

// The workspace has no Business, so resolveTimezone falls back to
// DEFAULT_TIMEZONE. Pinning it here lets the assertions below check the
// wall-clock fields of nextRunAt rather than settling for "is truthy".
const TZ = 'Australia/Sydney';

/** Wall-clock fields of `date` in the job's timezone. */
function wallClock(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour12: false,
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  })
    .formatToParts(date)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});

  return {
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    weekday: String(parts.weekday).toLowerCase(),
  };
}

const MONTHLY_INVOICE = {
  enabled: true,
  every: { n: 1, unit: 'month' },
  runOn: 15,
  runAt: '09:00',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
};

// quarter and year are the two units that made this route return 500 on save:
// their runOn is {month, day} — the only shape validateRunOn accepts and the
// only shape the picker sends — and the schedule arithmetic read it as an
// integer, so Number({month, day}) was NaN and Intl threw RangeError: Invalid
// time value out of computeNextRun, before anything was written.
const QUARTERLY_INVOICE = {
  enabled: true,
  every: { n: 1, unit: 'quarter' },
  runOn: { month: 3, day: 20 },
  runAt: '09:00',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
};

const WEEKLY_STATEMENT = {
  enabled: true,
  every: { n: 2, unit: 'week' },
  runOn: 'friday',
  runAt: '17:30',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
};

describe('GET/PUT /api/workspaces/:workspaceId/automation-settings', () => {
  let app;
  let agent;

  beforeEach(async () => {
    failing.kind = null;
    // Automation is gated on the workspace's feature toggle, so every test
    // that saves settings needs the Business row carrying it. No
    // headOfficeTimezone, so resolveTimezone still falls back to TZ below.
    await Business.create({
      workspaceId: WS,
      name: 'Automation Test Co',
      featureToggles: { invoiceStatementAutomation: true },
    });
    app = createApp();
    ({ agent } = await authenticatedAgent(app));
  });

  /** A PDFLink row the way the automation generators record one. */
  function automationPdfLink(overrides) {
    return PDFLink.create({
      workspaceId: WS,
      itemId: 'item-1',
      type: 'NDIS Invoice',
      invoiceNumber: null,
      pdfLink: 'https://example.test/doc.pdf',
      createdBy: '',
      isDeleted: false,
      SignatureStatus: 'Unsigned',
      ...overrides,
    });
  }

  it('returns defaults when no document exists', async () => {
    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(200);
    expect(res.body.invoice.enabled).toBe(false);
    expect(res.body.invoice.nextRun).toBeNull();
  });

  it('persists a valid block', async () => {
    const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
      invoice: {
        enabled: true,
        every: { n: 1, unit: 'month' },
        runOn: 15,
        runAt: '09:00',
        sendMethod: 'isoplus',
        recipient: 'billing_contact',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.invoice.runOn).toBe(15);

    const stored = await AutomationSettings.findOne({ workspaceId: WS });
    expect(stored.invoice.enabled).toBe(true);
  });

  it('rejects a bad email with 400 and names the field', async () => {
    const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
      invoice: {
        enabled: true,
        every: { n: 1, unit: 'month' },
        runOn: 1,
        runAt: '09:00',
        sendMethod: 'isoplus',
        recipient: 'billing_contact',
        sendCopyTo: 'nope',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sendCopyTo/);
  });

  it('requires authentication', async () => {
    const res = await request(app).get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(401);
  });

  it('creates a picker ScheduledJob when a block is enabled', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });
    expect(res.status).toBe(200);

    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(job).not.toBeNull();
    expect(job.enabled).toBe(true);
    expect(job.workspaceId).toBe(WS);
    expect(job.timezone).toBe(TZ);
    // cron null is what makes this a picker schedule; the scheduler's
    // exactly-one check rejects a row carrying both.
    expect(job.cron).toBeNull();
    expect(job.schedule.every.n).toBe(1);
    expect(job.schedule.every.unit).toBe('month');
    expect(job.schedule.runOn).toBe(15);
    expect(job.schedule.runAt).toBe('09:00');
    expect(wallClock(job.nextRunAt)).toMatchObject({ day: '15', hour: '09', minute: '00' });
    expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('saves a quarterly block, whose runOn is {month, day}, and schedules it in the chosen month', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: QUARTERLY_INVOICE });

    expect(res.status).toBe(200);
    expect(res.body.invoice.runOn).toEqual({ month: 3, day: 20 });

    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(job.schedule.runOn).toEqual({ month: 3, day: 20 });

    // No startDate, so the series is anchored on today and the exact instant
    // moves with the calendar. What must hold whatever day this runs on: the
    // 20th, at 09:00, in a month sharing March's position in the quarter —
    // i.e. March, June, September or December. Ignoring runOn.month would
    // anchor on today's month instead, which for nine months of the year is
    // none of those.
    const clock = wallClock(job.nextRunAt);
    expect(clock).toMatchObject({ day: '20', hour: '09', minute: '00' });

    const month = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: '2-digit' })
      .format(job.nextRunAt);
    expect(['03', '06', '09', '12']).toContain(month);
    expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('disables the ScheduledJob rather than deleting it when the block is turned off', async () => {
    await agent.put(`/api/workspaces/${WS}/automation-settings`).send({ invoice: MONTHLY_INVOICE });
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { ...MONTHLY_INVOICE, enabled: false } });

    // Disable, not delete: lastRunAt and missedRuns have to survive a toggle.
    expect(await ScheduledJob.countDocuments({ kind: KIND_INVOICE, targetId: WS })).toBe(1);
    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(job.enabled).toBe(false);
    expect(job.schedule.every.unit).toBe('month');
  });

  it('disabling a block that was never enabled is a harmless no-op', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { enabled: false } });

    expect(res.status).toBe(200);
    expect(res.body.invoice.nextRun).toBeNull();
    expect(await ScheduledJob.countDocuments({})).toBe(0);
  });

  it('returns nextRun from the linked job on GET and on the PUT that created it', async () => {
    const putRes = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });

    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(putRes.body.invoice.nextRun).toBe(job.nextRunAt.toISOString());

    const getRes = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.invoice.nextRun).toBe(job.nextRunAt.toISOString());
    expect(getRes.body.statement.nextRun).toBeNull();
  });

  it('stops reporting nextRun once the block is disabled', async () => {
    await agent.put(`/api/workspaces/${WS}/automation-settings`).send({ invoice: MONTHLY_INVOICE });
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { ...MONTHLY_INVOICE, enabled: false } });

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.body.invoice.nextRun).toBeNull();
  });

  it('keeps reporting lastRunAt for a disabled block', async () => {
    // disableSchedule preserves the row, so the status panel can show when a
    // paused automation last ran.
    await agent.put(`/api/workspaces/${WS}/automation-settings`).send({ invoice: MONTHLY_INVOICE });
    const ranAt = new Date('2026-08-01T23:00:00.000Z');
    await ScheduledJob.updateOne(
      { kind: KIND_INVOICE, targetId: WS },
      { $set: { lastRunAt: ranAt, lastError: 'boom' } },
    );
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { ...MONTHLY_INVOICE, enabled: false } });

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.body.invoice.nextRun).toBeNull();
    expect(res.body.invoice.lastRunAt).toBe(ranAt.toISOString());
    expect(res.body.invoice.lastRunFailed).toBe(true);
  });

  it('does not return the stored lastError text to the client', async () => {
    // The expectation this replaces asserted the raw string came back. It is
    // whatever the run threw, stringified — E11000 messages naming the
    // database and index, ECONNREFUSED with internal addresses, S3 bucket
    // names. The client gets the fact; the logs keep the detail.
    await agent.put(`/api/workspaces/${WS}/automation-settings`).send({ invoice: MONTHLY_INVOICE });
    await ScheduledJob.updateOne(
      { kind: KIND_INVOICE, targetId: WS },
      {
        $set: {
          lastRunAt: new Date('2026-08-01T23:00:00.000Z'),
          lastError:
            'E11000 duplicate key error collection: business-dashboard.pdflinks index: pdfLink_1',
        },
      },
    );

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.body.invoice.lastRunFailed).toBe(true);
    expect(res.body.invoice.lastRunError).not.toMatch(/E11000|business-dashboard|pdflinks/);
  });

  it('lists recent automation documents on GET, newest first and deduped', async () => {
    await automationPdfLink({
      pdfLink: 'https://example.test/inv-1.pdf',
      invoiceNumber: 'INV-1004 (ISO+™)',
      periodKey: '20250201-0900',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // A second row for the same PDF (multi-item invoices record one row per
    // item) must not appear twice.
    await automationPdfLink({
      itemId: 'item-2',
      pdfLink: 'https://example.test/inv-1.pdf',
      invoiceNumber: 'INV-1004 (ISO+™)',
      periodKey: '20250201-0900',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await automationPdfLink({
      pdfLink: 'https://example.test/stmt-1.pdf',
      type: 'Monthly Statement',
      periodKey: '20250201-0900',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    // No periodKey — a UI-generated PDF, not the automation's; excluded.
    await automationPdfLink({ pdfLink: 'https://example.test/manual.pdf' });

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(200);
    // Links point at the re-signing route, not at the presigned URL captured
    // when the document was generated — AWS SigV4 will not sign for longer than
    // seven days, so a stored link stops working a week after its run.
    const statement = await PDFLink.findOne({ pdfLink: 'https://example.test/stmt-1.pdf' }).lean();
    const invoice = await PDFLink.findOne({ pdfLink: 'https://example.test/inv-1.pdf' }).lean();
    expect(res.body.recentDocuments.map((d) => d.pdfUrl)).toEqual([
      `/api/pdf-links/download/${statement._id}`,
      `/api/pdf-links/download/${invoice._id}`,
    ]);
    expect(res.body.recentDocuments[0].type).toBe('Monthly Statement');
    expect(res.body.recentDocuments[1].invoiceNumber).toBe('INV-1004 (ISO+™)');
    expect(res.body.recentDocuments[1].periodKey).toBe('20250201-0900');
  });

  /**
   * Epic 5 asks Recent sends to show the RECIPIENT beside the sent time and the
   * delivery state. `PDFLink.participant` is already stored and the frontend
   * type already declares it — the aggregation simply never projected it, so
   * the panel had no name to render at all.
   *
   * `participant` is the client the document was raised for, which under
   * Recipient = Billing Contact need not own the mailbox the mail went to.
   * The panel renders it "For <name>" for that reason; nothing here or in the
   * response claims it is the address.
   */
  it('carries the participant so the panel can name the client each document was raised for', async () => {
    await automationPdfLink({
      pdfLink: 'https://example.test/with-participant.pdf',
      invoiceNumber: 'INV-2001',
      participant: 'Samuel Rivers',
      periodKey: '20250301-0900',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(200);

    const row = res.body.recentDocuments.find((d) => d.invoiceNumber === 'INV-2001');
    expect(row.participant).toBe('Samuel Rivers');
  });

  it('leaves participant null when the row carries none, rather than omitting the key', async () => {
    await automationPdfLink({
      pdfLink: 'https://example.test/no-participant.pdf',
      invoiceNumber: 'INV-2002',
      periodKey: '20250301-0900',
      createdAt: new Date('2026-03-02T00:00:00.000Z'),
    });

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    const row = res.body.recentDocuments.find((d) => d.invoiceNumber === 'INV-2002');
    // Present and null, so the client can tell "nobody recorded" from "not sent
    // by a build that knows about this field".
    expect(row).toHaveProperty('participant', null);
  });

  it('carries each document\'s delivery state and, for a bounce, its plain-English reason', async () => {
    await automationPdfLink({
      pdfLink: 'https://example.test/delivered.pdf',
      periodKey: '20250201-0900',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      deliveryState: 'delivered',
      deliveryMessageId: 'msg-a@provider.test',
    });
    await automationPdfLink({
      itemId: 'item-2',
      pdfLink: 'https://example.test/bounced.pdf',
      periodKey: '20250201-0900',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      deliveryState: 'bounced',
      deliveryDetail: "Email address doesn't exist.",
    });
    // No email has gone out for this one yet — legitimately still "generated",
    // and the panel must not read that as a failure.
    await automationPdfLink({
      itemId: 'item-3',
      pdfLink: 'https://example.test/fresh.pdf',
      periodKey: '20250201-0900',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(200);
    expect(
      res.body.recentDocuments.map((d) => [d.deliveryState, d.deliveryDetail])
    ).toEqual([
      ['delivered', null],
      ['bounced', "Email address doesn't exist."],
      ['generated', null],
    ]);
    // The message id is internal plumbing, not something a client page needs.
    expect(res.body.recentDocuments[0]).not.toHaveProperty('deliveryMessageId');
  });

  // Fifty, not ten: the panel collapses to five rows and expands, so ten was
  // the whole history a client could ever reach — one run on a board with a
  // handful of participants. See RECENT_DOCUMENTS_LIMIT.
  it('caps recent automation documents at fifty', async () => {
    // One insert, not fifty-two round trips: awaiting each in turn held the
    // request open long enough to hang the socket on a slow machine.
    await Promise.all(Array.from({ length: 52 }, (_, i) => automationPdfLink({
      pdfLink: `https://example.test/doc-${i}.pdf`,
      periodKey: '20250201-0900',
      createdAt: new Date(Date.UTC(2026, 0, i + 1)),
    })));

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.body.recentDocuments).toHaveLength(50);
    const newest = await PDFLink.findOne({ pdfLink: 'https://example.test/doc-51.pdf' }).lean();
    expect(res.body.recentDocuments[0].pdfUrl).toBe(`/api/pdf-links/download/${newest._id}`);
  });

  it('still returns ten documents when one run wrote fifty rows for a single PDF', async () => {
    // A 50-item invoice writes 50 PDFLink rows sharing one pdfLink. The old
    // newest-50 → dedupe → cap-10 pipeline read exactly those 50 rows, deduped
    // them to one, and reported a single document while nine older ones sat
    // just outside the window.
    for (let i = 0; i < 50; i++) {
      await automationPdfLink({
        itemId: `bulk-item-${i}`,
        pdfLink: 'https://example.test/bulk-invoice.pdf',
        periodKey: '20260301-0900',
        createdAt: new Date(Date.UTC(2026, 2, 1)),
      });
    }
    for (let i = 0; i < 9; i++) {
      await automationPdfLink({
        pdfLink: `https://example.test/older-${i}.pdf`,
        periodKey: '20260201-0900',
        createdAt: new Date(Date.UTC(2026, 1, i + 1)),
      });
    }

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.body.recentDocuments).toHaveLength(10);
    // Still one entry per DOCUMENT, not per row: the 50 rows sharing one
    // pdfLink collapse to a single link, and it resolves to one of them.
    expect(new Set(res.body.recentDocuments.map((d) => d.pdfUrl)).size).toBe(10);
    const bulkRowIds = (await PDFLink.find({ pdfLink: 'https://example.test/bulk-invoice.pdf' }).lean())
      .map((row) => `/api/pdf-links/download/${row._id}`);
    expect(bulkRowIds).toContain(res.body.recentDocuments[0].pdfUrl);
  });

  // The link has to survive the seven-day signature expiry that motivated it:
  // following it re-signs from the stored key rather than replaying a stale
  // signature. Proved end to end here, through the same session the panel uses.
  it('hands back a link that still resolves after the stored signature has expired', async () => {
    const savedOffline = process.env.ISOPLUS_OFFLINE;
    process.env.ISOPLUS_OFFLINE = '1';
    try {
      await automationPdfLink({
        pdfLink: 'https://iso-bucket.s3.ap-southeast-2.amazonaws.com/output/ws/INV-9.pdf?X-Amz-Signature=stale',
        periodKey: '20250201-0900',
      });

      const listed = await agent.get(`/api/workspaces/${WS}/automation-settings`);
      const followed = await agent.get(listed.body.recentDocuments[0].pdfUrl);

      expect(followed.status).toBe(302);
      expect(followed.headers.location).toContain('output/ws/INV-9.pdf');
      expect(followed.headers.location).not.toContain('X-Amz-Signature=stale');
    } finally {
      if (savedOffline === undefined) delete process.env.ISOPLUS_OFFLINE;
      else process.env.ISOPLUS_OFFLINE = savedOffline;
    }
  });

  it('returns 400 and leaves the settings unwritten when the schedule write fails', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { ...MONTHLY_INVOICE, startDate: 'not-a-date' } });

    expect(res.status).toBe(400);
    // Schedules are written first precisely so this holds: a failed schedule
    // write must not leave the UI claiming "enabled" for something that
    // cannot fire.
    expect(await AutomationSettings.countDocuments({})).toBe(0);
    expect(await ScheduledJob.countDocuments({})).toBe(0);
  });

  describe('the invoiceStatementAutomation feature flag', () => {
    it('refuses to save settings for a workspace the flag is off for', async () => {
      // Without this the flag gated nothing: any admitted session could PUT
      // settings for a workspace not on the feature and create an ENABLED
      // ScheduledJob that the next tick runs the full billing pipeline for.
      await Business.updateOne(
        { workspaceId: WS },
        { $set: { 'featureToggles.invoiceStatementAutomation': false } },
      );

      const res = await agent
        .put(`/api/workspaces/${WS}/automation-settings`)
        .send({ invoice: MONTHLY_INVOICE });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/automation/i);
      expect(await ScheduledJob.countDocuments({})).toBe(0);
      expect(await AutomationSettings.countDocuments({})).toBe(0);
    });

    it('refuses to save settings for a workspace with no business profile', async () => {
      await Business.deleteMany({});

      const res = await agent
        .put(`/api/workspaces/${WS}/automation-settings`)
        .send({ invoice: MONTHLY_INVOICE });

      expect(res.status).toBe(403);
      expect(await ScheduledJob.countDocuments({})).toBe(0);
    });

    it('still serves GET when the flag is off, so the UI can explain itself', async () => {
      await Business.updateOne(
        { workspaceId: WS },
        { $set: { 'featureToggles.invoiceStatementAutomation': false } },
      );

      const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
      expect(res.status).toBe(200);
      expect(res.body.invoice.enabled).toBe(false);
    });

    it('disables both automation schedules when the toggle is turned off', async () => {
      // The flag was not a kill switch: disableSchedule was only ever called
      // from the settings PUT, so an existing row kept enabled: true and kept
      // billing after the feature was withdrawn.
      await agent
        .put(`/api/workspaces/${WS}/automation-settings`)
        .send({ invoice: MONTHLY_INVOICE, statement: WEEKLY_STATEMENT });

      const off = await agent
        .put(`/api/workspaces/${WS}/feature-toggles`)
        .send({ invoiceStatementAutomation: false });
      expect(off.status).toBe(200);

      const jobs = await ScheduledJob.find({ targetId: WS });
      expect(jobs).toHaveLength(2);
      expect(jobs.every((job) => job.enabled === false)).toBe(true);
      // Disabled, not deleted: the history survives so turning the feature
      // back on shows when each block last ran.
      expect(jobs.every((job) => job.schedule?.every?.unit)).toBe(true);
    });

    it('leaves the schedules alone when the toggle is turned on', async () => {
      await agent
        .put(`/api/workspaces/${WS}/automation-settings`)
        .send({ invoice: MONTHLY_INVOICE });

      const on = await agent
        .put(`/api/workspaces/${WS}/feature-toggles`)
        .send({ invoiceStatementAutomation: true });
      expect(on.status).toBe(200);

      const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
      expect(job.enabled).toBe(true);
    });
  });

  it('writes no schedule at all when only the second block is invalid', async () => {
    // The partial-write this exists for: writeAutomationSchedules awaited
    // invoice then statement, so an invalid statement left a live invoice
    // schedule on the new cadence, AutomationSettings holding the old values,
    // and the client told 400 — "looks fine while automation runs", inverted.
    const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
      invoice: MONTHLY_INVOICE,
      statement: { ...WEEKLY_STATEMENT, startDate: 'not-a-date' },
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/startDate/);
    expect(await ScheduledJob.countDocuments({})).toBe(0);
    expect(await AutomationSettings.countDocuments({})).toBe(0);
  });

  it('reports a mid-sequence infrastructure failure as a 500 and writes no settings', async () => {
    // Body-driven partial writes are gone (both blocks are validated before
    // either is written). What remains is the database failing between the two
    // upserts, which is a 500, not the client's fault. The residual state is
    // real and deliberately not "fixed" by a compensating write: that write
    // needs the same connection that just failed. The invoice schedule is left
    // on the cadence the client asked for, and the settings document is not
    // written, so a retry converges.
    failing.kind = KIND_STATEMENT;

    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE, statement: WEEKLY_STATEMENT });

    expect(res.status).toBe(500);
    expect(res.body.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
    expect(await AutomationSettings.countDocuments({})).toBe(0);
    expect(await ScheduledJob.countDocuments({ kind: KIND_STATEMENT, targetId: WS })).toBe(0);
  });

  it('treats PUT as a full replace: an omitted block is reset and its schedule disabled', async () => {
    // Documented rather than changed: the only client PUTs the whole settings
    // object it just fetched (Frontend/lib/automation-settings.ts), and this
    // is what the route already did. An API caller sending one block must know
    // it turns the other one off.
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE, statement: WEEKLY_STATEMENT });

    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });

    expect(res.status).toBe(200);
    expect(res.body.statement.enabled).toBe(false);
    expect(res.body.statement.nextRun).toBeNull();

    const statementJob = await ScheduledJob.findOne({ kind: KIND_STATEMENT, targetId: WS });
    expect(statementJob.enabled).toBe(false);

    const stored = await AutomationSettings.findOne({ workspaceId: WS });
    expect(stored.statement.enabled).toBe(false);
    expect(stored.statement.runAt).toBe('09:00');
  });

  /**
   * 6.6 asks for queue depth and Accounting Integrations connection status to
   * reach BOTH the admin screens and the client panel. They reached only the
   * admin screens: `readQueueDepth` and `xeroConnectionStatus` had one consumer
   * each, inside the System Health router, which 403s an `isoplus_user`.
   *
   * The queue figure is deliberately NOT the raw count. Queue depth is global,
   * so handing a tenant "217 waiting" leaks how much work other clients are
   * generating. The client needs only the actionable half — is my run stuck
   * behind a backlog — which a boolean carries without the disclosure.
   */
  describe('automation health for the client panel', () => {
    it('reports a queue backlog as a boolean, never as a cross-tenant count', async () => {
      const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);

      expect(res.status).toBe(200);
      expect(res.body.health).toBeDefined();
      expect(typeof res.body.health.queueBacklogged).toBe('boolean');
      expect(res.body.health.queueTotal).toBeUndefined();
      expect(res.body.health.waiting).toBeUndefined();
    });

    it("carries this workspace's own accounting connection status", async () => {
      // The client is the only party who can re-authorise Xero, so
      // needs_reauth has to be visible to them, not only to support.
      const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);

      expect([CONNECTED, DISCONNECTED, NEEDS_REAUTH]).toContain(
        res.body.health.accounting,
      );
    });

    it('still answers when the queue cannot be reached', async () => {
      // Redis down must degrade the panel, not break the settings load.
      const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);

      expect(res.status).toBe(200);
      expect(res.body.health).toHaveProperty('queueBacklogged');
    });
  });

  it('enables both blocks independently', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE, statement: WEEKLY_STATEMENT });
    expect(res.status).toBe(200);

    const invoiceJob = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    const statementJob = await ScheduledJob.findOne({ kind: KIND_STATEMENT, targetId: WS });

    expect(invoiceJob.enabled).toBe(true);
    expect(statementJob.enabled).toBe(true);
    expect(statementJob.schedule.every.n).toBe(2);
    expect(statementJob.schedule.every.unit).toBe('week');
    expect(statementJob.schedule.runOn).toBe('friday');
    expect(wallClock(statementJob.nextRunAt)).toMatchObject({
      hour: '17',
      minute: '30',
      weekday: 'friday',
    });
    expect(res.body.invoice.nextRun).toBe(invoiceJob.nextRunAt.toISOString());
    expect(res.body.statement.nextRun).toBe(statementJob.nextRunAt.toISOString());
  });

  it('turning one block off leaves the other running', async () => {
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE, statement: WEEKLY_STATEMENT });
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE, statement: { ...WEEKLY_STATEMENT, enabled: false } });

    const invoiceJob = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    const statementJob = await ScheduledJob.findOne({ kind: KIND_STATEMENT, targetId: WS });
    expect(invoiceJob.enabled).toBe(true);
    expect(statementJob.enabled).toBe(false);

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.body.invoice.nextRun).toBe(invoiceJob.nextRunAt.toISOString());
    expect(res.body.statement.nextRun).toBeNull();
  });
});

/**
 * Tenancy. These two routes read and write a workspace's billing configuration
 * and hand back presigned S3 URLs to its generated invoices, and they were
 * gated on authenticateToken alone. For an isoplus_user that middleware calls
 * authorizeIsoplusUser, which checks only that an ISO+ session EXISTS — never
 * that it belongs to the workspace in the URL. So any logged-in ISO+ user could
 * read or rewrite any other client's schedules, email addresses and invoice
 * links by changing the id in the path.
 *
 * The board listing route did not have this hole because it proxies the call to
 * ISO+ with the caller's own token and lets ISO+ refuse. These routes read
 * Mongo directly, so they have to ask the same question themselves.
 */
describe('automation-settings tenancy', () => {
  const OTHER_WS = 'ws-automation-other';
  const V2 = 'https://app.isoplus.online/api/v2';
  let app;

  /**
   * A session shaped like a real ISO+ login: role isoplus_user AND
   * session.Authorization set, which is the combination authorizeIsoplusUser
   * lets through. A password login cannot produce it — applyPrivilegedSessionAuth
   * only sets Authorization for owner/support_admin — so the hole is only
   * reachable from the OAuth path, and only this route builds that session.
   */
  async function isoplusUserAgent(email) {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/auth/oauth-login')
      .set('Authorization', 'Bearer isoplus-user-token')
      .send({ oauthData: { id: `oauth-${email}`, email, name: 'ISO+ User' } });
    expect(res.status).toBe(200);
    return agent;
  }

  /** ISO+ answering "who are the members of this workspace". */
  function membersOf(byWorkspace) {
    server.use(http.get(`${V2}/workspaces/:workspaceId/members`, ({ params }) => HttpResponse.json({
      data: byWorkspace[params.workspaceId] ?? [],
      has_more: false,
      after: null,
    })));
  }

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
    // Offline mode skips the membership call by design (one local user, no ISO+
    // to ask), so it has to be off for these tests to mean anything.
    process.env.ISOPLUS_OFFLINE = '0';
    await AutomationSettings.deleteMany({});
    await Business.deleteMany({});
    await Business.create({
      workspaceId: WS, name: 'Mine', featureToggles: { invoiceStatementAutomation: true },
    });
    await Business.create({
      workspaceId: OTHER_WS, name: 'Somebody else', featureToggles: { invoiceStatementAutomation: true },
    });
    app = createApp();
  });

  it('refuses to read another workspace\'s automation settings', async () => {
    membersOf({ [WS]: [{ email: 'member@client.test', role: 'admin' }] });
    const agent = await isoplusUserAgent('member@client.test');

    const mine = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(mine.status).toBe(200);

    const theirs = await agent.get(`/api/workspaces/${OTHER_WS}/automation-settings`);
    expect(theirs.status).toBe(403);
    // Nothing about the other workspace leaks in the refusal — not its
    // schedules, and not the presigned pdfUrls of its invoices.
    expect(theirs.body.recentDocuments).toBeUndefined();
  });

  it('refuses to write another workspace\'s automation settings', async () => {
    membersOf({ [WS]: [{ email: 'member@client.test', role: 'admin' }] });
    const agent = await isoplusUserAgent('member@client.test');

    const res = await agent
      .put(`/api/workspaces/${OTHER_WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });

    expect(res.status).toBe(403);
    expect(await AutomationSettings.countDocuments({ workspaceId: OTHER_WS })).toBe(0);
    expect(await ScheduledJob.countDocuments({ targetId: OTHER_WS })).toBe(0);
  });

  it('lets a member of the workspace through', async () => {
    membersOf({ [OTHER_WS]: [{ email: 'member@client.test', role: 'member' }] });
    const agent = await isoplusUserAgent('member@client.test');

    const res = await agent
      .put(`/api/workspaces/${OTHER_WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });

    expect(res.status).toBe(200);
  });

  // Portal staff are not ISO+ members of every client workspace, and support
  // has always been able to open any of them — applyPrivilegedSessionAuth hands
  // them the personal access token for exactly that reason. Closing the hole
  // must not close that door, so the check applies to isoplus_user only.
  it('leaves support_admin able to reach any workspace', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const res = await agent.get(`/api/workspaces/${OTHER_WS}/automation-settings`);

    expect(res.status).toBe(200);
  });

  // A membership lookup that could not be completed is not a permission
  // decision. Saying 403 there sends the client to their account manager over
  // an ISO+ outage; the honest answer names it as an upstream failure.
  it('reports an unreachable ISO+ as an upstream failure, not a refusal', async () => {
    server.use(http.get(`${V2}/workspaces/:workspaceId/members`, () => HttpResponse.json(
      { message: 'upstream exploded' }, { status: 500 },
    )));
    const agent = await isoplusUserAgent('member@client.test');

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);

    expect(res.status).toBe(502);
  });
});
