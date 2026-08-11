import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sentry is the one genuinely external collaborator here: every export exists to
// hand it a breadcrumb, a log line or an Issue. It is mocked so nothing leaves
// the process; everything asserted below (sanitizing, redaction, level mapping,
// request-metadata extraction) is the module's own logic.
const sentryMock = vi.hoisted(() => {
  const scope = {
    setTag: vi.fn(),
    setUser: vi.fn(),
    setContext: vi.fn(),
    setLevel: vi.fn(),
  };
  return {
    scope,
    isInitialized: vi.fn(() => true),
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    withScope: vi.fn((cb) => cb(scope)),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@sentry/node', () => ({
  isInitialized: sentryMock.isInitialized,
  addBreadcrumb: sentryMock.addBreadcrumb,
  captureException: sentryMock.captureException,
  captureMessage: sentryMock.captureMessage,
  withScope: sentryMock.withScope,
  logger: sentryMock.logger,
}));

const { authStep, authFailure, authSuccess } = await import('../../../src/utils/authSentry.js');

// A request as express hands it to the auth routes.
function makeReq(overrides = {}) {
  return {
    requestId: 'req_1750000000_abcdefghi',
    ip: '203.0.113.9',
    method: 'GET',
    originalUrl: '/api/auth/isoplus/callback?state=abc',
    url: '/api/auth/isoplus/callback?state=abc',
    headers: {
      'x-request-id': 'hdr-request-id',
      'x-forwarded-for': '198.51.100.7',
      'user-agent': 'Mozilla/5.0',
    },
    ...overrides,
  };
}

const lastBreadcrumb = () => sentryMock.addBreadcrumb.mock.calls.at(-1)[0];
const scopeTags = () => Object.fromEntries(sentryMock.scope.setTag.mock.calls);
const authContext = () =>
  sentryMock.scope.setContext.mock.calls.find(([name]) => name === 'auth')[1];

beforeEach(() => {
  vi.clearAllMocks();
  sentryMock.isInitialized.mockReturnValue(true);
  sentryMock.withScope.mockImplementation((cb) => cb(sentryMock.scope));
});

