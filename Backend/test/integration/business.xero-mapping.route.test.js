import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import Business from '../../src/models/Business.js';
import { authenticatedAgent } from '../helpers/auth.js';

vi.mock('../../src/utils/xeroAccountTaxHelpers.js', () => ({
  loadXeroChartOptions: vi.fn(),
}));

vi.mock('../../src/services/xero.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateOrganizationInfo: vi.fn(),
  };
});

vi.mock('../../src/utils/auditLogger.js', () => ({
  logAuditTrail: vi.fn(async () => {}),
}));

import { loadXeroChartOptions } from '../../src/utils/xeroAccountTaxHelpers.js';
import { updateOrganizationInfo } from '../../src/services/xero.js';

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

  /**
   * Client (ISO+) users configure their own Xero mapping on Finance Settings.
   * Password login cannot produce session.Authorization — only the OAuth path
   * does — so this mirrors a real client session the way production does.
   */
  async function isoplusUserAgent(email) {
    const request = (await import('supertest')).default;
    const agent = request.agent(app);
    const res = await agent
      .post('/api/auth/oauth-login')
      .set('Authorization', 'Bearer isoplus-user-token')
      .send({ oauthData: { id: `oauth-${email}`, email, name: 'ISO+ User' } });
    expect(res.status).toBe(200);
    return agent;
  }

  it('lets an isoplus_user load account-tax-options for their workspace', async () => {
    await Business.create({
      name: 'Client Xero',
      workspaceId: 'ws-client-opts',
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
      ],
      taxRates: [],
    });

    const agent = await isoplusUserAgent('client@workspace.test');
    const res = await agent
      .get('/api/business/xero/account-tax-options')
      .query({ workspaceId: 'ws-client-opts' });

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
  });

  it('lets an isoplus_user save line-item mapping', async () => {
    await Business.create({
      name: 'Client Map',
      workspaceId: 'ws-client-map',
      xeroIntegrated: true,
    });
    loadXeroChartOptions.mockResolvedValue({ accounts: [], taxRates: [] });

    const agent = await isoplusUserAgent('mapper@workspace.test');
    const res = await agent.put('/api/business/xero/line-item-mapping').send({
      workspaceId: 'ws-client-map',
      mapping: {
        invoice: { accountCode: '200', taxType: 'OUTPUT' },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.xeroLineItemMapping.invoice.accountCode).toBe('200');
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

  it('returns 409 when update-organization hits a Xero reconnect error', async () => {
    await Business.create({
      name: 'Reconnect',
      workspaceId: 'ws-xero-reconnect',
      xeroIntegrated: true,
    });
    updateOrganizationInfo.mockRejectedValueOnce(
      new Error('Your Xero authorization token is expired. Please reconnect to Xero.')
    );

    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.post('/api/business/xero/update-organization').send({
      workspaceId: 'ws-xero-reconnect',
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/reconnect/i);
  });

  it('returns 409 when update-organization reports no linked organisation', async () => {
    await Business.create({
      name: 'No Org',
      workspaceId: 'ws-xero-no-org',
      xeroIntegrated: true,
    });
    updateOrganizationInfo.mockRejectedValueOnce(
      new Error('No Xero organisation is linked. Disconnect and Connect Xero again, then select an organisation.')
    );

    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.post('/api/business/xero/update-organization').send({
      workspaceId: 'ws-xero-no-org',
    });

    expect(res.status).toBe(409);
  });

  it('returns 500 for non-reconnect update-organization failures', async () => {
    await Business.create({
      name: 'Boom Org',
      workspaceId: 'ws-xero-org-boom',
      xeroIntegrated: true,
    });
    updateOrganizationInfo.mockRejectedValueOnce(new Error('upstream exploded'));

    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.post('/api/business/xero/update-organization').send({
      workspaceId: 'ws-xero-org-boom',
    });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('upstream exploded');
  });

  it('persists organization info on successful update-organization', async () => {
    await Business.create({
      name: 'Fresh Org',
      workspaceId: 'ws-xero-org-ok',
      xeroIntegrated: true,
    });
    updateOrganizationInfo.mockResolvedValueOnce({
      name: 'Acme Xero',
      organisationId: 'org-123',
      legalName: 'Acme Pty Ltd',
    });

    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.post('/api/business/xero/update-organization').send({
      workspaceId: 'ws-xero-org-ok',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.organization.organisationId).toBe('org-123');

    const stored = await Business.findOne({ workspaceId: 'ws-xero-org-ok' }).lean();
    expect(stored.xeroTenantId).toBe('org-123');
    expect(stored.xeroOrganization.name).toBe('Acme Xero');
  });

  it('returns 404 / 400 guards for update-organization', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const missing = await agent.post('/api/business/xero/update-organization').send({
      workspaceId: 'ws-xero-org-missing',
    });
    expect(missing.status).toBe(404);

    await Business.create({
      name: 'No Integration',
      workspaceId: 'ws-xero-org-off',
      xeroIntegrated: false,
    });
    const off = await agent.post('/api/business/xero/update-organization').send({
      workspaceId: 'ws-xero-org-off',
    });
    expect(off.status).toBe(400);
  });

  it('returns 400 when line-item-mapping workspaceId is missing', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.put('/api/business/xero/line-item-mapping').send({
      mapping: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/workspaceId/i);
  });
});
