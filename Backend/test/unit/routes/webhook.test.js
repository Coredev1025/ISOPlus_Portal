import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import Business from '../../../src/models/Business.js';

/**
 * src/routes/webhook.js, mounted at /api/pdf. ISO+ automations post here, so
 * the routes are unauthenticated and — for the PDF-generating ones — answer 200
 * even for failures so the automation does not retry forever. These tests pin
 * the two guards every PDF route shares (a payload with items, and a Business
 * record for the workspace) and the places where a route deviates from that
 * shape, which is where a regression would actually change behaviour.
 *
 * Nothing here renders a PDF or touches S3: each case stops at a guard.
 * test/integration/webhooks.route.test.js already covers the empty payload on
 * /invoice, so that one case is not repeated.
 */

const app = createApp();

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const PDF_ROUTES = [
  'purchaseorder',
  'quote',
  'quotendis',
  'invoicendis',
  'invoicendis-invoice-generator',
];

const ORIGINAL_AWS = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION,
  AWS_BUCKET_PUBLIC: process.env.AWS_BUCKET_PUBLIC,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_AWS)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('PDF routes reject a payload with no items', () => {
  it.each(PDF_ROUTES)('answers 200 with the payload message for /%s', async (route) => {
    const res = await request(app).post(`/api/pdf/w1/b1/${route}`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'No items found in the payload' });
  });

  it('also rejects an items key that is not an array', async () => {
    const res = await request(app)
      .post('/api/pdf/w1/b1/quote')
      .send({ items: { id: 'i1' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'No items found in the payload' });
  });

  it('also rejects an empty items array', async () => {
    const res = await request(app).post('/api/pdf/w1/b1/quote').send({ items: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'No items found in the payload' });
  });
});

describe('PDF routes require a Business record for the workspace', () => {
  it.each(['invoice', ...PDF_ROUTES])(
    'answers 200 with "Business not found" for /%s',
    async (route) => {
      const res = await request(app)
        .post(`/api/pdf/${nextId('ws')}/b1/${route}`)
        .send({ items: [{ id: 'item-1', values: {} }] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Business not found' });
    }
  );

  it('looks the business up by workspaceId, not boardId', async () => {
    const workspaceId = nextId('ws');
    await Business.create({ workspaceId, name: 'Acme Care' });

    const res = await request(app)
      .post(`/api/pdf/${workspaceId}/b1/quote`)
      .send({ items: [{ id: 'item-1', values: {} }] });

    // The business guard is now satisfied, so the response is no longer the
    // guard message — the route has moved on into item processing.
    expect(res.body.message).not.toBe('Business not found');
  });
});

describe('POST /api/pdf/:workspaceId/:boardId/invoiceparticipanttax', () => {
  it('answers 500, not 200, when the payload has no items', async () => {
    // validateRequestParams runs outside the helper's own try/catch, so its
    // error reaches the route's catch, which uses 500 rather than the 200 the
    // other PDF routes use.
    const res = await request(app).post('/api/pdf/w1/b1/invoiceparticipanttax').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'No items found in the payload' });
  });

  it('answers 500 when the workspace has no business', async () => {
    const res = await request(app)
      .post(`/api/pdf/${nextId('ws')}/b1/invoiceparticipanttax`)
      .send({ items: [{ id: 'item-1' }] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Business not found' });
  });
});

describe('POST /api/pdf/:workspaceId/:boardId/monthly-statement', () => {
  it('rejects a body with no statementData before looking at items', async () => {
    const res = await request(app).post('/api/pdf/w1/b1/monthly-statement').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'No statement data provided.' });
  });

  it('still rejects when items are present but statementData is not', async () => {
    const res = await request(app)
      .post('/api/pdf/w1/b1/monthly-statement')
      .send({ items: [{ id: 'item-1' }] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'No statement data provided.' });
  });
});

describe('GET /api/pdf/uploads/:filename', () => {
  it('redirects to the public bucket URL for the pdfs/ prefix', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    process.env.AWS_REGION = 'ap-southeast-2';
    process.env.AWS_BUCKET_PUBLIC = 'isoplus-public-test';

    const res = await request(app).get('/api/pdf/uploads/invoice-42.pdf');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'https://isoplus-public-test.s3.ap-southeast-2.amazonaws.com/pdfs/invoice-42.pdf'
    );
  });

  it('percent-encodes a plus sign in the filename', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    process.env.AWS_REGION = 'ap-southeast-2';
    process.env.AWS_BUCKET_PUBLIC = 'isoplus-public-test';

    const res = await request(app).get('/api/pdf/uploads/invoice%2B1.pdf');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'https://isoplus-public-test.s3.ap-southeast-2.amazonaws.com/pdfs/invoice%2B1.pdf'
    );
  });

  it('answers 404 when the public bucket is not configured', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    process.env.AWS_REGION = 'ap-southeast-2';
    delete process.env.AWS_BUCKET_PUBLIC;

    const res = await request(app).get('/api/pdf/uploads/invoice-42.pdf');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'File not found in ISO+™ Portal.' });
  });
});
