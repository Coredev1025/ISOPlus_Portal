import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    server.use(
      http.get('*/api/auth/google/redirect', () =>
        HttpResponse.json({
          redirect_uri:
            'https://accounts.google.com/o/oauth2/v2/auth?client_id=portal&state=abc',
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    const supportSignIn = await screen.findByRole('button', {
      name: 'Support agent sign-in',
    });
    await waitFor(() => expect(supportSignIn).toBeEnabled());
    await user.click(supportSignIn);

    await waitFor(() => {
      expect(assignedHref).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=portal&state=abc',
      );
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Support agent sign-in' })).not.toBeInTheDocument();
  });

  it('shows an error when Google support sign-in is not configured', async () => {
    server.use(
      http.get('*/api/auth/google/redirect', () =>
        HttpResponse.json(
          { message: 'Google support sign-in is not configured' },
          { status: 503 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    const supportSignIn = await screen.findByRole('button', {
      name: 'Support agent sign-in',
    });
    await waitFor(() => expect(supportSignIn).toBeEnabled());
    await user.click(supportSignIn);

    expect(
      await screen.findByText('Google support sign-in is not configured'),
    ).toBeInTheDocument();
    expect(assignedHref).toBeUndefined();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Support agent sign-in' })).toBeEnabled();
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
