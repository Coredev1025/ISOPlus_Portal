import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import PDFLink from '../../src/models/PDFLink.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { saveLocalFile } from '../../src/utils/localFileStore.js';

const app = createApp();

describe('PDF link routes', () => {
  it('returns 400 without workspaceId', async () => {
    const res = await request(app).get('/api/pdf-links');
    expect(res.status).toBe(400);
  });

  it('creates and lists pdf links', async () => {
    const create = await request(app).post('/api/pdf-links').send({
      itemId: 'item-1',
      workspaceId: 'ws-pdf',
      pdfLink: 'https://example.com/a.pdf',
      SignatureStatus: 'Unsigned',
      type: 'invoice',
      createdBy: 'tester',
    });
    expect(create.status).toBe(201);

    const list = await request(app).get('/api/pdf-links').query({ workspaceId: 'ws-pdf' });
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);

    const byItem = await request(app)
      .get('/api/pdf-links/item-1')
      .query({ workspaceId: 'ws-pdf' });
    expect(byItem.status).toBe(200);
    expect(byItem.body.length).toBe(1);

    const softDelete = await request(app).put('/api/pdf-links').send({
      workspaceId: 'ws-pdf',
      itemId: 'item-1',
      pdfLink: 'https://example.com/a.pdf',
    });
    expect(softDelete.status).toBe(200);
    const row = await PDFLink.findOne({ itemId: 'item-1', workspaceId: 'ws-pdf' });
    expect(row.isDeleted).toBe(true);
  });
});

/**
 * The stored `pdfLink` is a presigned S3 URL, and seven days is the longest
 * signature AWS SigV4 will issue — so every link the Automation Status panel
 * shows stopped working a week after the run that produced it, with nothing in
 * the UI to say why. This route holds the document's stable identity and mints
 * a fresh signature per request.
 */
