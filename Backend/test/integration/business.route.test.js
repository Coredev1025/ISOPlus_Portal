import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import Business from '../../src/models/Business.js';
import ScheduledJob from '../../src/models/ScheduledJob.js';
import { upsertSchedule, disableSchedule } from '../../src/services/scheduler/schedules.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { claimDocumentNumber } from '../../src/utils/documentNumberAllocator.js';
import AuditTrail from '../../src/models/AuditTrail.js';
import * as logger from '../../src/utils/logger.js';

const app = createApp();

describe('Business routes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
  });
  afterEach(() => {});

  it('requires authentication for profile', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).get('/api/business/profile').query({ workspaceId: 'ws' });
    expect(res.status).toBe(401);
  });

  it('returns 404 when profile is missing', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/business/profile').query({ workspaceId: 'missing' });
    expect(res.status).toBe(404);
  });

  it('returns profile when business exists', async () => {
    await Business.create({ workspaceId: 'ws-biz', name: 'Biz Co' });
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/business/profile').query({ workspaceId: 'ws-biz' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Biz Co');
  });

  it('omits leftover xeroConnectionLogs from the profile response', async () => {
    await Business.collection.insertOne({
      workspaceId: 'ws-logs',
      name: 'Biz Co',
      xeroConnectionLogs: [{ message: 'Connected', outcome: 'success' }],
    });
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/business/profile').query({ workspaceId: 'ws-logs' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Biz Co');
    expect(res.body.xeroConnectionLogs).toBeUndefined();
  });

  it('preserves statementOfAccount when a PUT omits it from documentNumbering', async () => {
    await Business.create({
      workspaceId: 'ws-soa',
      name: 'SOA Co',
      phone: '+61 2 5550 1111',
      address: { street: '1 Main', suburb: 'Sydney', state: 'NSW', postcode: '2000' },
      bankDetails: {
        accountName: 'SOA Co',
        bankName: 'CBA',
        bsb: '062000',
        accountNumber: '12345678',
      },
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 10 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 20 },
        quote: { prefix: 'QT-', nextNumber: 30 },
        statement: { prefix: 'STM-', nextNumber: 40 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 27 },
      },
    });
    const { agent } = await authenticatedAgent(app);
    const res = await agent
      .put('/api/business/profile')
      .field('name', 'SOA Co')
      .field('workspaceId', 'ws-soa')
      .field(
        'documentNumbering',
        JSON.stringify({
          invoice: { prefix: 'INV-', nextNumber: 11 },
          purchaseOrder: { prefix: 'PO-', nextNumber: 20 },
          quote: { prefix: 'QT-', nextNumber: 30 },
          statement: { prefix: 'STM-', nextNumber: 40 },
        })
      );

    expect(res.status).toBe(200);
    // KAN-290: the next number is read-only through the form, so the 11 the page
    // sent is ignored and the live counter (10) stays.
    expect(res.body.documentNumbering.invoice.nextNumber).toBe(10);
    expect(res.body.documentNumbering.statementOfAccount).toEqual({
      prefix: 'SOA-',
      nextNumber: 27,
    });
    // Numbering-only PUTs must not wipe the rest of the stored profile.
    expect(res.body.phone).toBe('+61 2 5550 1111');
    expect(res.body.bankDetails).toMatchObject({
      accountName: 'SOA Co',
      bankName: 'CBA',
      bsb: '062000',
      accountNumber: '12345678',
    });
    expect(res.body.address).toMatchObject({
      street: '1 Main',
      suburb: 'Sydney',
      state: 'NSW',
      postcode: '2000',
    });

    const stored = await Business.findOne({ workspaceId: 'ws-soa' }).lean();
    expect(stored.documentNumbering.statementOfAccount.nextNumber).toBe(27);
    expect(stored.bankDetails.bsb).toBe('062000');
  });

  // KAN-290. The numbering sequence is read-only through the profile form: a
  // save may change a prefix but never a counter. Before, the route read the
  // business, merged the stored numbering with what the page sent, and wrote the
  // WHOLE numbering object back, so a number claimed between the read and the
  // write was overwritten with the old value and later invoices reused issued
  // numbers.
  it('does not wind back a counter that moves between reading the profile and saving it', async () => {
    await Business.create({
      workspaceId: 'ws-counter-race',
      name: 'Race Co',
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 41 },
        quote: { prefix: 'QT-', nextNumber: 30 },
      },
    });
    const original = Business.findOne.bind(Business);
    const spy = vi.spyOn(Business, 'findOne').mockImplementation(async (...args) => {
      const doc = await original(...args);
      // Invoices are issued after the route has read the profile (the logo
      // handling between the read and the write makes this window real).
      if (doc?.workspaceId === 'ws-counter-race') {
        await Business.updateOne(
          { _id: doc._id },
          { $set: { 'documentNumbering.invoice.nextNumber': 46 } },
        );
      }
      return doc;
    });

    try {
      const { agent } = await authenticatedAgent(app);
      const res = await agent
        .put('/api/business/profile')
        .field('name', 'Race Co')
        .field('workspaceId', 'ws-counter-race')
        .field('documentNumbering', JSON.stringify({
          invoice: { prefix: 'INV-', nextNumber: 41 },
          quote: { prefix: 'QUO-', nextNumber: 31 },
        }));
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    const stored = await Business.findOne({ workspaceId: 'ws-counter-race' }).lean();
    // The invoice counter kept the value the live system gave it.
    expect(stored.documentNumbering.invoice.nextNumber).toBe(46);
    // A prefix can still change; the quote counter was not taken from the page.
    expect(stored.documentNumbering.quote).toMatchObject({ prefix: 'QUO-', nextNumber: 30 });
  });

  it('ignores a next number sent for an existing business, for every series', async () => {
    await Business.create({
      workspaceId: 'ws-counter-readonly',
      name: 'Readonly Co',
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 46 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 20 },
        quote: { prefix: 'QT-', nextNumber: 30 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 27 },
      },
    });
    const { agent } = await authenticatedAgent(app);
    const res = await agent
      .put('/api/business/profile')
      .field('name', 'Readonly Co')
      .field('workspaceId', 'ws-counter-readonly')
      .field('documentNumbering', JSON.stringify({
        invoice: { prefix: 'INV-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
        quote: { prefix: 'QT-', nextNumber: 1 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 1000 },
      }));

    expect(res.status).toBe(200);
    expect(res.body.documentNumbering.invoice.nextNumber).toBe(46);
    expect(res.body.documentNumbering.purchaseOrder.nextNumber).toBe(20);
    expect(res.body.documentNumbering.quote.nextNumber).toBe(30);
    expect(res.body.documentNumbering.statementOfAccount.nextNumber).toBe(27);
  });

  // KAN-290 / KAN-292. A new workspace starts every counter at 1, automatically.
  // The numbering sequence is read-only, so a starting number cannot be chosen
  // through the profile save either: prefixes are taken, counters are not.
  it('starts every counter at 1 for a brand-new workspace, whatever the request sends', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent
      .put('/api/business/profile')
      .field('name', 'Brand New Co')
      .field('workspaceId', 'ws-counter-new')
      .field('documentNumbering', JSON.stringify({
        invoice: { prefix: 'TAX-', nextNumber: 1000 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 500 },
        quote: { prefix: 'QT-', nextNumber: 42 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 77 },
      }));

    expect(res.status).toBe(200);
    const stored = await Business.findOne({ workspaceId: 'ws-counter-new' }).lean();
    expect(stored.documentNumbering.invoice).toEqual({ prefix: 'TAX-', nextNumber: 1 });
    expect(stored.documentNumbering.purchaseOrder.nextNumber).toBe(1);
    expect(stored.documentNumbering.quote.nextNumber).toBe(1);
    expect(stored.documentNumbering.statementOfAccount.nextNumber).toBe(1);
    expect(stored.documentNumbering.statement.nextNumber).toBe(1);
  });

  it('starts at 1 when the new workspace\'s request sends no numbering at all', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent
      .put('/api/business/profile')
      .field('name', 'No Numbering Co')
      .field('workspaceId', 'ws-counter-none');

    expect(res.status).toBe(200);
    const stored = await Business.findOne({ workspaceId: 'ws-counter-none' }).lean();
    expect(stored.documentNumbering.invoice).toEqual({ prefix: 'INV-', nextNumber: 1 });
    expect(stored.documentNumbering.statementOfAccount.nextNumber).toBe(1);
  });

  it('issues INV-1 then INV-2 as the first invoice numbers of a brand-new workspace', async () => {
    const { agent } = await authenticatedAgent(app);
    await agent
      .put('/api/business/profile')
      .field('name', 'First Invoice Co')
      .field('workspaceId', 'ws-counter-first')
      .field('documentNumbering', JSON.stringify({ invoice: { prefix: 'INV-', nextNumber: 900 } }));

    expect(await claimDocumentNumber('ws-counter-first', 'invoice')).toBe('INV-1');
    expect(await claimDocumentNumber('ws-counter-first', 'invoice')).toBe('INV-2');
  });

  it('applies the statementOfAccount prefix but not its next number (KAN-290)', async () => {
    await Business.create({
      workspaceId: 'ws-soa-set',
      name: 'SOA Set Co',
      documentNumbering: {
        statementOfAccount: { prefix: 'SOA-', nextNumber: 1 },
      },
    });
    const { agent } = await authenticatedAgent(app);
    const res = await agent
      .put('/api/business/profile')
      .field('name', 'SOA Set Co')
      .field('workspaceId', 'ws-soa-set')
      .field(
        'documentNumbering',
        JSON.stringify({
          invoice: { prefix: 'INV-', nextNumber: 1 },
          purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
          quote: { prefix: 'QT-', nextNumber: 1 },
          statement: { prefix: 'STM-', nextNumber: 1 },
          statementOfAccount: { prefix: 'SOAC-', nextNumber: 27 },
        })
      );

    expect(res.status).toBe(200);
    expect(res.body.documentNumbering.statementOfAccount).toEqual({ prefix: 'SOAC-', nextNumber: 1 });
  });

  // KAN-292. The next numbers are set once, by the user, the first time Finance
  // Settings is saved; after that they are read-only (KAN-290).
  describe('initial document numbers (KAN-292)', () => {
    const initialNumbering = (over = {}) => JSON.stringify({
      invoice: { prefix: 'INV-', nextNumber: 1200 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 35 },
      quote: { prefix: 'QT-', nextNumber: 410 },
      statementOfAccount: { prefix: 'SOA-', nextNumber: 8 },
      ...over,
    });
    const firstSave = (agent, workspaceId, numbering = initialNumbering()) =>
      agent
        .put('/api/business/profile')
        .field('name', 'Init Co')
        .field('workspaceId', workspaceId)
        .field('initializeDocumentNumbering', 'true')
        .field('documentNumbering', numbering);

    it('reports numbering as not yet initialized for a business that never set it', async () => {
      await Business.create({ workspaceId: 'ws-init-fresh', name: 'Init Co' });
      const { agent } = await authenticatedAgent(app);
      const res = await agent.get('/api/business/profile').query({ workspaceId: 'ws-init-fresh' });
      expect(res.body.documentNumberingInitialized).toBe(false);
    });

    it('reports an existing business whose counters have advanced as initialized, with no migration', async () => {
      await Business.create({
        workspaceId: 'ws-init-legacy',
        name: 'Legacy Co',
        documentNumbering: { invoice: { prefix: 'INV-', nextNumber: 57 } },
      });
      const { agent } = await authenticatedAgent(app);
      const res = await agent.get('/api/business/profile').query({ workspaceId: 'ws-init-legacy' });
      expect(res.body.documentNumberingInitialized).toBe(true);
    });

    it('takes the next number of all four document types on the first Finance Settings save', async () => {
      await Business.create({ workspaceId: 'ws-init-first', name: 'Init Co' });
      const { agent } = await authenticatedAgent(app);
      const res = await firstSave(agent, 'ws-init-first');

      expect(res.status).toBe(200);
      expect(res.body.documentNumberingInitialized).toBe(true);
      const stored = await Business.findOne({ workspaceId: 'ws-init-first' }).lean();
      expect(stored.documentNumbering.invoice.nextNumber).toBe(1200);
      expect(stored.documentNumbering.purchaseOrder.nextNumber).toBe(35);
      expect(stored.documentNumbering.quote.nextNumber).toBe(410);
      expect(stored.documentNumbering.statementOfAccount.nextNumber).toBe(8);
      expect(stored.documentNumbering.statement.nextNumber).toBe(1);
      expect(await claimDocumentNumber('ws-init-first', 'invoice')).toBe('INV-1200');
    });

    it('ignores the numbers on every later save', async () => {
      await Business.create({ workspaceId: 'ws-init-twice', name: 'Init Co' });
      const { agent } = await authenticatedAgent(app);
      await firstSave(agent, 'ws-init-twice');
      const res = await firstSave(agent, 'ws-init-twice', initialNumbering({
        invoice: { prefix: 'INV-', nextNumber: 5 },
      }));

      expect(res.status).toBe(200);
      const stored = await Business.findOne({ workspaceId: 'ws-init-twice' }).lean();
      expect(stored.documentNumbering.invoice.nextNumber).toBe(1200);
    });

    it('does not wind back a business whose counters had already advanced, even if the flag is sent', async () => {
      await Business.create({
        workspaceId: 'ws-init-advanced',
        name: 'Init Co',
        documentNumbering: { invoice: { prefix: 'INV-', nextNumber: 46 } },
      });
      const { agent } = await authenticatedAgent(app);
      const res = await firstSave(agent, 'ws-init-advanced');

      expect(res.status).toBe(200);
      const stored = await Business.findOne({ workspaceId: 'ws-init-advanced' }).lean();
      expect(stored.documentNumbering.invoice.nextNumber).toBe(46);
      expect(stored.documentNumbering.quote.nextNumber).toBe(1);
    });

    it('does not initialize on a save that does not ask for it (Configure Business)', async () => {
      await Business.create({ workspaceId: 'ws-init-basic', name: 'Init Co' });
      const { agent } = await authenticatedAgent(app);
      const res = await agent
        .put('/api/business/profile')
        .field('name', 'Init Co')
        .field('workspaceId', 'ws-init-basic')
        .field('documentNumbering', initialNumbering());

      expect(res.status).toBe(200);
      expect(res.body.documentNumberingInitialized).toBe(false);
      const stored = await Business.findOne({ workspaceId: 'ws-init-basic' }).lean();
      expect(stored.documentNumbering.invoice.nextNumber).toBe(1);
    });

    it.each([
      ['a missing document type', { quote: undefined }],
      ['zero', { invoice: { prefix: 'INV-', nextNumber: 0 } }],
      ['a blank number', { purchaseOrder: { prefix: 'PO-', nextNumber: null } }],
      ['a decimal', { quote: { prefix: 'QT-', nextNumber: 1.5 } }],
    ])('rejects the first save with %s and changes nothing', async (_label, over) => {
      await Business.create({ workspaceId: 'ws-init-bad', name: 'Init Co' });
      const { agent } = await authenticatedAgent(app);
      const res = await firstSave(agent, 'ws-init-bad', initialNumbering(over));

      expect(res.status).toBe(400);
      const stored = await Business.findOne({ workspaceId: 'ws-init-bad' }).lean();
      expect(stored.documentNumberingInitialized).not.toBe(true);
      expect(stored.documentNumbering.invoice.nextNumber).toBe(1);
    });

    it('tells the client whether the numbers were applied', async () => {
      await Business.create({ workspaceId: 'ws-init-reply', name: 'Init Co' });
      const { agent } = await authenticatedAgent(app);

      const first = await firstSave(agent, 'ws-init-reply');
      expect(first.body.initialNumbersApplied).toBe(true);

      // A second tab, or a user who saved first, sends the numbers again: they
      // are not applied, and the client is told rather than shown a success.
      const warnSpy = vi.spyOn(logger, 'warn');
      const second = await firstSave(agent, 'ws-init-reply', initialNumbering({
        invoice: { prefix: 'INV-', nextNumber: 5 },
      }));
      expect(second.status).toBe(200);
      expect(second.body.initialNumbersApplied).toBe(false);
      expect(second.body.documentNumbering.invoice.nextNumber).toBe(1200);
      expect(warnSpy).toHaveBeenCalledWith(
        'Business-Service',
        expect.stringMatching(/first document numbers were not applied/i),
        expect.objectContaining({ workspaceId: 'ws-init-reply' }),
        expect.anything(),
      );
      warnSpy.mockRestore();
    });

    it('refuses the numbers, and says so, for a legacy business whose backfill has not run', async () => {
      await Business.collection.insertOne({
        workspaceId: 'ws-init-premigration',
        name: 'Old Co',
        documentNumbering: {
          invoice: { prefix: 'INV-', nextNumber: 1 },
          purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
          quote: { prefix: 'QT-', nextNumber: 1 },
        },
      });
      const { agent } = await authenticatedAgent(app);

      const res = await firstSave(agent, 'ws-init-premigration');

      expect(res.status).toBe(200);
      expect(res.body.initialNumbersApplied).toBe(false);
      const stored = await Business.collection.findOne({ workspaceId: 'ws-init-premigration' });
      expect(stored.documentNumbering.invoice.nextNumber).toBe(1);
      expect(stored.documentNumberingInitialized).not.toBe(true);
    });

    it('does not mention the numbers in the reply to a save that did not ask to set them', async () => {
      await Business.create({ workspaceId: 'ws-init-quiet', name: 'Init Co' });
      const { agent } = await authenticatedAgent(app);
      const res = await agent
        .put('/api/business/profile')
        .field('name', 'Init Co')
        .field('workspaceId', 'ws-init-quiet');
      expect(res.body).not.toHaveProperty('initialNumbersApplied');
    });

    it('records the numbers that were set in the audit trail', async () => {
      await Business.create({ workspaceId: 'ws-init-audit', name: 'Init Co' });
      const { agent } = await authenticatedAgent(app);
      await firstSave(agent, 'ws-init-audit');

      const rows = await AuditTrail.find({ workspaceId: 'ws-init-audit' }).lean();
      const row = rows.find((r) => r.metadata?.initialNumbers);
      expect(row).toBeTruthy();
      expect(row.metadata.initialNumbers).toEqual({
        invoice: 1200, purchaseOrder: 35, quote: 410, statementOfAccount: 8,
      });
    });

    it('records the numbers in the audit trail when the first save creates the business', async () => {
      const { agent } = await authenticatedAgent(app);
      await firstSave(agent, 'ws-init-audit-new');

      const rows = await AuditTrail.find({ workspaceId: 'ws-init-audit-new' }).lean();
      expect(rows.find((r) => r.metadata?.initialNumbers)?.metadata.initialNumbers.invoice).toBe(1200);
    });

    it('takes the numbers when the first save also creates the business', async () => {
      const { agent } = await authenticatedAgent(app);
      const res = await firstSave(agent, 'ws-init-created');

      expect(res.status).toBe(200);
      expect(res.body.documentNumberingInitialized).toBe(true);
      const stored = await Business.findOne({ workspaceId: 'ws-init-created' }).lean();
      expect(stored.documentNumbering.invoice.nextNumber).toBe(1200);
      expect(stored.documentNumbering.statement.nextNumber).toBe(1);
    });
  });

  it('does not expose POST /api/business/xero/connect', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.post('/api/business/xero/connect').send({
      workspaceId: 'ws-connect',
      tenantId: 'tenant-1',
      tokens: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: Date.now() + 60_000,
      },
    });
    expect(res.status).toBe(404);
  });
});

