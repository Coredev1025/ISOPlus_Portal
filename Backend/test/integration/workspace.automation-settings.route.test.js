import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import Business from '../../src/models/Business.js';
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
    expect(res.body.recentDocuments.map((d) => d.pdfUrl)).toEqual([
      'https://example.test/stmt-1.pdf',
      'https://example.test/inv-1.pdf',
    ]);
    expect(res.body.recentDocuments[0].type).toBe('Monthly Statement');
    expect(res.body.recentDocuments[1].invoiceNumber).toBe('INV-1004 (ISO+™)');
    expect(res.body.recentDocuments[1].periodKey).toBe('20250201-0900');
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

  it('caps recent automation documents at ten', async () => {
    for (let i = 0; i < 12; i++) {
      await automationPdfLink({
        pdfLink: `https://example.test/doc-${i}.pdf`,
        periodKey: '20250201-0900',
        createdAt: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.body.recentDocuments).toHaveLength(10);
    expect(res.body.recentDocuments[0].pdfUrl).toBe('https://example.test/doc-11.pdf');
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
    expect(res.body.recentDocuments[0].pdfUrl).toBe('https://example.test/bulk-invoice.pdf');
    expect(new Set(res.body.recentDocuments.map((d) => d.pdfUrl)).size).toBe(10);
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
