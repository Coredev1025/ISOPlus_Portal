import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { XeroClient } from 'xero-node';
import Business from '../../../src/models/Business.js';
import {
  configure,
  createInvoice,
  createPurchaseOrder,
  createQuote,
  ensureAuthenticated,
  getAccounts,
  getOrganizationInfo,
  getTaxRates,
  isAccountTaxRateMatched,
  updateOrganizationInfo,
} from '../../../src/services/xero.js';

/**
 * Coverage for auth/chart helpers after configure().
 * Spies live on XeroClient / AccountingApi prototypes so they survive
 * updateOrganizationInfo's re-configure() (new client instance).
 * Do not vi.resetModules() — mongoose model recompile.
 */

let accountingApiProto;
let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const farFutureMs = () => Date.now() + 60 * 24 * 60 * 60 * 1000;
const farFutureSec = () => Math.floor(Date.now() / 1000) + 60 * 60;

async function seedBusiness(workspaceId, extras = {}) {
  return Business.create({
    workspaceId,
    name: 'Xero Chart Biz',
    xeroIntegrated: true,
    xeroTokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: farFutureSec(),
      refreshTokenExpiresAt: farFutureMs(),
    },
    ...extras,
  });
}

function stubTokenSet({ expired = false, refreshToken = 'refresh-token' } = {}) {
  return {
    access_token: 'access-token',
    refresh_token: refreshToken,
    expires_at: farFutureSec(),
    token_type: 'Bearer',
    expired: () => expired,
  };
}

function spyClient(method, impl) {
  return vi.spyOn(XeroClient.prototype, method).mockImplementation(impl);
}

function spyAccounting(method, impl) {
  return vi.spyOn(accountingApiProto, method).mockImplementation(impl);
}

beforeAll(async () => {
  process.env.XERO_CLIENT_ID = process.env.XERO_CLIENT_ID || 'client-id';
  process.env.XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET || 'client-secret';
  process.env.XERO_REDIRECT_URL =
    process.env.XERO_REDIRECT_URL || 'https://portal.example.com/xero/callback';
  const client = await configure();
  accountingApiProto = Object.getPrototypeOf(client.accountingApi);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getOrganizationInfo', () => {
  it('maps organisations payload including organisationID fallback', async () => {
    spyAccounting('getOrganisations', async () => ({
      body: {
        organisations: [
          {
            name: 'Acme',
            legalName: 'Acme Pty Ltd',
            shortCode: 'ACME',
            organisationID: 'org-legacy',
            baseCurrency: 'AUD',
            countryCode: 'AU',
            isDemoCompany: false,
            organisationStatus: 'ACTIVE',
          },
        ],
      },
    }));

    await expect(getOrganizationInfo('tenant-1')).resolves.toEqual({
      name: 'Acme',
      legalName: 'Acme Pty Ltd',
      shortCode: 'ACME',
      organisationId: 'org-legacy',
      baseCurrency: 'AUD',
      countryCode: 'AU',
      isDemoCompany: false,
      organisationStatus: 'ACTIVE',
    });
  });

  it('reads Organisations (PascalCase) and uses organisationId when set', async () => {
    spyAccounting('getOrganisations', async () => ({
      body: {
        Organisations: [
          {
            name: 'Beta',
            organisationId: 'org-camel',
          },
        ],
      },
    }));

    const org = await getOrganizationInfo('tenant-2');
    expect(org.organisationId).toBe('org-camel');
    expect(org.name).toBe('Beta');
  });

  it('returns null when the tenant has no organisations', async () => {
    spyAccounting('getOrganisations', async () => ({
      body: { organisations: [] },
    }));
    await expect(getOrganizationInfo('tenant-empty')).resolves.toBeNull();
  });

  it('returns null when the API throws', async () => {
    spyAccounting('getOrganisations', async () => {
      throw new Error('network');
    });
    await expect(getOrganizationInfo('tenant-fail')).resolves.toBeNull();
  });
});