describe('authStep', () => {
  it('does nothing at all when Sentry is not initialized', () => {
    sentryMock.isInitialized.mockReturnValue(false);

    expect(authStep(makeReq(), { authMethod: 'credentials', stage: 'start' })).toBeUndefined();
    expect(sentryMock.addBreadcrumb).not.toHaveBeenCalled();
    expect(sentryMock.logger.info).not.toHaveBeenCalled();
  });

  it('records an info breadcrumb carrying the request metadata and caller data', () => {
    authStep(makeReq(), {
      authMethod: 'isoplus_oauth',
      stage: 'callback_received',
      message: 'ISO+ callback received',
      data: { workspaceId: 'ws-7f3a', ticketId: 'tkt-1' },
      email: 'carer@example.com',
      userId: 42,
    });

    expect(lastBreadcrumb()).toEqual({
      category: 'auth',
      type: 'info',
      level: 'info',
      message: 'ISO+ callback received',
      data: {
        feature: 'auth',
        authMethod: 'isoplus_oauth',
        stage: 'callback_received',
        email: 'carer@example.com',
        userId: 42,
        requestId: 'req_1750000000_abcdefghi',
        ip: '203.0.113.9',
        httpMethod: 'GET',
        path: '/api/auth/isoplus/callback?state=abc',
        workspaceId: 'ws-7f3a',
        ticketId: 'tkt-1',
      },
    });
  });

  it('logs the same body through the Sentry logger', () => {
    authStep(makeReq(), {
      authMethod: 'credentials',
      stage: 'verify_password',
      message: 'Password verified',
    });

    expect(sentryMock.logger.info).toHaveBeenCalledTimes(1);
    const [message, body] = sentryMock.logger.info.mock.calls[0];
    expect(message).toBe('Password verified');
    expect(body).toEqual(lastBreadcrumb().data);
  });

  it('derives a default breadcrumb message and a different default log message', () => {
    authStep(makeReq(), { authMethod: 'credentials', stage: 'verify_password' });

    expect(lastBreadcrumb().message).toBe('credentials:verify_password');
    expect(sentryMock.logger.info.mock.calls[0][0]).toBe('auth step: credentials / verify_password');
  });

  it('tolerates being called with no arguments at all', () => {
    authStep();

    expect(lastBreadcrumb()).toEqual({
      category: 'auth',
      type: 'info',
      level: 'info',
      message: 'undefined:undefined',
      data: { feature: 'auth' },
    });
    expect(sentryMock.logger.info.mock.calls[0][0]).toBe('auth step: undefined / undefined');
  });

  it('falls back to the proxy headers and req.url for request metadata', () => {
    const req = makeReq();
    delete req.requestId;
    delete req.ip;
    delete req.originalUrl;
    req.method = 'POST';

    authStep(req, { authMethod: 'credentials', stage: 'start' });

    expect(lastBreadcrumb().data).toMatchObject({
      requestId: 'hdr-request-id',
      ip: '198.51.100.7',
      httpMethod: 'POST',
      path: '/api/auth/isoplus/callback?state=abc',
    });
  });

  it('emits no request metadata when there is no usable request object', () => {
    authStep(null, { authMethod: 'credentials', stage: 'start' });

    expect(lastBreadcrumb().data).toEqual({
      feature: 'auth',
      authMethod: 'credentials',
      stage: 'start',
    });

    authStep('not-a-request', { authMethod: 'credentials', stage: 'start' });

    expect(lastBreadcrumb().data).toEqual({
      feature: 'auth',
      authMethod: 'credentials',
      stage: 'start',
    });
  });

  it('leaves the metadata keys undefined when the request carries none of them', () => {
    authStep({}, { authMethod: 'credentials', stage: 'start' });

    const { data } = lastBreadcrumb();
    expect(data.requestId).toBeUndefined();
    expect(data.ip).toBeUndefined();
    expect(data.httpMethod).toBeUndefined();
    expect(data.path).toBeUndefined();
  });
});

