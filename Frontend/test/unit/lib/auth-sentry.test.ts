import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Sentry is the one genuinely external boundary here, so it is mocked and the
 * payload the module hands it is asserted. `withScope` really runs its callback
 * so the tags applied inside it are observable.
 */
const {
  addBreadcrumb,
  captureException,
  captureMessage,
  withScope,
  setTag,
  setExtras,
  order,
} = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    addBreadcrumb: vi.fn(() => {
      order.push('addBreadcrumb');
    }),
    captureException: vi.fn(() => {
      order.push('captureException');
    }),
    captureMessage: vi.fn(() => {
      order.push('captureMessage');
    }),
    setTag: vi.fn((key: string) => {
      order.push(`setTag:${key}`);
    }),
    setExtras: vi.fn(() => {
      order.push('setExtras');
    }),
    withScope: vi.fn(),
  };
});

vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb,
  captureException,
  captureMessage,
  withScope,
}));

import {
  captureAuthFailure,
  captureAuthMessage,
  captureAuthStep,
} from '@/lib/auth-sentry';

const DSN = 'https://abc123def456@o4507.ingest.sentry.io/4508';

let scope: { setTag: typeof setTag; setExtras: typeof setExtras };

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  scope = { setTag, setExtras };
  withScope.mockImplementation((cb: (s: typeof scope) => void) => cb(scope));
  process.env.NEXT_PUBLIC_SENTRY_DSN = DSN;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
});

describe('captureAuthStep', () => {
  it('records an info breadcrumb carrying the auth method, stage and extras', () => {
    captureAuthStep(
      'oauth_ticket_exchange',
      'ticket_redeem_start',
      'Client redeeming OAuth ticket',
      { ticketPrefix: 'a1b2c3', attempt: 1 },
    );

    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'auth',
      type: 'info',
      level: 'info',
      message: 'Client redeeming OAuth ticket',
      data: {
        authMethod: 'oauth_ticket_exchange',
        stage: 'ticket_redeem_start',
        ticketPrefix: 'a1b2c3',
        attempt: 1,
      },
    });
  });

  it('records the breadcrumb with no extra data when none is passed', () => {
    captureAuthStep(
      'isoplus_oauth_redirect',
      'redirect_start',
      'Redirecting to ISO+ for authorization',
    );

    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'auth',
      type: 'info',
      level: 'info',
      message: 'Redirecting to ISO+ for authorization',
      data: { authMethod: 'isoplus_oauth_redirect', stage: 'redirect_start' },
    });
  });

  it('never captures an event, only a breadcrumb', () => {
    captureAuthStep('oauth_ticket_exchange', 'ticket_redeem_ok', 'Exchange succeeded');

    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
    expect(withScope).not.toHaveBeenCalled();
  });

  it('does nothing at all when no DSN is configured', () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;

    captureAuthStep('oauth_ticket_exchange', 'ticket_redeem_start', 'Client redeeming');

    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it('does nothing when the DSN is set to an empty string', () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = '';

    captureAuthStep('oauth_ticket_exchange', 'ticket_redeem_start', 'Client redeeming');

    expect(addBreadcrumb).not.toHaveBeenCalled();
  });
});