describe('getTaxRates', () => {
  async function stubAuth(workspaceId) {
    await seedBusiness(workspaceId);
    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet());
    spyClient('updateTenants', async function updateTenants() {
      this._tenants = [{ tenantId: 'tenant-tax', tenantName: 'Tax Org' }];
      return this._tenants;
    });
  }

  it('returns TaxRates from the API body', async () => {
    const workspaceId = nextId('ws');
    await stubAuth(workspaceId);
    spyAccounting('getTaxRates', async () => ({
      body: { TaxRates: [{ TaxType: 'OUTPUT', Name: 'GST' }] },
    }));

    await expect(getTaxRates(workspaceId)).resolves.toEqual([
      { TaxType: 'OUTPUT', Name: 'GST' },
    ]);
  });

  it('returns taxRates (camelCase) and empty when body is not an array', async () => {
    const workspaceId = nextId('ws');
    await stubAuth(workspaceId);
    const getTaxRatesSpy = spyAccounting('getTaxRates', async () => ({
      body: { taxRates: [{ taxType: 'INPUT' }] },
    }));
    await expect(getTaxRates(workspaceId)).resolves.toEqual([{ taxType: 'INPUT' }]);

    getTaxRatesSpy.mockResolvedValue({ body: { TaxRates: null } });
    await expect(getTaxRates(workspaceId)).resolves.toEqual([]);
  });

  it('maps 403 and 401 to scoped reconnect messages', async () => {
    const workspaceId = nextId('ws');
    await stubAuth(workspaceId);

    const getTaxRatesSpy = spyAccounting('getTaxRates', async () => {
      const err = new Error('forbidden');
      err.response = { statusCode: 403 };
      throw err;
    });
    await expect(getTaxRates(workspaceId)).rejects.toThrow(
      /Permission denied.*accounting.settings/
    );

    getTaxRatesSpy.mockImplementation(async () => {
      const err = new Error('unauthorized');
      err.response = { statusCode: 401 };
      throw err;
    });
    await expect(getTaxRates(workspaceId)).rejects.toThrow(
      /Authentication expired.*reconnect/
    );
  });

  it('rethrows a generic err.message when status is unmapped', async () => {
    const workspaceId = nextId('ws');
    await stubAuth(workspaceId);
    spyAccounting('getTaxRates', async () => {
      throw new Error('rate limit');
    });
    await expect(getTaxRates(workspaceId)).rejects.toThrow('rate limit');
  });
});

describe('isAccountTaxRateMatched', () => {
  it('returns true early when accountCode or taxType is missing', async () => {
    await expect(isAccountTaxRateMatched('ws', '', 'OUTPUT')).resolves.toBe(true);
    await expect(isAccountTaxRateMatched('ws', '200', '')).resolves.toBe(true);
  });

  it('checks REVENUE accounts against canApplyToRevenue from the chart', async () => {
    const chart = {
      accounts: [{ Code: '200', Class: 'REVENUE' }],
      taxRates: [
        {
          TaxType: 'OUTPUT',
          CanApplyToRevenue: true,
          CanApplyToExpenses: false,
        },
      ],
    };
    await expect(
      isAccountTaxRateMatched('ws', '200', 'OUTPUT', chart)
    ).resolves.toBe(true);

    chart.taxRates[0].CanApplyToRevenue = false;
    await expect(
      isAccountTaxRateMatched('ws', '200', 'OUTPUT', chart)
    ).resolves.toBe(false);
  });

  it('checks EXPENSE accounts against canApplyToExpenses', async () => {
    const chart = {
      accounts: [{ code: '400', class: 'EXPENSE' }],
      taxRates: [
        {
          taxType: 'INPUT',
          canApplyToRevenue: false,
          canApplyToExpenses: true,
        },
      ],
    };
    await expect(
      isAccountTaxRateMatched('ws', '400', 'INPUT', chart)
    ).resolves.toBe(true);

    chart.taxRates[0].canApplyToExpenses = false;
    await expect(
      isAccountTaxRateMatched('ws', '400', 'INPUT', chart)
    ).resolves.toBe(false);
  });

  it('returns true for unknown account or tax type in the chart', async () => {
    const chart = {
      accounts: [{ Code: '200', Class: 'REVENUE' }],
      taxRates: [{ TaxType: 'OUTPUT', CanApplyToRevenue: true }],
    };
    await expect(
      isAccountTaxRateMatched('ws', '999', 'OUTPUT', chart)
    ).resolves.toBe(true);
    await expect(
      isAccountTaxRateMatched('ws', '200', 'UNKNOWN', chart)
    ).resolves.toBe(true);
  });

  it('returns true when chart fetch fails (cannot validate)', async () => {
    const workspaceId = nextId('ws');
    await expect(
      isAccountTaxRateMatched(workspaceId, '200', 'OUTPUT')
    ).resolves.toBe(true);
  });
});