/**
 * KAN-262, the client's own reproduction.
 *
 * Changing Head Office Timezone in Configure Business left the workspace's
 * automation schedules on the zone they were last saved with. The "Next Run"
 * caption kept naming the old zone — correctly, because the schedule really
 * was still on it — and only a manual, unrelated re-save of the automation
 * form brought the two back into line. Meanwhile the run fired on the old
 * wall clock and handed the old zone to its handler.
 */
describe('Business profile — Head Office Timezone and the automation schedules', () => {
  const PICKER = {
    every: { n: 1, unit: 'month' },
    runOn: 1,
    runAt: '09:00',
    startDate: '2026-09-01',
  };

  const saveTimezone = async (agent, workspaceId, timezone) => agent
    .put('/api/business/profile')
    .field('name', 'TZ Co')
    .field('workspaceId', workspaceId)
    .field('headOfficeTimezone', timezone);

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
  });

  it('moves the enabled schedules onto the new timezone', async () => {
    await Business.create({
      workspaceId: 'ws-tz-route', name: 'TZ Co', headOfficeTimezone: 'Australia/Melbourne',
    });
    await upsertSchedule({
      kind: 'invoice_automation',
      targetId: 'ws-tz-route',
      workspaceId: 'ws-tz-route',
      schedule: PICKER,
    });

    const { agent } = await authenticatedAgent(app);
    const res = await saveTimezone(agent, 'ws-tz-route', 'Australia/Perth');
    expect(res.status).toBe(200);

    const job = await ScheduledJob.findOne({ targetId: 'ws-tz-route' }).lean();
    expect(job.timezone).toBe('Australia/Perth');
  });

  // The other direction, because the client checked it too and it is the case
  // a one-way fix would pass.
  it('moves them back when the timezone is changed back', async () => {
    await Business.create({
      workspaceId: 'ws-tz-back', name: 'TZ Co', headOfficeTimezone: 'Australia/Melbourne',
    });
    await upsertSchedule({
      kind: 'invoice_automation',
      targetId: 'ws-tz-back',
      workspaceId: 'ws-tz-back',
      schedule: PICKER,
    });

    const { agent } = await authenticatedAgent(app);
    await saveTimezone(agent, 'ws-tz-back', 'Australia/Perth');
    // Asserted on the way out as well as on the way back: without it this case
    // passes against the bug, because a schedule that never moved is already
    // sitting on the zone the second save asks for.
    const midway = await ScheduledJob.findOne({ targetId: 'ws-tz-back' }).lean();
    expect(midway.timezone).toBe('Australia/Perth');

    await saveTimezone(agent, 'ws-tz-back', 'Australia/Melbourne');

    const job = await ScheduledJob.findOne({ targetId: 'ws-tz-back' }).lean();
    expect(job.timezone).toBe('Australia/Melbourne');
  });

  // The blast radius that would make this fix worse than the bug.
  it('does not switch a paused automation back on', async () => {
    await Business.create({
      workspaceId: 'ws-tz-paused', name: 'TZ Co', headOfficeTimezone: 'Australia/Melbourne',
    });
    await upsertSchedule({
      kind: 'invoice_automation',
      targetId: 'ws-tz-paused',
      workspaceId: 'ws-tz-paused',
      schedule: PICKER,
    });
    await disableSchedule({ kind: 'invoice_automation', targetId: 'ws-tz-paused' });

    const { agent } = await authenticatedAgent(app);
    await saveTimezone(agent, 'ws-tz-paused', 'Australia/Perth');

    const job = await ScheduledJob.findOne({ targetId: 'ws-tz-paused' }).lean();
    expect(job.enabled).toBe(false);
  });

  // Saving an address must not move a billing slot.
  it('leaves the next run alone when the profile is saved without changing the zone', async () => {
    await Business.create({
      workspaceId: 'ws-tz-noop', name: 'TZ Co', headOfficeTimezone: 'Australia/Melbourne',
    });
    const before = await upsertSchedule({
      kind: 'invoice_automation',
      targetId: 'ws-tz-noop',
      workspaceId: 'ws-tz-noop',
      schedule: PICKER,
    });

    const { agent } = await authenticatedAgent(app);
    await saveTimezone(agent, 'ws-tz-noop', 'Australia/Melbourne');

    const job = await ScheduledJob.findOne({ targetId: 'ws-tz-noop' }).lean();
    expect(job.nextRunAt.getTime()).toBe(before.nextRunAt.getTime());
  });

  // A profile save must still succeed for a workspace that has no automation.
  it('saves normally when the workspace has no schedules at all', async () => {
    await Business.create({
      workspaceId: 'ws-tz-none', name: 'TZ Co', headOfficeTimezone: 'Australia/Melbourne',
    });

    const { agent } = await authenticatedAgent(app);
    const res = await saveTimezone(agent, 'ws-tz-none', 'Australia/Perth');

    expect(res.status).toBe(200);
    expect(res.body.headOfficeTimezone).toBe('Australia/Perth');
  });
});

