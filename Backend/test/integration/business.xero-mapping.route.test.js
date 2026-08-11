import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import Business from '../../src/models/Business.js';
import { authenticatedAgent } from '../helpers/auth.js';

vi.mock('../../src/utils/xeroAccountTaxHelpers.js', () => ({
  loadXeroChartOptions: vi.fn(),
}));

vi.mock('../../src/utils/auditLogger.js', () => ({
  logAuditTrail: vi.fn(async () => {}),
}));

import { loadXeroChartOptions } from '../../src/utils/xeroAccountTaxHelpers.js';

const app = createApp();

describe('Business Xero mapping routes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requires authentication for account-tax-options', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app)
      .get('/api/business/xero/account-tax-options')
      .query({ workspaceId: 'ws-1' });
    expect(res.status).toBe(401);
  });

  it('rejects isoplus_user for account-tax-options', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    await agent.get('/api/auth/verify');
    const res = await agent
      .get('/api/business/xero/account-tax-options')
      .query({ workspaceId: 'ws-1' });
    expect(res.status).toBe(403);
  });

  it('validates workspaceId for account-tax-options', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.get('/api/business/xero/account-tax-options');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/workspaceId/i);
  });

  it('returns 404 when business is missing', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent
      .get('/api/business/xero/account-tax-options')
      .query({ workspaceId: 'ws-missing' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when Xero is not integrated', async () => {
    await Business.create({
      name: 'No Xero',
      workspaceId: 'ws-no-xero',
      xeroIntegrated: false,
    });
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent
      .get('/api/business/xero/account-tax-options')
      .query({ workspaceId: 'ws-no-xero' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/xero integration/i);
  });

  it('maps and returns Xero account/tax options', async () => {
    await Business.create({
      name: 'With Xero',
      workspaceId: 'ws-xero-opts',
      xeroIntegrated: true,
    });
    loadXeroChartOptions.mockResolvedValue({
      accounts: [
        {
          Code: '200',
          Name: 'Sales',
          Type: 'REVENUE',
          Class: 'REVENUE',
          Status: 'ACTIVE',
        },
        {
          Code: '999',
          Name: 'Old',
          Type: 'REVENUE',
          Class: 'REVENUE',
          Status: 'ARCHIVED',
        },
      ],
      taxRates: [
        {
          TaxType: 'OUTPUT',
          Name: 'GST',
          Status: 'ACTIVE',
          CanApplyToRevenue: true,
          CanApplyToExpenses: false,
          EffectiveRate: 10,
        },
      ],
    });

    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
    const res = await agent
      .get('/api/business/xero/account-tax-options')
      .query({ workspaceId: 'ws-xero-opts' });

    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([
      {
        code: '200',
        name: 'Sales',
        type: 'REVENUE',
        class: 'REVENUE',
        status: 'ACTIVE',
      },
    ]);
    expect(res.body.taxRates).toEqual([
      {
        taxType: 'OUTPUT',
        name: 'GST',
        status: 'ACTIVE',
        canApplyToRevenue: true,
        canApplyToExpenses: false,
        effectiveRate: 10,
      },
    ]);
  });

  it('returns 500 when chart options fail to load', async () => {
    await Business.create({
      name: 'Boom',
      workspaceId: 'ws-xero-boom',
      xeroIntegrated: true,
    });
    loadXeroChartOptions.mockRejectedValue(new Error('xero down'));

    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent
      .get('/api/business/xero/account-tax-options')
      .query({ workspaceId: 'ws-xero-boom' });
    expect(res.status).toBe(500);
  });

  it('saves line-item mapping and enriches tax rates', async () => {
    await Business.create({
      name: 'Map Me',
      workspaceId: 'ws-map-1',
      xeroIntegrated: true,
    });
    loadXeroChartOptions.mockResolvedValue({
      accounts: [],
      taxRates: [
        {
          TaxType: 'OUTPUT',
          Name: 'GST',
          Status: 'ACTIVE',
          CanApplyToRevenue: true,
          CanApplyToExpenses: false,
          EffectiveRate: 10,
        },
      ],
    });

    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.put('/api/business/xero/line-item-mapping').send({
      workspaceId: 'ws-map-1',
      mapping: {
        invoice: { accountCode: '200', taxType: 'OUTPUT' },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.xeroLineItemMapping.invoice).toMatchObject({
      accountCode: '200',
      taxType: 'OUTPUT',
      taxRatePercent: 10,
    });
  });

  it('still saves mapping when enriching tax rates fails', async () => {
    await Business.create({
      name: 'Map Fallback',
      workspaceId: 'ws-map-2',
      xeroIntegrated: true,
    });
    loadXeroChartOptions.mockRejectedValue(new Error('options unavailable'));

    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.put('/api/business/xero/line-item-mapping').send({
      workspaceId: 'ws-map-2',
      mapping: {
        quote: { accountCode: '200', taxType: 'OUTPUT' },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.xeroLineItemMapping.quote.accountCode).toBe('200');
  });

  it('returns 404 when saving mapping for a missing business', async () => {
    loadXeroChartOptions.mockResolvedValue({ accounts: [], taxRates: [] });
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.put('/api/business/xero/line-item-mapping').send({
      workspaceId: 'ws-map-missing',
      mapping: {},
    });
    expect(res.status).toBe(404);
  });

  it('returns 500 when saving mapping throws', async () => {
    await Business.create({
      name: 'Map Throw',
      workspaceId: 'ws-map-throw',
      xeroIntegrated: true,
    });
    loadXeroChartOptions.mockResolvedValue({ accounts: [], taxRates: [] });
    const spy = vi
      .spyOn(Business, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('db write failed'));

    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.put('/api/business/xero/line-item-mapping').send({
      workspaceId: 'ws-map-throw',
      mapping: { invoice: { accountCode: '200', taxType: 'OUTPUT' } },
    });

    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});