describe('ensureAuthenticated / resolveActiveTenantId', () => {
  it('returns a tenant from updateTenants for a business with tokens', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet());
    const updateTenants = spyClient('updateTenants', async function updateTenants() {
      this._tenants = [{ tenantId: 'tenant-live', tenantName: 'Live Org' }];
      return this._tenants;
    });

    const result = await ensureAuthenticated(workspaceId);
    expect(result).toEqual({
      tenantId: 'tenant-live',
      tenant: { tenantId: 'tenant-live', tenantName: 'Live Org' },
    });
    expect(updateTenants).toHaveBeenCalled();

    const stored = await Business.findOne({ workspaceId }).lean();
    expect(stored.xeroTenantId).toBe('tenant-live');
  });

  it('refreshes when the access token is expired', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);
    const newExpires = farFutureSec() + 100;

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet({ expired: true }));
    const refresh = spyClient('refreshWithRefreshToken', async () => ({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_at: newExpires,
    }));
    spyClient('updateTenants', async function updateTenants() {
      this._tenants = [{ tenantId: 'tenant-refreshed' }];
      return this._tenants;
    });

    const result = await ensureAuthenticated(workspaceId);
    expect(result.tenantId).toBe('tenant-refreshed');
    expect(refresh).toHaveBeenCalled();

    const stored = await Business.findOne({ workspaceId }).lean();
    expect(stored.xeroTokens.accessToken).toBe('new-access');
    expect(stored.xeroTokens.refreshToken).toBe('new-refresh');
  });

  it('falls back to a stored tenant when updateTenants returns none', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId, { xeroTenantId: 'stored-tenant' });

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet({ refreshToken: null }));
    spyClient('updateTenants', async () => []);

    const result = await ensureAuthenticated(workspaceId);
    expect(result.tenantId).toBe('stored-tenant');
  });

  it('throws XERO_RECONNECT_MESSAGE when there are no tenants and no stored id', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet({ refreshToken: null }));
    spyClient('updateTenants', async () => []);

    await expect(ensureAuthenticated(workspaceId)).rejects.toThrow(
      /No Xero organisation is linked/
    );
  });

  it('retries updateTenants after refreshing when first tenants call is empty', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet());
    const refresh = spyClient('refreshWithRefreshToken', async () => ({
      access_token: 'a2',
      refresh_token: 'r2',
      expires_at: farFutureSec(),
    }));
    let calls = 0;
    spyClient('updateTenants', async function updateTenants() {
      calls += 1;
      if (calls === 1) return [];
      this._tenants = [{ tenantId: 'tenant-after-refresh' }];
      return this._tenants;
    });

    const result = await ensureAuthenticated(workspaceId);
    expect(result.tenantId).toBe('tenant-after-refresh');
    expect(refresh).toHaveBeenCalled();
  });
});