/**
 * KAN-322. Each page sends a `section` and is validated only for the fields it
 * owns. A stored legacy value on the other page, or an empty brand-new
 * workspace, must not block a save.
 */
describe('Business profile - each page validates its own fields (KAN-322)', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
  });

  const BAD_BANK = { bsb: '12', accountNumber: '1' };

  it('saves Finance Settings first on a brand-new workspace with no business name', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent
      .put('/api/business/profile')
      .field('section', 'finance')
      .field('workspaceId', 'ws-kan322-new-finance')
      .field('bsb', '062000')
      .field('accountNumber', '12345678');
    expect(res.status).toBe(200);
    const saved = await Business.findOne({ workspaceId: 'ws-kan322-new-finance' }).lean();
    expect(saved.bankDetails.bsb).toBe('062000');
    expect(saved.headOfficeTimezone).toBe('Australia/Sydney');
  });

  it('saves Business Configuration first on a brand-new workspace with no bank details', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent
      .put('/api/business/profile')
      .field('section', 'business')
      .field('workspaceId', 'ws-kan322-new-business')
      .field('name', 'Fresh Co');
    expect(res.status).toBe(200);
  });

  it('saves either page after the other on the same new workspace', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = 'ws-kan322-order';
    const finance = await agent.put('/api/business/profile')
      .field('section', 'finance').field('workspaceId', workspaceId).field('bsb', '062000');
    const business = await agent.put('/api/business/profile')
      .field('section', 'business').field('workspaceId', workspaceId).field('name', 'Order Co');
    expect(finance.status).toBe(200);
    expect(business.status).toBe(200);
    const saved = await Business.findOne({ workspaceId }).lean();
    expect(saved.name).toBe('Order Co');
    expect(saved.bankDetails.bsb).toBe('062000');
    // The Business page no longer sends numbering; the schema supplies the prefixes.
    expect(saved.documentNumbering.invoice.prefix).toBe('INV-');
  });

  it('saves Business Configuration while an invalid BSB is stored, leaving it untouched', async () => {
    await Business.collection.insertOne({
      workspaceId: 'ws-kan322-bad-bsb', name: 'Old Co', bankDetails: { bsb: 'REDACTED', accountNumber: 'x' },
    });
    const { agent } = await authenticatedAgent(app);
    const res = await agent.put('/api/business/profile')
      .field('section', 'business').field('workspaceId', 'ws-kan322-bad-bsb').field('name', 'New Co');
    expect(res.status).toBe(200);
    const saved = await Business.findOne({ workspaceId: 'ws-kan322-bad-bsb' }).lean();
    expect(saved.name).toBe('New Co');
    expect(saved.bankDetails.bsb).toBe('REDACTED');
  });

  it('saves Finance Settings while an invalid ABN is stored, leaving it untouched', async () => {
    await Business.collection.insertOne({ workspaceId: 'ws-kan322-bad-abn', name: 'Old Co', abn: 'REDACTED' });
    const { agent } = await authenticatedAgent(app);
    const res = await agent.put('/api/business/profile')
      .field('section', 'finance').field('workspaceId', 'ws-kan322-bad-abn').field('bsb', '062000');
    expect(res.status).toBe(200);
    const saved = await Business.findOne({ workspaceId: 'ws-kan322-bad-abn' }).lean();
    expect(saved.abn).toBe('REDACTED');
    expect(saved.name).toBe('Old Co');
    expect(saved.bankDetails.bsb).toBe('062000');
  });

  it('does not reset the head office timezone when Finance Settings saves', async () => {
    await Business.create({ workspaceId: 'ws-kan322-tz', name: 'TZ Co', headOfficeTimezone: 'Australia/Perth' });
    const { agent } = await authenticatedAgent(app);
    const res = await agent.put('/api/business/profile')
      .field('section', 'finance').field('workspaceId', 'ws-kan322-tz').field('bsb', '062000');
    expect(res.status).toBe(200);
    const saved = await Business.findOne({ workspaceId: 'ws-kan322-tz' }).lean();
    expect(saved.headOfficeTimezone).toBe('Australia/Perth');
  });

  it('rejects an invalid ABN on Business Configuration with a clear message', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.put('/api/business/profile')
      .field('section', 'business').field('workspaceId', 'ws-kan322-reject-abn')
      .field('name', 'Acme').field('abn', '123');
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['ABN must be exactly 11 digits']);
    expect(await Business.findOne({ workspaceId: 'ws-kan322-reject-abn' })).toBeNull();
  });

  it('rejects an invalid BSB on Finance Settings with a clear message', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.put('/api/business/profile')
      .field('section', 'finance').field('workspaceId', 'ws-kan322-reject-bsb').field('bsb', '12');
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['BSB must be exactly 6 digits']);
  });

  it('rejects an invalid ABN and email sent under section=finance, and stores nothing', async () => {
    await Business.collection.insertOne({ workspaceId: 'ws-kan322-spoof-finance', name: 'Keep Co', abn: '51121558187' });
    const { agent } = await authenticatedAgent(app);
    const res = await agent.put('/api/business/profile')
      .field('section', 'finance').field('workspaceId', 'ws-kan322-spoof-finance')
      .field('abn', 'junk').field('email', 'notanemail');
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expect.arrayContaining(['ABN must be exactly 11 digits', 'Invalid email format']));
    const saved = await Business.findOne({ workspaceId: 'ws-kan322-spoof-finance' }).lean();
    expect(saved.abn).toBe('51121558187');
  });

  it('rejects an invalid BSB sent under section=business, and stores nothing', async () => {
    await Business.collection.insertOne({
      workspaceId: 'ws-kan322-spoof-business', name: 'Keep Co', bankDetails: { bsb: '062000', accountNumber: '12345678' },
    });
    const { agent } = await authenticatedAgent(app);
    const res = await agent.put('/api/business/profile')
      .field('section', 'business').field('workspaceId', 'ws-kan322-spoof-business')
      .field('name', 'Keep Co').field('bsb', '12').field('accountNumber', 'x');
    expect(res.status).toBe(400);
    expect(res.body.errors).toContain('BSB must be exactly 6 digits');
    const saved = await Business.findOne({ workspaceId: 'ws-kan322-spoof-business' }).lean();
    expect(saved.bankDetails.bsb).toBe('062000');
  });

  it('still validates every field when a caller names no section', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.put('/api/business/profile')
      .field('name', 'Acme').field('workspaceId', 'ws-kan322-legacy').field('bsb', '12');
    expect(res.status).toBe(400);
    expect(res.body.errors).toContain('BSB must be exactly 6 digits');
  });
});