describe('captureAuthFailure', () => {
  it('reports an Error with the stage taken from extras, tagging the scope', () => {
    const error = new Error('Request failed with status code 409');
    error.name = 'AxiosError';

    captureAuthFailure('oauth_ticket_exchange', error, {
      stage: 'ticket_redeem',
      httpStatus: 409,
      message: 'Ticket already redeemed',
      retryable: true,
    });

    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'auth',
      type: 'error',
      level: 'error',
      message: 'Request failed with status code 409',
      data: {
        authMethod: 'oauth_ticket_exchange',
        stage: 'ticket_redeem',
        httpStatus: 409,
        message: 'Ticket already redeemed',
        retryable: true,
      },
    });

    expect(setTag).toHaveBeenCalledWith('feature', 'auth');
    expect(setTag).toHaveBeenCalledWith('auth_method', 'oauth_ticket_exchange');
    expect(setTag).toHaveBeenCalledWith('auth_stage', 'ticket_redeem');
    expect(setExtras).toHaveBeenCalledWith({
      stage: 'ticket_redeem',
      httpStatus: 409,
      message: 'Ticket already redeemed',
      retryable: true,
    });
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it('tags the scope before capturing, so the event carries the tags', () => {
    captureAuthFailure('isoplus_oauth_redirect', new Error('boom'), { stage: 'redirect' });

    expect(order).toEqual([
      'addBreadcrumb',
      'setTag:feature',
      'setTag:auth_method',
      'setTag:auth_stage',
      'setExtras',
      'captureException',
    ]);
  });

  it('falls back to the client_failure stage when extras omit one', () => {
    captureAuthFailure('isoplus_oauth_redirect', new Error('Network Error'), {
      httpStatus: 0,
    });

    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'auth',
      type: 'error',
      level: 'error',
      message: 'Network Error',
      data: {
        authMethod: 'isoplus_oauth_redirect',
        stage: 'client_failure',
        httpStatus: 0,
      },
    });
    expect(setTag).toHaveBeenCalledWith('auth_stage', 'client_failure');
  });

  it('falls back to the client_failure stage when extras are omitted entirely, and sets no extras', () => {
    captureAuthFailure('oauth_ticket_exchange', new Error('Unexpected end of JSON input'));

    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'auth',
      type: 'error',
      level: 'error',
      message: 'Unexpected end of JSON input',
      data: { authMethod: 'oauth_ticket_exchange', stage: 'client_failure' },
    });
    expect(setExtras).not.toHaveBeenCalled();
    expect(setTag).toHaveBeenCalledWith('auth_stage', 'client_failure');
  });

  it('uses the default stage for the tag but the raw extras value in the breadcrumb data when stage is not a string', () => {
    captureAuthFailure('oauth_ticket_exchange', new Error('boom'), { stage: 500 });

    expect(setTag).toHaveBeenCalledWith('auth_stage', 'client_failure');
    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'auth',
      type: 'error',
      level: 'error',
      message: 'boom',
      data: { authMethod: 'oauth_ticket_exchange', stage: 500 },
    });
  });

  it('wraps a thrown string in an Error carrying that string as its message', () => {
    captureAuthFailure('oauth_ticket_exchange', 'state_expired');

    const captured = captureException.mock.calls[0][0] as Error;
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe('state_expired');
    expect(addBreadcrumb.mock.calls[0][0]).toMatchObject({ message: 'state_expired' });
  });

  it('uses a generic message for a thrown value that is neither Error nor string', () => {
    captureAuthFailure('isoplus_oauth_redirect', { response: { status: 502 } });

    const captured = captureException.mock.calls[0][0] as Error;
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe('Authentication failure');
  });

  it('uses a generic message for null', () => {
    captureAuthFailure('isoplus_oauth_redirect', null);

    expect((captureException.mock.calls[0][0] as Error).message).toBe(
      'Authentication failure',
    );
  });

  it('does nothing at all when no DSN is configured', () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;

    captureAuthFailure('oauth_ticket_exchange', new Error('boom'), { stage: 'ticket_redeem' });

    expect(addBreadcrumb).not.toHaveBeenCalled();
    expect(withScope).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('captureAuthMessage', () => {
  it('captures the message at error level with the stage from extras', () => {
    captureAuthMessage(
      'oauth_ticket_exchange',
      'OAuth login failed: redirected with login=error',
      { stage: 'oauth_callback_redirect', reason: 'state_expired' },
    );

    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'auth',
      type: 'error',
      level: 'error',
      message: 'OAuth login failed: redirected with login=error',
      data: {
        authMethod: 'oauth_ticket_exchange',
        stage: 'oauth_callback_redirect',
        reason: 'state_expired',
      },
    });
    expect(setTag).toHaveBeenCalledWith('feature', 'auth');
    expect(setTag).toHaveBeenCalledWith('auth_method', 'oauth_ticket_exchange');
    expect(setTag).toHaveBeenCalledWith('auth_stage', 'oauth_callback_redirect');
    expect(setExtras).toHaveBeenCalledWith({
      stage: 'oauth_callback_redirect',
      reason: 'state_expired',
    });
    expect(captureMessage).toHaveBeenCalledWith(
      'OAuth login failed: redirected with login=error',
      'error',
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it('falls back to the client_message stage when extras omit one', () => {
    captureAuthMessage('isoplus_oauth_redirect', 'ISO+ returned no authorization code', {
      reason: 'missing_code',
    });

    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'auth',
      type: 'error',
      level: 'error',
      message: 'ISO+ returned no authorization code',
      data: {
        authMethod: 'isoplus_oauth_redirect',
        stage: 'client_message',
        reason: 'missing_code',
      },
    });
    expect(setTag).toHaveBeenCalledWith('auth_stage', 'client_message');
  });

  it('sets no extras on the scope when none were passed', () => {
    captureAuthMessage('isoplus_oauth_redirect', 'Sign-in security check failed');

    expect(setExtras).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith('Sign-in security check failed', 'error');
  });

  it('does nothing at all when no DSN is configured', () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;

    captureAuthMessage('oauth_ticket_exchange', 'OAuth login failed');

    expect(addBreadcrumb).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
    expect(withScope).not.toHaveBeenCalled();
  });
});