describe('updateOrganizationInfo', () => {
  it('persists organisation info from getOrganisations', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet());
    spyClient('updateTenants', async function updateTenants() {
      this._tenants = [{ tenantId: 'tenant-org', tenantName: 'Org Name' }];
      return this._tenants;
    });
    spyAccounting('getOrganisations', async () => ({
      body: {
        organisations: [
          {
            name: 'Org Name',
            legalName: 'Org Legal',
            organisationID: 'org-api-id',
            baseCurrency: 'AUD',
            countryCode: 'AU',
          },
        ],
      },
    }));

    const org = await updateOrganizationInfo(workspaceId);
    expect(org.name).toBe('Org Name');
    expect(org.organisationId).toBe('org-api-id');

    const stored = await Business.findOne({ workspaceId }).lean();
    expect(stored.xeroOrganization.organisationId).toBe('org-api-id');
    expect(stored.xeroTenantId).toBe('tenant-org');
  });

  it('falls back to organizationFromTenantConnection when API returns null', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet());
    spyClient('updateTenants', async function updateTenants() {
      this._tenants = [{ tenantId: 'tenant-fallback', tenantName: 'Fallback Org' }];
      return this._tenants;
    });
    spyAccounting('getOrganisations', async () => ({
      body: { organisations: [] },
    }));

    const org = await updateOrganizationInfo(workspaceId);
    expect(org).toEqual({
      name: 'Fallback Org',
      legalName: 'Fallback Org',
      shortCode: '',
      organisationId: 'tenant-fallback',
      baseCurrency: '',
      countryCode: '',
      isDemoCompany: false,
      organisationStatus: '',
    });
  });

  it('rejects an invalid workspaceId', async () => {
    await expect(updateOrganizationInfo('')).rejects.toThrow('Invalid workspace Id');
  });

  it('surfaces reconnect errors from ensureAuthenticated', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet({ refreshToken: null }));
    spyClient('updateTenants', async () => []);

    await expect(updateOrganizationInfo(workspaceId)).rejects.toThrow(
      /No Xero organisation is linked/
    );
  });
});

describe('createInvoice / createQuote / createPurchaseOrder lineAmountTypes', () => {
  const CONTACT_ID = '0f5e2a5e-6d4e-4a1f-8f0c-9b6a2f0f1c3d';

  it('defaults createInvoice lineAmountTypes to Exclusive', async () => {
    const tenants = [{ tenantId: 'tenant-inv' }];
    const createInvoices = spyAccounting('createInvoices', async () => ({
      body: { invoices: [{ invoiceID: 'inv-1', lineAmountTypes: 'Exclusive' }] },
    }));
    spyClient('updateTenants', async function updateTenants() {
      this._tenants = tenants;
      return tenants;
    });

    const invoice = await createInvoice({
      type: 'ACCREC',
      contact: { contactID: CONTACT_ID },
      reference: 'JOB-1',
      date: '2026-03-01',
      dueDate: '2026-03-31',
      status: 'DRAFT',
      lineItems: [
        {
          description: 'Support',
          quantity: 1,
          unitAmount: 100,
          accountCode: '200',
          taxType: 'OUTPUT',
        },
      ],
    });

    expect(invoice.invoiceID).toBe('inv-1');
    const payload = createInvoices.mock.calls[0][1];
    expect(payload.invoices[0].lineAmountTypes).toBe('Exclusive');
  });

  it('defaults createQuote lineAmountTypes to Exclusive', async () => {
    spyClient('readTokenSet', () => stubTokenSet());
    spyClient('updateTenants', async function updateTenants() {
      this._tenants = [{ tenantId: 'tenant-quote' }];
      return this._tenants;
    });
    const createQuotes = spyAccounting('createQuotes', async () => ({
      body: { quotes: [{ quoteID: 'q-1' }] },
    }));

    await createQuote({ contact: { contactID: CONTACT_ID }, lineItems: [] });
    expect(createQuotes.mock.calls[0][1].quotes[0].lineAmountTypes).toBe(
      'Exclusive'
    );
  });

  it('defaults createPurchaseOrder lineAmountTypes to Exclusive', async () => {
    spyClient('readTokenSet', () => stubTokenSet());
    spyClient('updateTenants', async function updateTenants() {
      this._tenants = [{ tenantId: 'tenant-po' }];
      return this._tenants;
    });
    const createPurchaseOrders = spyAccounting('createPurchaseOrders', async () => ({
      body: { purchaseOrders: [{ purchaseOrderID: 'po-1' }] },
    }));

    await createPurchaseOrder({
      contact: { contactID: CONTACT_ID },
      lineItems: [],
    });
    expect(
      createPurchaseOrders.mock.calls[0][1].purchaseOrders[0].lineAmountTypes
    ).toBe('Exclusive');
  });
});

