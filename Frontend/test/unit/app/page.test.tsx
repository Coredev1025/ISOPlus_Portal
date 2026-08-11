import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';
import { ContextProvider } from '@/app/context';
import { installBrowserStubs, makeRouter, SUPPORT_ADMIN } from './page-test-utils';
import LoginPage from '@/app/page';
import { dismissAllToasts } from '@/lib/toast-utils';

/**
 * The login page owns two ways in: the ISO+ OAuth redirect and the support
 * agent's email/password form. It also verifies any existing session on mount
 * and bounces an already-signed-in user to the dashboard. These tests pin both
 * entry points, what is actually sent to the login endpoint, what happens on a
 * rejected credential, and the in-flight lockout.
 */

installBrowserStubs();

const router = makeRouter();

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

/** Credentials posted to /api/auth/login, in order. */
let loginBodies: Array<Record<string, unknown>> = [];
/** Where the page tried to send the browser (jsdom refuses real navigation). */
let assignedHref: string | undefined;

function stubSession(user: Record<string, unknown> | null) {
  server.use(
    http.get('*/api/auth/verify', () =>
      user
        ? HttpResponse.json({ user })
        : HttpResponse.json({ message: 'Authentication required' }, { status: 401 }),
    ),
  );
}

function stubLogin(
  options: { status?: number; message?: string; gate?: Promise<void> } = {},
) {
  server.use(
    http.post('*/api/auth/login', async ({ request }) => {
      loginBodies.push((await request.json()) as Record<string, unknown>);
      if (options.gate) await options.gate;
      if (options.status && options.status !== 200) {
        return HttpResponse.json(
          { message: options.message ?? 'Invalid credentials' },
          { status: options.status },
        );
      }
      return HttpResponse.json({ user: SUPPORT_ADMIN });
    }),
  );
}

function renderPage() {
  return render(
    <ContextProvider>
      <LoginPage />
    </ContextProvider>,
  );
}

/** The support form only appears after the mount-time session check settles. */
async function openSupportForm(user: ReturnType<typeof userEvent.setup>) {
  const toggle = await screen.findByRole('button', {
    name: 'Support agent sign-in',
  });
  await waitFor(() => expect(toggle).toBeEnabled());
  await user.click(toggle);
  return {
    email: screen.getByLabelText('Email'),
    password: screen.getByLabelText('Password'),
    submit: screen.getByRole('button', { name: /Login as Support Agent/ }),
  };
}

