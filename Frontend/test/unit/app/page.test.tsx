import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';
import { ContextProvider } from '@/app/context';
import { installBrowserStubs, makeRouter, SUPPORT_ADMIN } from './page-test-utils';
import LoginPage from '@/app/page';
import { dismissAllToasts } from '@/lib/toast-utils';

installBrowserStubs();

const router = makeRouter();

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

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

function renderPage() {
  return render(
    <ContextProvider>
      <LoginPage />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  assignedHref = undefined;
  router.push.mockClear();
  router.replace.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubSession(null);
  process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';

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
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).not.toBeInTheDocument();
  });

  it('starts Google OAuth when Support agent sign-in is clicked', async () => {
    const user = userEvent.setup();
    renderPage();

    const supportSignIn = await screen.findByRole('button', {
      name: 'Support agent sign-in',
    });
    await waitFor(() => expect(supportSignIn).toBeEnabled());
    await user.click(supportSignIn);

    await waitFor(() => {
      expect(assignedHref).toBe(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/google/redirect`,
      );
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Support agent sign-in' })).not.toBeInTheDocument();
  });

  it('shows an error when NEXT_PUBLIC_BACKEND_URL is missing for Google support sign-in', async () => {
    const saved = process.env.NEXT_PUBLIC_BACKEND_URL;
    delete process.env.NEXT_PUBLIC_BACKEND_URL;
    try {
      const user = userEvent.setup();
      renderPage();

      const supportSignIn = await screen.findByRole('button', {
        name: 'Support agent sign-in',
      });
      await waitFor(() => expect(supportSignIn).toBeEnabled());
      await user.click(supportSignIn);

      expect(
        await screen.findByText('NEXT_PUBLIC_BACKEND_URL is not configured.'),
      ).toBeInTheDocument();
      expect(assignedHref).toBeUndefined();
    } finally {
      process.env.NEXT_PUBLIC_BACKEND_URL = saved;
    }
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

/**
 * Coming back from ISO+ sign-in the URL carries `?ticket=...`. The ticket is
 * redeemed in an effect, and the page must render the SAME first markup with or
 * without it: the server cannot see the URL, so a first render that reads
 * `window.location` hydrates with a different button ("Signing in..." and
 * disabled against "Sign in with ISO+") and React reports a hydration mismatch
 * on every return from sign-in (KAN-22, KAN-333).
 */
describe('Login page: returning from ISO+ sign-in with an OAuth ticket', () => {
  function setLocationSearch(search: string) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, search, pathname: '/' },
    });
  }

  function firstRenderMarkup() {
    return renderToString(
      <ContextProvider>
        <LoginPage />
      </ContextProvider>,
    );
  }

  it('renders the same first markup with or without a ticket in the URL, so it hydrates cleanly', () => {
    setLocationSearch('');
    const withoutTicket = firstRenderMarkup();

    setLocationSearch('?ticket=ticket-hydration-1');
    const withTicket = firstRenderMarkup();

    expect(withTicket).toBe(withoutTicket);
    expect(withTicket).toContain('Sign in with ISO+');
    expect(withTicket).not.toContain('Signing in');
  });

  it('shows the signing-in state, redeems the ticket once, stores the user and goes to the dashboard', async () => {
    const exchanged: unknown[] = [];
    server.use(
      http.post('*/api/auth/oauth-exchange', async ({ request }) => {
        exchanged.push(await request.json());
        return HttpResponse.json({ user: SUPPORT_ADMIN });
      }),
    );
    setLocationSearch('?ticket=ticket-ok-1');

    renderPage();

    // The effect flips the button as soon as the page mounts.
    expect(
      await screen.findByRole('button', { name: /Signing in/ }),
    ).toBeDisabled();

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/dashboard');
    });
    expect(exchanged).toEqual([{ ticket: 'ticket-ok-1' }]);
    expect(JSON.parse(localStorage.getItem('user') ?? 'null')).toMatchObject({
      email: SUPPORT_ADMIN.email,
      role: 'support_admin',
    });
  });

  it('puts the sign-in button back and stays on the page when the ticket is refused', async () => {
    server.use(
      http.post('*/api/auth/oauth-exchange', () =>
        HttpResponse.json({ message: 'Ticket expired' }, { status: 401 }),
      ),
    );
    setLocationSearch('?ticket=ticket-refused-1');

    renderPage();

    expect(
      await screen.findByText('Ticket expired'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Sign in with ISO+™' }),
      ).toBeEnabled();
    });
    expect(router.push).not.toHaveBeenCalledWith('/dashboard');
  });
});
