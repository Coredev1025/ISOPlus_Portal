import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

/**
 * createApp() reads the environment on every call, so each test builds its own
 * app rather than sharing one. The assertions exercise the wiring the factory
 * owns — security headers, the CORS allow-list, body limits, sanitisation,
 * session cookie flags and the route mount points — through real HTTP requests.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.NODE_ENV = 'test';
});

describe('createApp security posture', () => {
  it('does not advertise Express in the response headers', async () => {
    const res = await request(createApp()).get('/api/healthcheck');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('disables ETag generation on the application', () => {
    expect(createApp().get('etag')).toBe(false);
  });

  it('still sends an ETag from the healthcheck router, which is its own express() app', async () => {
    // routes/heathcheck.js calls express() rather than express.Router(), so it
    // is a sub-application with its own settings and does not inherit the
    // parent's etag: false. Documents current behaviour.
    const res = await request(createApp()).get('/api/healthcheck');
    expect(res.headers.etag).toMatch(/^W\//);
  });

  it('answers /favicon.ico with 204 and no body', async () => {
    const res = await request(createApp()).get('/favicon.ico');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });
});

describe('createApp cache headers', () => {
  it('marks every /api response as uncacheable', async () => {
    const res = await request(createApp()).get('/api/healthcheck');

    expect(res.headers['cache-control'])
      .toBe('no-store, no-cache, must-revalidate, proxy-revalidate');
    expect(res.headers.pragma).toBe('no-cache');
    expect(res.headers.expires).toBe('0');
    expect(res.headers['surrogate-control']).toBe('no-store');
  });

  it('does not apply the no-store headers outside /api', async () => {
    const res = await request(createApp()).get('/favicon.ico');
    expect(res.headers['surrogate-control']).toBeUndefined();
  });
});

describe('createApp CORS allow-list', () => {
  it('defaults to http://localhost:3000 when ALLOWED_ORIGINS is unset', async () => {
    delete process.env.ALLOWED_ORIGINS;
    const app = createApp();

    const allowed = await request(app)
      .get('/api/healthcheck')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const rejected = await request(app)
      .get('/api/healthcheck')
      .set('Origin', 'http://evil.example.com');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reads a comma-separated allow-list', async () => {
    process.env.ALLOWED_ORIGINS = 'https://a.example.com,https://b.example.com';
    const app = createApp();

    for (const origin of ['https://a.example.com', 'https://b.example.com']) {
      const res = await request(app).get('/api/healthcheck').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('reads a whitespace-separated allow-list', async () => {
    process.env.ALLOWED_ORIGINS = 'https://a.example.com https://b.example.com';
    const res = await request(createApp())
      .get('/api/healthcheck')
      .set('Origin', 'https://b.example.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://b.example.com');
  });

  it('ignores blank entries produced by a trailing separator', async () => {
    process.env.ALLOWED_ORIGINS = 'https://a.example.com, ,';
    const app = createApp();

    const allowed = await request(app)
      .get('/api/healthcheck')
      .set('Origin', 'https://a.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://a.example.com');

    const empty = await request(app).get('/api/healthcheck').set('Origin', '');
    expect(empty.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows credentials, which the session cookie depends on', async () => {
    process.env.ALLOWED_ORIGINS = 'https://a.example.com';
    const res = await request(createApp())
      .get('/api/healthcheck')
      .set('Origin', 'https://a.example.com');

    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('answers a preflight with 200 and the permitted methods and headers', async () => {
    process.env.ALLOWED_ORIGINS = 'https://a.example.com';
    const res = await request(createApp())
      .options('/api/healthcheck')
      .set('Origin', 'https://a.example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-methods'])
      .toBe('GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe(
      'Content-Type,Authorization,Accept,X-API-Version,X-Request-Id,X-User-Action,X-App-Action,X-Audit-Action',
    );
  });

  it('permits the audit action headers the frontend sends', async () => {
    process.env.ALLOWED_ORIGINS = 'https://a.example.com';
    const res = await request(createApp())
      .options('/api/healthcheck')
      .set('Origin', 'https://a.example.com')
      .set('Access-Control-Request-Method', 'POST');

    const allowed = res.headers['access-control-allow-headers'].split(',');
    expect(allowed).toContain('X-User-Action');
    expect(allowed).toContain('X-App-Action');
    expect(allowed).toContain('X-Audit-Action');
  });
});

describe('createApp request body handling', () => {
  it('parses a JSON body', async () => {
    const res = await request(createApp())
      .post('/api/log')
      .send({ level: 'info', message: 'hello' });

    // The route may reject the payload, but never with a body-parse failure.
    expect(res.status).not.toBe(400);
  });

  it('rejects a JSON body over the 2 MB limit', async () => {
    const oversized = { note: 'x'.repeat(2 * 1024 * 1024 + 1024) };
    const res = await request(createApp())
      .post('/api/log')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(oversized));

    expect(res.status).toBe(413);
  });

  it('accepts a JSON body just under the 2 MB limit', async () => {
    const nearLimit = { note: 'x'.repeat(1.9 * 1024 * 1024) };
    const res = await request(createApp())
      .post('/api/log')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(nearLimit));

    expect(res.status).not.toBe(413);
  });

  it('accepts a urlencoded body', async () => {
    const res = await request(createApp())
      .post('/api/log')
      .type('form')
      .send('level=info&message=hello');

    expect(res.status).not.toBe(415);
  });
});

describe('createApp route mounting', () => {
  /**
   * The mount prefixes are this file's public contract with the frontend: a
   * typo in one ('/api/pdf-link' for '/api/pdf-links') breaks a page while
   * every router's own tests stay green. Reading them back off the router
   * stack is the only way to assert the whole table, since most routers
   * answer an unauthenticated GET / with the same 404 as an unmounted path.
   */
  function mountedPrefixes(app) {
    const router = app._router || app.router;
    return router.stack
      .filter((layer) => layer.name === 'router' || layer.name === 'mounted_app')
      .map((layer) => layer.regexp.source
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\\\//g, '/'));
  }

  it('mounts every router at its documented prefix, in order', () => {
    expect(mountedPrefixes(createApp())).toEqual([
      '/api/healthcheck',
      '/api/auth',
      '/api/automation',
      '/api/business',
      '/api/workspaces',
      '/api/boards',
      '/api/timetracks',
      '/api/xero',
      '/api/log',
      '/api/pdf',
      '/api/webhooks',
      '/api/audit',
      '/api/pdf-links',
      '/api/care-management-ndis-pricing',
      '/api/age-care',
      '/api/sync',
      '/api/items',
      '/api/export',
      '/api/subscriptions',
      '/api/scheduler',
      '/api/local-files',
      '/api/system-health',
    ]);
  });

  it('mounts the webhook routers on distinct prefixes', () => {
    const prefixes = mountedPrefixes(createApp());
    expect(prefixes.filter((p) => p === '/api/pdf')).toHaveLength(1);
    expect(prefixes.filter((p) => p === '/api/webhooks')).toHaveLength(1);
  });

  it('404s an unmounted api path', async () => {
    const res = await request(createApp()).get('/api/not-a-real-router');
    expect(res.status).toBe(404);
  });

  it('serves the healthcheck payload the deployment probe expects', async () => {
    const res = await request(createApp()).get('/api/healthcheck');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'OK' });
  });
});

describe('createApp session cookie', () => {
  it('does not issue a session cookie for a request that stores nothing', async () => {
    const res = await request(createApp()).get('/api/healthcheck');

    // saveUninitialized: false — an anonymous read must not mint a session.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('builds without a Mongo-backed store under NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/never-connected';

    expect(() => createApp()).not.toThrow();
  });
});

describe('createApp request context', () => {
  it('echoes back the request id the caller supplied', async () => {
    const res = await request(createApp())
      .get('/api/healthcheck')
      .set('X-Request-Id', 'req-abc-123');

    expect(res.headers['x-request-id']).toBe('req-abc-123');
  });

  it('generates a request id when the caller supplies none', async () => {
    const res = await request(createApp()).get('/api/healthcheck');

    expect(res.headers['x-request-id']).toMatch(/.+/);
  });
});
