import { describe, it, expect } from 'vitest';
import Business from '../../../src/models/Business.js';
import {
  configure,
  createInvoice,
  findOrCreateItem,
  ensureAuthenticated,
  getAccounts,
  updateOrganizationInfo,
  getAuthUrl,
  createToken,
  exchangeCode,
  refreshTokenSet,
} from '../../../src/services/xero.js';

/**
 * src/services/xero.js keeps a single module-level XeroClient, created by
 * configure(). That state is why the tests are ordered: everything asserting
 * the "not configured yet" behaviour runs before the one test that calls
 * configure(), and nothing here calls a function that would actually talk to
 * Xero over the network — every case stops at argument validation, at the Joi
 * invoice schema, or at the Business lookup that supplies the stored tokens.
 *
 * Module state cannot be reset with vi.resetModules() here: re-importing the
 * service re-imports src/models/Business.js, and mongoose refuses to compile
 * the same model name twice.
 */

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const CONTACT_ID = '0f5e2a5e-6d4e-4a1f-8f0c-9b6a2f0f1c3d';

const validInvoice = () => ({
  type: 'ACCREC',
  contact: { contactID: CONTACT_ID },
  reference: 'JOB-1',
  date: '2026-03-01',
  dueDate: '2026-03-31',
  status: 'DRAFT',
  lineItems: [
    {
      description: 'Support delivery',
      quantity: 1,
      unitAmount: 100,
      accountCode: '200',
      taxType: 'OUTPUT',
    },
  ],
});

describe('before configure() has run', () => {
  it('refuses to build a consent URL', async () => {
    await expect(getAuthUrl()).rejects.toThrow('Xero client is not configured.');
  });

  it('reports a generic failure when reading the token set', async () => {
    await expect(createToken()).rejects.toThrow('Error creating token');
  });

  it('reports a generic failure when exchanging an authorization code', async () => {
    await expect(exchangeCode('some-code')).rejects.toThrow(
      'Error exchanging authorization code'
    );
  });

  it('reports a generic failure when refreshing a token set', async () => {
    await expect(refreshTokenSet({ refresh_token: 'r' })).rejects.toThrow(
      'Error refreshing token'
    );
  });
});

describe('createInvoice validation (runs before any Xero call)', () => {
  it('rejects an invoice with no line items', async () => {
    const invoice = { ...validInvoice(), lineItems: [] };

    await expect(createInvoice(invoice)).rejects.toThrow(
      /Invoice validation failed:.*At least one LineItem is required/
    );
  });

  it('rejects a contactID that is not a GUID', async () => {
    const invoice = { ...validInvoice(), contact: { contactID: 'not-a-guid' } };

    await expect(createInvoice(invoice)).rejects.toThrow(
      /ContactID must be a valid GUID/
    );
  });

  it('rejects a type Xero does not accept', async () => {
    const invoice = { ...validInvoice(), type: 'INVOICE' };

    await expect(createInvoice(invoice)).rejects.toThrow(
      /Type must be ACCPAY, ACCREC, or QUOTE/
    );
  });

  it('rejects a line item with a zero unit amount', async () => {
    const invoice = validInvoice();
    invoice.lineItems[0].unitAmount = 0;

    await expect(createInvoice(invoice)).rejects.toThrow(/UnitAmount must not be 0/);
  });

  it('rejects a line item with no account code, which Xero requires', async () => {
    const invoice = validInvoice();
    delete invoice.lineItems[0].accountCode;

    await expect(createInvoice(invoice)).rejects.toThrow(
      /AccountCode is required for Xero API/
    );
  });

  it('reports every problem at once rather than only the first', async () => {
    const invoice = { ...validInvoice(), type: 'INVOICE', contact: { contactID: 'nope' } };

    await expect(createInvoice(invoice)).rejects.toThrow(
      /Type must be ACCPAY, ACCREC, or QUOTE.*ContactID must be a valid GUID/s
    );
  });

  it('accepts a contactID given directly rather than nested under contact', async () => {
    // The flat form passes validation, so the failure that follows is the
    // missing client, not the schema.
    const { contact, ...rest } = validInvoice();
    const invoice = { ...rest, contactID: CONTACT_ID };

    await expect(createInvoice(invoice)).rejects.toThrow(/Xero client not configured/);
  });
});

