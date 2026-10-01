import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import Business from '../../src/models/Business.js';
import ScheduledJob from '../../src/models/ScheduledJob.js';
import { upsertSchedule, disableSchedule } from '../../src/services/scheduler/schedules.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { claimDocumentNumber } from '../../src/utils/documentNumberAllocator.js';

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
