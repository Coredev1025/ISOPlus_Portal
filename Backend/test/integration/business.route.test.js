import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/app.js';
import Business from '../../src/models/Business.js';
import { authenticatedAgent } from '../helpers/auth.js';

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
    expect(res.body.documentNumbering.invoice.nextNumber).toBe(11);
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

  it('persists statementOfAccount when it is included in documentNumbering', async () => {
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
          statementOfAccount: { prefix: 'SOA-', nextNumber: 27 },
        })
      );

    expect(res.status).toBe(200);
    expect(res.body.documentNumbering.statementOfAccount.nextNumber).toBe(27);
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
