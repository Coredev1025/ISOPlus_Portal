import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import Business from '../../../src/models/Business.js';

/**
 * src/routes/xero.js, mounted at /api/xero. Invoice/quote/PO sync routes are
 * called by ISO+ automations, so they are unauthenticated and answer 200 with
 * an error body rather than a 4xx/5xx. GET /redirect is the OAuth start URL
 * and requires a portal session.
 *
 * Every case below stops at a guard — payload validation, the Joi DTO, or the
 * missing Business / missing Xero token — so no request reaches Xero. The one
 * route deliberately not exercised here is POST /:ws/:b/invoice with an empty
 * payload: it reads item.values before entering its try block, and Express 4
 * does not catch a rejected async handler, so that request never gets a
 * response. Reported as a bug rather than pinned with a test that would hang.
 */

const app = createApp();

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const validContactValues = {
  Client: 'Acme Pty Ltd',
  'Contact Person\'s First Name': 'Ada',
  'Contact Person\'s Last Name': 'Lovelace',
  'Email Address': 'ada@example.com',
  'Phone Number': '0400000000',
  Address: '1 Test St',
  Suburb: 'Sydney',
  State: 'NSW',
  Postcode: 2000,
};

const validContractorValues = {
  Contractor: 'Bolt Services',
  'Contact Person\'s First Name': 'Grace',
  'Contact Person\'s Last Name': 'Hopper',
  'Email Address': 'grace@example.com',
  'Phone Number': '0400000001',
  Postcode: 2000,
};

describe('GET /api/xero/redirect', () => {
  it('requires a portal session before minting a Xero consent URL', async () => {
    const res = await request(app).get('/api/xero/redirect').query({ workspaceId: 'ws-1' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Authentication required' });
  });
});

describe('GET /api/xero/services', () => {
  it('lists the six integration capabilities with their statuses', async () => {
    const res = await request(app).get('/api/xero/services');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    expect(res.body[0]).toEqual({ Name: 'Create invoice', Status: 'Ready' });
    expect(res.body.filter((s) => s.Status === 'Ready')).toHaveLength(1);
  });
});

describe('GET /api/xero/hello', () => {
  it('answers with the plain greeting', async () => {
    const res = await request(app).get('/api/xero/hello');

    expect(res.status).toBe(200);
    expect(res.text).toBe('Hello, World!');
  });
});

describe('POST /api/xero/:workspaceId/:boardId/contact', () => {
  it('reports an empty payload without calling Xero', async () => {
    const res = await request(app).post('/api/xero/w1/b1/contact').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'No items found in the payload' });
  });

  it('reports every missing required field from the contact DTO', async () => {
    const res = await request(app)
      .post('/api/xero/w1/b1/contact')
      .send({ items: [{ id: 'item-1', values: {} }] });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Contact validation failed');
    expect(res.body.details.map((d) => d.message)).toEqual([
      'Client is required.',
      'Email Address is required.',
      'Phone Number is required.',
    ]);
  });

  it('rejects a malformed email address', async () => {
    const res = await request(app)
      .post('/api/xero/w1/b1/contact')
      .send({
        items: [{ id: 'item-1', values: { ...validContactValues, 'Email Address': 'not-an-email' } }],
      });

    expect(res.body.message).toBe('Contact validation failed');
    expect(res.body.details.map((d) => d.message)).toEqual(['Email Address is invalid.']);
  });

  it('gets past validation and fails on the missing business', async () => {
    const res = await request(app)
      .post(`/api/xero/${nextId('ws')}/b1/contact`)
      .send({ items: [{ id: 'item-1', values: validContactValues }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Error processing contact in Xero',
      error: 'Business not found',
    });
  });
});

describe('POST /api/xero/:workspaceId/:boardId/contractor', () => {
  it('reports an empty payload', async () => {
    const res = await request(app).post('/api/xero/w1/b1/contractor').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'No items found in the payload' });
  });

  it('validates against the contractor DTO, not the contact one', async () => {
    const res = await request(app)
      .post('/api/xero/w1/b1/contractor')
      .send({ items: [{ id: 'item-1', values: {} }] });

    expect(res.body.message).toBe('Contractor validation failed');
    expect(res.body.details.map((d) => d.message)).toEqual([
      'Contractor is required.',
      'Email Address is required.',
      'Phone Number is required.',
    ]);
  });

  it('gets past validation and fails on the missing business', async () => {
    const res = await request(app)
      .post(`/api/xero/${nextId('ws')}/b1/contractor`)
      .send({ items: [{ id: 'item-1', values: validContractorValues }] });

    expect(res.body).toEqual({
      message: 'Error processing contractor in Xero',
      error: 'Business not found',
    });
  });
});