describe('getAccounts error mapping', () => {
  it('maps 403 to a permission message', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);
    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet());
    spyClient('updateTenants', async function updateTenants() {
      this._tenants = [{ tenantId: 'tenant-acc' }];
      return this._tenants;
    });
    spyAccounting('getAccounts', async () => {
      const err = new Error('forbidden');
      err.response = { statusCode: 403 };
      throw err;
    });

    await expect(getAccounts(workspaceId)).rejects.toThrow(
      /Permission denied.*accounting.settings/
    );
  });

  it('returns Accounts from the API and maps 401', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);
    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet());
    spyClient('updateTenants', async function updateTenants() {
      this._tenants = [{ tenantId: 'tenant-acc-2' }];
      return this._tenants;
    });
    const getAccountsSpy = spyAccounting('getAccounts', async () => ({
      body: { Accounts: [{ Code: '200', Name: 'Sales' }] },
    }));

    await expect(getAccounts(workspaceId)).resolves.toEqual([
      { Code: '200', Name: 'Sales' },
    ]);

    getAccountsSpy.mockImplementation(async () => ({
      body: { accounts: null },
    }));
    await expect(getAccounts(workspaceId)).resolves.toEqual([]);

    getAccountsSpy.mockImplementation(async () => {
      const err = new Error('unauthorized');
      err.response = { statusCode: 401 };
      throw err;
    });
    await expect(getAccounts(workspaceId)).rejects.toThrow(
      /Authentication expired.*reconnect/
    );
  });
});

describe('updateOrganizationInfo reconnect when org cannot be resolved', () => {
  it('throws when API and tenant fallback both yield no organisation', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet());
    spyClient('updateTenants', async function updateTenants() {
      // tenant without tenantId → organizationFromTenantConnection returns null
      this._tenants = [{ tenantName: 'Nameless' }];
      return this._tenants;
    });
    spyAccounting('getOrganisations', async () => ({
      body: { organisations: [] },
    }));

    await expect(updateOrganizationInfo(workspaceId)).rejects.toThrow(
      /No Xero organisation is linked/
    );
  });
});

describe('refreshXeroTokenSet expiry guards', () => {
  it('throws reconnect when refresh token is missing or expired during tenant refresh', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId, {
      xeroTokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: farFutureSec(),
        refreshTokenExpiresAt: Date.now() - 1000,
      },
    });

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet({ expired: true }));
    spyClient('updateTenants', async () => []);

    await expect(ensureAuthenticated(workspaceId)).rejects.toThrow(
      /Please reconnect to Xero/
    );
  });

  it('throws reconnect when refreshWithRefreshToken fails', async () => {
    const workspaceId = nextId('ws');
    await seedBusiness(workspaceId);

    spyClient('setTokenSet', async () => undefined);
    spyClient('readTokenSet', () => stubTokenSet({ expired: true }));
    spyClient('refreshWithRefreshToken', async () => {
      throw new Error('refresh failed');
    });
    spyClient('updateTenants', async () => []);

    await expect(ensureAuthenticated(workspaceId)).rejects.toThrow(
      /Please reconnect to Xero/
    );
  });
});