describe('GET /api/pdf-links/download/:id', () => {
  const WS = 'ws-download';
  const KEY = 'output/ws-download/board-a/NDIS-invoices/INV-7.pdf';
  const saved = {};

  async function generatedDocument(overrides = {}) {
    return PDFLink.create({
      workspaceId: WS,
      boardId: 'board-a',
      itemId: 'item-7',
      type: 'NDIS Invoice',
      // Signed at generation time, and long expired by the time anyone clicks.
      pdfLink: `https://iso-bucket.s3.ap-southeast-2.amazonaws.com/${KEY}?X-Amz-Expires=604800&X-Amz-Signature=stale`,
      ...overrides,
    });
  }

  beforeEach(async () => {
    for (const key of ['ISOPLUS_OFFLINE', 'LOCAL_FILE_ROOT', 'JWT_SECRET', 'PERSONAL_ACCESS_TOKEN']) {
      saved[key] = process.env[key];
    }
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
    // Offline, so getS3FileUrl mints a local-files URL instead of reaching AWS.
    // The point under test is that a NEW url is minted from the stored KEY, not
    // which signer produced it.
    process.env.ISOPLUS_OFFLINE = '1';
    process.env.LOCAL_FILE_ROOT = '/tmp/pdf-link-download-test';
    await PDFLink.deleteMany({ workspaceId: WS });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('requires a session', async () => {
    const link = await generatedDocument();

    const res = await request(app).get(`/api/pdf-links/download/${link._id}`);

    expect(res.status).toBe(401);
  });

  it('redirects to a freshly signed URL built from the stored key', async () => {
    const link = await generatedDocument();
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const res = await agent.get(`/api/pdf-links/download/${link._id}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(encodeURI(KEY).replace(/\+/g, '%2B'));
    // The stale signature the row carries must not be what the client follows.
    expect(res.headers.location).not.toContain('X-Amz-Signature=stale');
  });

  // 302, not 301: the target carries a signature that expires, so a browser
  // caching this hop as permanent would break the link all over again.
  it('redirects temporarily, never permanently', async () => {
    const link = await generatedDocument();
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    expect((await agent.get(`/api/pdf-links/download/${link._id}`)).status).toBe(302);
  });

  it('404s a soft-deleted document', async () => {
    const link = await generatedDocument({ isDeleted: true });
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    expect((await agent.get(`/api/pdf-links/download/${link._id}`)).status).toBe(404);
  });

  it('404s an id that does not exist', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const res = await agent.get('/api/pdf-links/download/6a84f789c9d48680d19276c1');

    expect(res.status).toBe(404);
  });

  // A non-ObjectId would throw out of findById; answering 400 keeps a probe
  // from turning into a 500 in the logs.
  it('400s a malformed id', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    expect((await agent.get('/api/pdf-links/download/not-an-id')).status).toBe(400);
  });

  it('re-signs an offline document too', async () => {
    const link = await generatedDocument({
      pdfLink: `http://localhost:4001/api/local-files/${KEY}`,
    });
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const res = await agent.get(`/api/pdf-links/download/${link._id}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/api/local-files/');
  });
});

/**
 * Browser-side fetch(S3 URL) fails without bucket CORS. Monthly Statement and
 * Invoice Generator therefore POST the stored fileUrl here; the API streams
 * the bytes same-origin so the download attribute works without touching S3
 * CORS configuration.
 */
describe('POST /api/pdf-links/file', () => {
  const WS = 'ws-file-proxy';
  const KEY = `output/${WS}/board-a/monthly-statements/Jane_January_2026_Statement.pdf`;
  const PDF_BYTES = Buffer.from('%PDF-1.4 monthly-statement-proxy-test');
  const saved = {};
  let fileRoot;

  beforeEach(async () => {
    for (const key of ['ISOPLUS_OFFLINE', 'LOCAL_FILE_ROOT', 'JWT_SECRET', 'PERSONAL_ACCESS_TOKEN']) {
      saved[key] = process.env[key];
    }
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
    process.env.ISOPLUS_OFFLINE = '1';
    fileRoot = mkdtempSync(join(tmpdir(), 'pdf-link-file-'));
    process.env.LOCAL_FILE_ROOT = fileRoot;
    await saveLocalFile(KEY, PDF_BYTES);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fileRoot, { recursive: true, force: true });
  });

  it('requires a session', async () => {
    const res = await request(app).post('/api/pdf-links/file').send({
      fileUrl: `http://localhost:4001/api/local-files/${KEY}`,
      workspaceId: WS,
    });

    expect(res.status).toBe(401);
  });

  it('streams the PDF with an attachment disposition', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const res = await agent.post('/api/pdf-links/file').send({
      fileUrl: `http://localhost:4001/api/local-files/${encodeURI(KEY).replace(/\+/g, '%2B')}`,
      workspaceId: WS,
      filename: 'Jane_January_2026_Statement.pdf',
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toContain(
      'filename="Jane_January_2026_Statement.pdf"',
    );
    expect(Buffer.from(res.body).equals(PDF_BYTES)).toBe(true);
  });

  it('derives the filename from the object key when none is supplied', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const res = await agent.post('/api/pdf-links/file').send({
      fileUrl: `http://localhost:4001/api/local-files/${KEY}`,
      workspaceId: WS,
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(
      'filename="Jane_January_2026_Statement.pdf"',
    );
  });

  it('400s when fileUrl or workspaceId is missing', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    expect((await agent.post('/api/pdf-links/file').send({ workspaceId: WS })).status).toBe(400);
    expect((await agent.post('/api/pdf-links/file').send({
      fileUrl: `http://localhost:4001/api/local-files/${KEY}`,
    })).status).toBe(400);
  });

  it('400s when the URL key is not under the claimed workspace', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const res = await agent.post('/api/pdf-links/file').send({
      fileUrl: 'http://localhost:4001/api/local-files/output/other-ws/board/x.pdf',
      workspaceId: WS,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not belong/i);
  });

  it('404s when the object is missing', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const res = await agent.post('/api/pdf-links/file').send({
      fileUrl: `http://localhost:4001/api/local-files/output/${WS}/board-a/monthly-statements/missing.pdf`,
      workspaceId: WS,
    });

    expect(res.status).toBe(404);
  });

  // Participant Tax Invoice numbers carry "(ISO+™)". Putting that trademark
  // straight into Content-Disposition made Node throw ERR_INVALID_CHAR → 500
  // → "Download failed, opened PDF in new tab instead."
  it('streams successfully when the filename contains the ISO+ trademark', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const res = await agent.post('/api/pdf-links/file').send({
      fileUrl: `http://localhost:4001/api/local-files/${KEY}`,
      workspaceId: WS,
      filename: 'Invoice_INV-14 (ISO+™)_Jane_Smith.pdf',
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(
      'filename="Invoice_INV-14 (ISO+)_Jane_Smith.pdf"',
    );
    expect(decodeURIComponent(
      res.headers['content-disposition'].split("filename*=UTF-8''")[1],
    )).toBe('Invoice_INV-14 (ISO+™)_Jane_Smith.pdf');
    expect(Buffer.from(res.body).equals(PDF_BYTES)).toBe(true);
  });

  // Production keys encode "+" and "™" in the path (ISO%2B%E2%84%A2). The
  // proxy must decode back to the stored key or GetObject 404s.
  it('resolves a presigned-style URL whose key encodes ISO+™', async () => {
    const trademarkKey = `output/${WS}/board-a/Participant-invoices/INV-14-ISO+™-Jane-Smith.pdf`;
    await saveLocalFile(trademarkKey, PDF_BYTES);
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

    const encodedPath = trademarkKey
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const res = await agent.post('/api/pdf-links/file').send({
      fileUrl:
        `https://isoplus-portal-dev.s3.ap-southeast-2.amazonaws.com/${encodedPath}`
        + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef',
      workspaceId: WS,
      filename: 'Invoice_INV-14 (ISO+™)_Jane_Smith.pdf',
    });

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(PDF_BYTES)).toBe(true);
  });
});