describe('authStep — secret redaction', () => {
  const REDACTED_KEYS = [
    'password',
    'pass',
    'token',
    'access_token',
    'accessToken',
    'refresh_token',
    'authorization',
    'client_secret',
    'clientSecret',
    'cookie',
    'cookies',
    'session',
    'jwt',
    'secret',
    'ticket',
    'code',
  ];

  it('redacts every field name it treats as a secret', () => {
    const SENTINEL = 'SUPER-SECRET-VALUE-do-not-log';
    const data = Object.fromEntries(REDACTED_KEYS.map((key) => [key, SENTINEL]));
    data.workspaceId = 'ws-7f3a';

    authStep(makeReq(), { authMethod: 'isoplus_oauth', stage: 'exchange', data });

    const body = lastBreadcrumb().data;
    for (const key of REDACTED_KEYS) {
      expect(body[key]).toBe('[REDACTED]');
    }
    expect(body.workspaceId).toBe('ws-7f3a');
    expect(JSON.stringify(lastBreadcrumb())).not.toContain(SENTINEL);
    expect(JSON.stringify(sentryMock.logger.info.mock.calls)).not.toContain(SENTINEL);
  });

  it('redacts secrets nested inside objects and arrays', () => {
    const SENTINEL = 'NESTED-SECRET-VALUE';

    authStep(makeReq(), {
      authMethod: 'isoplus_oauth',
      stage: 'exchange',
      data: {
        upstream: { headers: { authorization: `Bearer ${SENTINEL}`, accept: 'application/json' } },
        attempts: [{ token: SENTINEL, ok: false }],
      },
    });

    const body = lastBreadcrumb().data;
    expect(body.upstream.headers.authorization).toBe('[REDACTED]');
    expect(body.upstream.headers.accept).toBe('application/json');
    expect(body.attempts[0]).toEqual({ token: '[REDACTED]', ok: false });
    expect(JSON.stringify(lastBreadcrumb())).not.toContain(SENTINEL);
  });

  it('redacts case variants that lower-case onto a listed key', () => {
    const SENTINEL = 'CASE-VARIANT-SECRET';

    authStep(makeReq(), {
      authMethod: 'credentials',
      stage: 'login',
      data: { Password: SENTINEL, AUTHORIZATION: SENTINEL, Cookie: SENTINEL, REFRESH_TOKEN: SENTINEL },
    });

    const body = lastBreadcrumb().data;
    expect(body.Password).toBe('[REDACTED]');
    expect(body.AUTHORIZATION).toBe('[REDACTED]');
    expect(body.Cookie).toBe('[REDACTED]');
    expect(body.REFRESH_TOKEN).toBe('[REDACTED]');
  });

  it('does NOT redact camelCase keys whose lower-cased form is not listed', () => {
    // Documents a real gap: only the exact key or its lower-cased form is
    // matched, and "accesstoken" / "clientsecret" are not in the deny list.
    authStep(makeReq(), {
      authMethod: 'isoplus_oauth',
      stage: 'exchange',
      data: { AccessToken: 'leaked-access-token', ClientSecret: 'leaked-client-secret' },
    });

    const body = lastBreadcrumb().data;
    expect(body.AccessToken).toBe('leaked-access-token');
    expect(body.ClientSecret).toBe('leaked-client-secret');
  });

  it('does NOT redact an OAuth code embedded in the request path', () => {
    // requestMeta().path is a plain string, so it is truncated but never scrubbed.
    authStep(makeReq({ originalUrl: '/api/auth/isoplus/callback?code=oauth-code-123&state=s' }), {
      authMethod: 'isoplus_oauth',
      stage: 'callback_received',
    });

    expect(lastBreadcrumb().data.path).toBe(
      '/api/auth/isoplus/callback?code=oauth-code-123&state=s',
    );
  });
});

describe('authStep — value sanitizing', () => {
  it('truncates strings longer than 500 characters', () => {
    authStep(makeReq(), {
      authMethod: 'credentials',
      stage: 'start',
      data: { note: 'a'.repeat(600) },
    });

    expect(lastBreadcrumb().data.note).toBe(`${'a'.repeat(500)}…`);
    expect(lastBreadcrumb().data.note).toHaveLength(501);
  });

  it('leaves a string of exactly 500 characters alone', () => {
    authStep(makeReq(), {
      authMethod: 'credentials',
      stage: 'start',
      data: { note: 'b'.repeat(500) },
    });

    expect(lastBreadcrumb().data.note).toBe('b'.repeat(500));
  });

  it('keeps only the first 20 array elements', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);

    authStep(makeReq(), { authMethod: 'credentials', stage: 'start', data: { ids } });

    const sanitized = lastBreadcrumb().data.ids;
    expect(sanitized).toHaveLength(20);
    expect(sanitized[0]).toBe('id-0');
    expect(sanitized[19]).toBe('id-19');
  });

  it('cuts nesting off past depth 3', () => {
    authStep(makeReq(), {
      authMethod: 'credentials',
      stage: 'start',
      data: { l1: { l2: { l3: { l4: 'too deep' } } } },
    });

    expect(lastBreadcrumb().data.l1.l2.l3.l4).toBe('[Max depth]');
  });

  it('reduces an Error to name, message and code, dropping the stack', () => {
    const err = new TypeError('upstream refused the connection');
    err.code = 'ECONNREFUSED';

    authStep(makeReq(), { authMethod: 'isoplus_oauth', stage: 'exchange', data: { cause: err } });

    expect(lastBreadcrumb().data.cause).toEqual({
      name: 'TypeError',
      message: 'upstream refused the connection',
      code: 'ECONNREFUSED',
    });
  });

  it('preserves numbers, booleans and null, and stringifies exotic values', () => {
    authStep(makeReq(), {
      authMethod: 'credentials',
      stage: 'start',
      data: { attempt: 3, locked: false, lastSeen: null, sizeBytes: 90071992547409n },
    });

    expect(lastBreadcrumb().data).toMatchObject({
      attempt: 3,
      locked: false,
      lastSeen: null,
      sizeBytes: '90071992547409',
    });
  });
});