beforeEach(() => {
  localStorage.clear();
  loginBodies = [];
  assignedHref = undefined;
  router.push.mockClear();
  router.replace.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubSession(null);

  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...window.location,
      set href(value: string) {
        assignedHref = value;
      },
      get href() {
        return assignedHref ?? 'http://localhost/';
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.querySelectorAll('.toastify').forEach((node) => node.remove());
});


// Removing the toastify nodes does not cancel the dismiss timer toastify-js
// schedules for each one. When that timer fires after jsdom has been torn down
// it throws `ReferenceError: document is not defined` as an unhandled error,
// failing the run even though every assertion passed. Dismissing through the
// app's own API clears the timers too.
afterEach(() => {
  dismissAllToasts();
});

describe('Login page', () => {
  it('offers the ISO+ sign-in and the support agent path side by side', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'ISO+™ Portal' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign in with ISO+™' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Support agent sign-in' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('swaps to the credentials form, and back again', async () => {
    const user = userEvent.setup();
    renderPage();

    const { email, password } = await openSupportForm(user);
    expect(email).toBeInTheDocument();
    expect(password).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Support agent sign-in' }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Back to ISO+™ sign-in' }),
    );

    expect(
      screen.getByRole('button', { name: 'Sign in with ISO+™' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('posts exactly the typed email and password, then goes to the dashboard', async () => {
    stubLogin();
    const user = userEvent.setup();
    renderPage();

    const form = await openSupportForm(user);
    await user.type(form.email, 'ada@example.com');
    await user.type(form.password, 'local-dev-only');
    await user.click(form.submit);

    await waitFor(() => {
      expect(loginBodies).toEqual([
        { email: 'ada@example.com', password: 'local-dev-only' },
      ]);
    });
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('stays on the login page when the credentials are rejected', async () => {
    stubLogin({ status: 401, message: 'Email or password is incorrect' });
    const user = userEvent.setup();
    renderPage();

    const form = await openSupportForm(user);
    await user.type(form.email, 'ada@example.com');
    await user.type(form.password, 'wrong-password');
    await user.click(form.submit);

    // The failure is reported as a toast; the page itself never navigates.
    expect(
      await screen.findByText('Email or password is incorrect'),
    ).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    // ...and the form unlocks so the user can try again.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Login as Support Agent/ }),
      ).toBeEnabled();
    });
  });

  it('refuses to submit an empty form', async () => {
    stubLogin();
    const user = userEvent.setup();
    renderPage();

    const form = await openSupportForm(user);
    await user.click(form.submit);

    expect(loginBodies).toHaveLength(0);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('refuses to submit a password with no email', async () => {
    stubLogin();
    const user = userEvent.setup();
    renderPage();

    const form = await openSupportForm(user);
    await user.type(form.password, 'local-dev-only');
    await user.click(form.submit);

    expect(loginBodies).toHaveLength(0);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('locks the form while the login request is in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubLogin({ gate });
    const user = userEvent.setup();
    renderPage();

    const form = await openSupportForm(user);
    await user.type(form.email, 'ada@example.com');
    await user.type(form.password, 'local-dev-only');
    await user.click(form.submit);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Login as Support Agent/ }),
      ).toBeDisabled();
    });
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();

    release!();

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('sends the browser to the redirect URI ISO+ hands back', async () => {
    server.use(
      http.get('*/api/auth/isoplus/redirect', () =>
        HttpResponse.json({
          redirect_uri:
            'https://app.isoplus.online/oauth/authorize?client_id=portal&state=abc',
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    const signIn = await screen.findByRole('button', {
      name: 'Sign in with ISO+™',
    });
    await waitFor(() => expect(signIn).toBeEnabled());
    await user.click(signIn);

    await waitFor(() => {
      expect(assignedHref).toBe(
        'https://app.isoplus.online/oauth/authorize?client_id=portal&state=abc',
      );
    });
    expect(router.push).not.toHaveBeenCalled();
  });

  it('keeps the user on the login page when ISO+ will not start the OAuth flow', async () => {
    server.use(
      http.get('*/api/auth/isoplus/redirect', () =>
        HttpResponse.json(
          { message: 'ISO+ client credentials are not configured' },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    const signIn = await screen.findByRole('button', {
      name: 'Sign in with ISO+™',
    });
    await waitFor(() => expect(signIn).toBeEnabled());
    await user.click(signIn);

    expect(
      await screen.findByText('ISO+ client credentials are not configured'),
    ).toBeInTheDocument();
    expect(assignedHref).toBeUndefined();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Sign in with ISO+™' }),
      ).toBeEnabled();
    });
  });

  it('sends an already signed-in visitor straight to the dashboard', async () => {
    stubSession(SUPPORT_ADMIN);
    renderPage();

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('clears any stale session out of localStorage when the session check fails', async () => {
    localStorage.setItem('user', JSON.stringify(SUPPORT_ADMIN));
    localStorage.setItem('workspace', JSON.stringify([{ id: 'ws-1' }]));
    localStorage.setItem('board', JSON.stringify([{ id: 'b-1' }]));

    renderPage();

    await waitFor(() => {
      expect(localStorage.getItem('user')).toBeNull();
    });
    expect(localStorage.getItem('workspace')).toBeNull();
    expect(localStorage.getItem('board')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });
});