describe('POST /api/xero/:workspaceId/:boardId/invoice', () => {
  it('rejects an item whose job values do not satisfy the Job DTO', async () => {
    const res = await request(app)
      .post('/api/xero/w1/b1/invoice')
      .send({ items: [{ id: 'item-1', values: {} }] });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Invoice validation failed');
    expect(res.body.details.map((d) => d.context.key)).toEqual([
      'jobNumber',
      'jobDurationHrs',
      'serviceFeeType',
      'payableServiceFee',
      'payableMaterialFee',
      'otherPayableFee',
    ]);
  });

  it('fails on the missing business once the job values validate', async () => {
    const res = await request(app)
      .post(`/api/xero/${nextId('ws')}/b1/invoice`)
      .send({
        items: [
          {
            id: 'item-1',
            values: {
              'Job Number': ['JOB-1'],
              'Job Duration (Hrs.)': 2,
              'Service Fee Type': ['Standard'],
              'Payable Service Fee($) - GST Excl.': 100,
              'Payable Material Fee($) - GST Excl.': 0,
              'Other Payable Fee($) - GST Excl.': 0,
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Error processing invoice in Xero',
      error: 'Business not found',
    });
  });
});

describe('POST /api/xero/:workspaceId/:boardId/quote', () => {
  it('fails on the missing business before it reaches the quote DTO', async () => {
    const res = await request(app)
      .post(`/api/xero/${nextId('ws')}/b1/quote`)
      .send({ items: [{ id: 'item-1', values: {} }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Error processing quote in Xero',
      error: 'Business not found',
    });
  });

  it('moves past the business guard once one exists for the workspace', async () => {
    const workspaceId = nextId('ws');
    await Business.create({ workspaceId, name: 'Acme Care' });

    const res = await request(app)
      .post(`/api/xero/${workspaceId}/b1/quote`)
      .send({ items: [{ id: 'item-1', values: {} }] });

    expect(res.status).toBe(200);
    expect(res.body.error).not.toBe('Business not found');
  });
});

describe('POST /api/xero/:workspaceId/:boardId/purchaseorder', () => {
  it('fails on the missing business and labels the entity as a purchase order', async () => {
    const res = await request(app)
      .post(`/api/xero/${nextId('ws')}/b1/purchaseorder`)
      .send({ items: [{ id: 'item-1', values: {} }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Error processing purchase order in Xero',
      error: 'Business not found',
    });
  });
});

describe('POST /api/xero/:workspaceId/:boardId/quotendis', () => {
  it('answers with a bare JSON string for an empty payload', async () => {
    // handleXeroQuotendis uses res.json(<string>) here rather than the
    // { message } object every other route returns.
    const res = await request(app).post('/api/xero/w1/b1/quotendis').send({});

    expect(res.status).toBe(200);
    expect(res.body).toBe('No items found in the payload.');
  });

  it('fails on the missing business when items are present', async () => {
    const res = await request(app)
      .post(`/api/xero/${nextId('ws')}/b1/quotendis`)
      .send({ items: [{ id: 'item-1', values: {} }] });

    expect(res.status).toBe(200);
    expect(res.body.error).toBe('Business not found');
  });
});

describe('POST /api/xero/:workspaceId/:boardId/invoicendis', () => {
  it('fails on the missing business and reports it as an invoice error', async () => {
    const res = await request(app)
      .post(`/api/xero/${nextId('ws')}/b1/invoicendis`)
      .send({ items: [{ id: 'item-1', values: {} }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Error processing invoice in Xero',
      error: 'Business not found',
    });
  });
});

describe('POST /api/xero/:workspaceId/:boardId/invoiceparticipanttax', () => {
  it('rejects a request with no items with 400', async () => {
    const res = await request(app).post('/api/xero/w1/b1/invoiceparticipanttax').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'No items provided for invoice generation.' });
  });

  it('rejects a request whose items carry no participant', async () => {
    const res = await request(app)
      .post('/api/xero/w1/b1/invoiceparticipanttax')
      .send({ items: [{ id: 'item-1' }] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Participant name is required.' });
  });
});

describe('POST /api/xero/:workspaceId/:boardId/invoicendis-invoice-generator', () => {
  it('answers 200 with the empty-selection error when no master items are given', async () => {
    const res = await request(app)
      .post(`/api/xero/${nextId('ws')}/b1/invoicendis-invoice-generator`)
      .send({ itemIds: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'No items provided for invoice generation.' });
  });

  it('answers 200 with an error when items are given but the workspace is not connected', async () => {
    // handleXeroInvoicendisInvoiceGenerator runs the Xero auth check and the
    // master-item lookup concurrently:
    //
    //   await Promise.all([ensureAuthenticated(...), getNdisInvoiceGeneratorContextFromMasterItems(...)])
    //
    // With an unconnected workspace AND an unknown item id both reject, and
    // Promise.all surfaces whichever loses the race — so the message is
    // genuinely non-deterministic here. It resolved to the token error locally
    // and to the item error in CI. Asserting either one specifically is a flaky
    // test, so this pins what is actually guaranteed: a 200 carrying one of the
    // two guard messages, and no request reaching Xero.
    const res = await request(app)
      .post(`/api/xero/${nextId('ws')}/b1/invoicendis-invoice-generator`)
      .send({ itemIds: ['master-1'] });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(
      /^(No Xero tokens found|Some items were not found: master-1)$/,
    );
  });
});