describe('findOrCreateItem argument validation', () => {
  it.each([
    [undefined, 'Consulting'],
    ['CODE', undefined],
    ['', 'Consulting'],
    [123, 'Consulting'],
    ['CODE', 456],
  ])('rejects itemCode=%p itemName=%p', async (code, name) => {
    await expect(findOrCreateItem(code, name)).rejects.toThrow(
      'Item validation failed: itemCode and itemName are required and must be strings.'
    );
  });
});

describe('ensureAuthenticated', () => {
  it('rejects a workspaceId that is not a non-empty string', async () => {
    await expect(ensureAuthenticated('')).rejects.toThrow('Invalid workspace Id');
    await expect(ensureAuthenticated(undefined)).rejects.toThrow('Invalid workspace Id');
    await expect(ensureAuthenticated(42)).rejects.toThrow('Invalid workspace Id');
  });

  it('rejects when no business exists for the workspace', async () => {
    await expect(ensureAuthenticated(nextId('ws'))).rejects.toThrow('No Xero tokens found');
  });

  it('gets past the token guard for a business that has never connected to Xero', async () => {
    // xeroTokens is a nested-path object in the Business schema, so Mongoose
    // materialises it as {} even when no token was ever stored. The
    // `!business.xeroTokens` guard is therefore never true for an existing
    // business, and the failure surfaces later and less helpfully.
    const workspaceId = nextId('ws');
    await Business.create({ workspaceId, name: 'Acme Care' });

    await expect(ensureAuthenticated(workspaceId)).rejects.toThrow('Xero client not configured');
  });
});

describe('getAccounts', () => {
  it('wraps an invalid workspaceId in its own message', async () => {
    await expect(getAccounts('')).rejects.toThrow('Error getting accounts: Invalid workspace Id');
  });

  it('wraps the missing-token failure rather than letting it through raw', async () => {
    await expect(getAccounts(nextId('ws'))).rejects.toThrow(
      'Error getting accounts: No Xero tokens found'
    );
  });
});

describe('updateOrganizationInfo', () => {
  it('wraps an invalid workspaceId in its own message', async () => {
    await expect(updateOrganizationInfo('')).rejects.toThrow(
      'Error updating organization info: Invalid workspace Id'
    );
  });
});

describe('configure', () => {
  // Runs last: it installs the module-level client the tests above rely on
  // being absent.
  const ORIGINAL = {
    XERO_CLIENT_ID: process.env.XERO_CLIENT_ID,
    XERO_CLIENT_SECRET: process.env.XERO_CLIENT_SECRET,
    XERO_REDIRECT_URL: process.env.XERO_REDIRECT_URL,
  };

  const restore = () => {
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  it('uses the authorization_code grant when a redirect URL is configured', async () => {
    process.env.XERO_CLIENT_ID = 'client-id';
    process.env.XERO_CLIENT_SECRET = 'client-secret';
    process.env.XERO_REDIRECT_URL = 'https://portal.example.com/xero/callback';

    const client = await configure();

    expect(client.config.grantType).toBe('authorization_code');
    expect(client.config.redirectUris).toEqual(['https://portal.example.com/xero/callback']);
    expect(client.config.clientId).toBe('client-id');
    expect(client.config.scopes).toContain('accounting.transactions');
    expect(client.config.scopes).toContain('offline_access');

    restore();
  });

  it('falls back to the client_credentials grant without a redirect URL', async () => {
    process.env.XERO_CLIENT_ID = 'client-id';
    process.env.XERO_CLIENT_SECRET = 'client-secret';
    delete process.env.XERO_REDIRECT_URL;

    const client = await configure();

    expect(client.config.grantType).toBe('client_credentials');
    expect(client.config.redirectUris).toBeUndefined();

    restore();
  });
});