describe('authSuccess', () => {
  it('records a success-stage breadcrumb with a derived message and no Issue', () => {
    authSuccess(makeReq(), {
      authMethod: 'credentials',
      data: { role: 'support_admin' },
      email: 'admin@example.com',
      userId: 'usr-1',
    });

    expect(lastBreadcrumb()).toEqual({
      category: 'auth',
      type: 'info',
      level: 'info',
      message: 'Auth success: credentials',
      data: {
        feature: 'auth',
        authMethod: 'credentials',
        stage: 'success',
        email: 'admin@example.com',
        userId: 'usr-1',
        requestId: 'req_1750000000_abcdefghi',
        ip: '203.0.113.9',
        httpMethod: 'GET',
        path: '/api/auth/isoplus/callback?state=abc',
        role: 'support_admin',
      },
    });
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    expect(sentryMock.withScope).not.toHaveBeenCalled();
  });

  it('keeps a caller-supplied message', () => {
    authSuccess(makeReq(), { authMethod: 'isoplus_oauth', message: 'Signed in via ISO+' });

    expect(lastBreadcrumb().message).toBe('Signed in via ISO+');
    expect(sentryMock.logger.info.mock.calls[0][0]).toBe('Signed in via ISO+');
  });

  it('does nothing when Sentry is not initialized', () => {
    sentryMock.isInitialized.mockReturnValue(false);

    authSuccess(makeReq(), { authMethod: 'credentials' });

    expect(sentryMock.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('tolerates being called with no arguments', () => {
    authSuccess();

    expect(lastBreadcrumb().message).toBe('Auth success: undefined');
    expect(lastBreadcrumb().data.stage).toBe('success');
  });
});

describe('authFailure', () => {
  it('does nothing when Sentry is not initialized', () => {
    sentryMock.isInitialized.mockReturnValue(false);

    expect(authFailure(makeReq(), { authMethod: 'credentials', stage: 'login' })).toBeUndefined();
    expect(sentryMock.addBreadcrumb).not.toHaveBeenCalled();
    expect(sentryMock.withScope).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });

  it('records an error breadcrumb combining the payload and the request metadata', () => {
    authFailure(makeReq(), {
      authMethod: 'credentials',
      stage: 'verify_password',
      message: 'Invalid credentials',
      reason: 'password_mismatch',
      httpStatus: 401,
      data: { attempts: 3 },
      email: 'carer@example.com',
      userId: 'usr-1',
    });

    expect(lastBreadcrumb()).toEqual({
      category: 'auth',
      type: 'error',
      level: 'error',
      message: 'Invalid credentials',
      data: {
        authMethod: 'credentials',
        stage: 'verify_password',
        attempts: 3,
        reason: 'password_mismatch',
        httpStatus: 401,
        upstreamStatus: undefined,
        email: 'carer@example.com',
        userId: 'usr-1',
        requestId: 'req_1750000000_abcdefghi',
        ip: '203.0.113.9',
        httpMethod: 'GET',
        path: '/api/auth/isoplus/callback?state=abc',
      },
    });
  });

  it('falls back to the message when no reason is supplied', () => {
    authFailure(makeReq(), {
      authMethod: 'credentials',
      stage: 'login',
      message: 'User not found',
    });

    expect(lastBreadcrumb().data.reason).toBe('User not found');
  });

  it('logs at warn for the default level and at error for error/fatal', () => {
    authFailure(makeReq(), { authMethod: 'credentials', stage: 'login', message: 'soft failure' });
    expect(sentryMock.logger.warn).toHaveBeenCalledTimes(1);
    expect(sentryMock.logger.error).not.toHaveBeenCalled();

    authFailure(makeReq(), {
      authMethod: 'credentials',
      stage: 'login',
      message: 'hard failure',
      level: 'error',
    });
    expect(sentryMock.logger.error).toHaveBeenCalledTimes(1);

    authFailure(makeReq(), {
      authMethod: 'credentials',
      stage: 'login',
      message: 'fatal failure',
      level: 'fatal',
    });
    expect(sentryMock.logger.error).toHaveBeenCalledTimes(2);
    expect(sentryMock.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs at warn for an informational level, because only error/fatal escalate', () => {
    authFailure(makeReq(), {
      authMethod: 'credentials',
      stage: 'login',
      message: 'noteworthy',
      level: 'info',
    });

    expect(sentryMock.logger.warn).toHaveBeenCalledTimes(1);
    expect(sentryMock.logger.error).not.toHaveBeenCalled();
  });

  it('sends the log attributes with the feature, method, stage, request meta and payload', () => {
    authFailure(makeReq(), {
      authMethod: 'isoplus_oauth',
      stage: 'token_exchange',
      message: 'ISO+ token exchange failed',
      upstreamStatus: 502,
      data: { endpoint: '/oauth/token' },
    });

    const [message, attrs] = sentryMock.logger.warn.mock.calls[0];
    expect(message).toBe('ISO+ token exchange failed');
    expect(attrs).toEqual({
      feature: 'auth',
      authMethod: 'isoplus_oauth',
      stage: 'token_exchange',
      requestId: 'req_1750000000_abcdefghi',
      ip: '203.0.113.9',
      httpMethod: 'GET',
      path: '/api/auth/isoplus/callback?state=abc',
      endpoint: '/oauth/token',
      reason: 'ISO+ token exchange failed',
      httpStatus: undefined,
      upstreamStatus: 502,
      email: undefined,
      userId: undefined,
    });
  });

  it('tags the scope with the auth feature, method, stage, request id and statuses', () => {
    authFailure(makeReq(), {
      authMethod: 'isoplus_oauth',
      stage: 'token_exchange',
      message: 'ISO+ token exchange failed',
      httpStatus: 401,
      upstreamStatus: 502,
    });

    expect(scopeTags()).toEqual({
      feature: 'auth',
      auth_method: 'isoplus_oauth',
      auth_stage: 'token_exchange',
      request_id: 'req_1750000000_abcdefghi',
      http_status: '401',
      upstream_status: '502',
    });
  });

  it('tags a zero http status rather than skipping it', () => {
    authFailure(makeReq(), { authMethod: 'credentials', stage: 'login', httpStatus: 0, upstreamStatus: 0 });

    expect(scopeTags().http_status).toBe('0');
    expect(scopeTags().upstream_status).toBe('0');
  });

  it('omits the optional tags when their values are absent', () => {
    authFailure(makeReq({ requestId: undefined, headers: {} }), { message: 'no context at all' });

    expect(scopeTags()).toEqual({ feature: 'auth' });
  });

  it('sets the Sentry user from the email, id and client ip', () => {
    authFailure(makeReq(), {
      authMethod: 'credentials',
      stage: 'login',
      email: 'carer@example.com',
      userId: 77,
    });

    expect(sentryMock.scope.setUser).toHaveBeenCalledWith({
      id: '77',
      email: 'carer@example.com',
      ip_address: '203.0.113.9',
    });
  });

  it('sets the Sentry user from an email alone', () => {
    authFailure(makeReq(), { authMethod: 'credentials', stage: 'login', email: 'carer@example.com' });

    expect(sentryMock.scope.setUser).toHaveBeenCalledWith({
      id: undefined,
      email: 'carer@example.com',
      ip_address: '203.0.113.9',
    });
  });

  it('sets the Sentry user from a user id alone', () => {
    authFailure(makeReq(), { authMethod: 'credentials', stage: 'login', userId: 'usr-1' });

    expect(sentryMock.scope.setUser).toHaveBeenCalledWith({
      id: 'usr-1',
      email: undefined,
      ip_address: '203.0.113.9',
    });
  });

  it('does not set a user when neither an email nor a user id is known', () => {
    authFailure(makeReq(), { authMethod: 'credentials', stage: 'login' });

    expect(sentryMock.scope.setUser).not.toHaveBeenCalled();
  });

  it('attaches an auth context built from the method, stage, request meta and payload', () => {
    authFailure(makeReq(), {
      authMethod: 'credentials',
      stage: 'verify_password',
      message: 'Invalid credentials',
      httpStatus: 401,
      data: { attempts: 3, password: 'hunter2' },
    });

    expect(authContext()).toEqual({
      authMethod: 'credentials',
      stage: 'verify_password',
      requestId: 'req_1750000000_abcdefghi',
      ip: '203.0.113.9',
      httpMethod: 'GET',
      path: '/api/auth/isoplus/callback?state=abc',
      attempts: 3,
      password: '[REDACTED]',
      reason: 'Invalid credentials',
      httpStatus: 401,
      upstreamStatus: undefined,
      email: undefined,
      userId: undefined,
    });
  });

  it('captures the exception when an Error is supplied', () => {
    const err = new Error('getaddrinfo ENOTFOUND app.isoplus.online');

    authFailure(makeReq(), {
      authMethod: 'isoplus_oauth',
      stage: 'token_exchange',
      message: 'ISO+ unreachable',
      error: err,
    });

    expect(sentryMock.captureException).toHaveBeenCalledWith(err);
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });

  it('captures a message when the error is not an Error instance', () => {
    authFailure(makeReq(), {
      authMethod: 'isoplus_oauth',
      stage: 'token_exchange',
      message: 'ISO+ returned 502',
      error: { status: 502, body: 'Bad Gateway' },
    });

    expect(sentryMock.captureMessage).toHaveBeenCalledWith('ISO+ returned 502', 'warning');
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it('derives the captured message when none is supplied', () => {
    authFailure(makeReq(), { authMethod: 'credentials', stage: 'verify_password' });

    expect(sentryMock.captureMessage).toHaveBeenCalledWith(
      'Auth failure: credentials/verify_password',
      'warning',
    );
  });

  it('maps every level onto a Sentry issue level', () => {
    const cases = [
      [undefined, 'warning'],
      ['warning', 'warning'],
      ['warn', 'warning'],
      ['error', 'error'],
      ['fatal', 'fatal'],
      ['info', 'info'],
      ['debug', 'debug'],
      ['nonsense', 'warning'],
    ];

    for (const [level, expected] of cases) {
      vi.clearAllMocks();
      sentryMock.isInitialized.mockReturnValue(true);
      sentryMock.withScope.mockImplementation((cb) => cb(sentryMock.scope));

      authFailure(makeReq(), { authMethod: 'credentials', stage: 'login', message: 'm', level });

      expect(sentryMock.scope.setLevel).toHaveBeenCalledWith(expected);
      expect(sentryMock.captureMessage).toHaveBeenCalledWith('m', expected);
    }
  });

  it('tolerates being called with no arguments', () => {
    authFailure();

    expect(lastBreadcrumb().message).toBe('undefined:undefined');
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(
      'Auth failure: undefined/undefined',
      'warning',
    );
  });

  it('leaves the request metadata in the breadcrumb unsanitized', () => {
    // The breadcrumb spreads requestMeta(req) after the sanitized payload, so a
    // very long path is truncated in the log attributes but not the breadcrumb.
    const longPath = `/api/auth/callback?state=${'s'.repeat(600)}`;

    authFailure(makeReq({ originalUrl: longPath }), {
      authMethod: 'isoplus_oauth',
      stage: 'callback_received',
      message: 'state too long',
    });

    expect(lastBreadcrumb().data.path).toBe(longPath);
    expect(lastBreadcrumb().data.path).toHaveLength(625);
  });
});
