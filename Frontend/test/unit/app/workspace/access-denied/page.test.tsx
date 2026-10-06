import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../msw/server';
import { ContextProvider } from '@/app/context';
import WorkspaceAccessDenied from '@/app/workspace/access-denied/page';

/**
 * The workspace-scoped access-denied page differs from the top-level one: it
 * names the specific reason (admin-only portal). That extra message is the
 * thing worth pinning, alongside the single exit route.
 */

// ONE router object for the whole file. Next's real useRouter is stable, and
// Header's session-check effect lists `router` in its deps — a mock building a
// fresh object per call re-fires that effect on every render, which loops
// forever and hangs the file instead of failing it.
const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/workspace/access-denied',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

// NEXT_PUBLIC_BACKEND_URL is unset under vitest, so the app requests
// `undefined/api/...`. A leading * matches whatever origin it ends up with.
/**
 * jsdom's window.location cannot be redefined and its href is not configurable,
 * so the only safe way to observe `window.location.href = ...` is to swap the
 * whole accessor for the duration of one test and restore it immediately.
 * Doing it globally breaks the jsdom internals MSW relies on and hangs the file.
 */
function captureNavigation(run: () => Promise<void>) {
  const real = window.location;
  const fake = {
    href: real.href,
    origin: real.origin,
    protocol: real.protocol,
    host: real.host,
    hostname: real.hostname,
    port: real.port,
    pathname: real.pathname,
    search: real.search,
    hash: real.hash,
    assign: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
    toString: () => real.href,
  };
  const spy = vi.spyOn(window, 'location', 'get').mockReturnValue(fake as never);
  return run().finally(() => spy.mockRestore()).then(() => fake.href);
}

beforeEach(() => {
  localStorage.clear();

  server.use(
    http.get(`*/api/auth/verify`, () =>
      HttpResponse.json({ user: null }, { status: 401 }),
    ),
  );

});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPage() {
  return render(
    <ContextProvider>
      <WorkspaceAccessDenied />
    </ContextProvider>,
  );
}

describe('workspace AccessDenied page', () => {
  it('tells the user they do not have permission', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Access Denied' })).toBeInTheDocument();
  });

  it('states that the portal is admin-only, which the top-level page does not', () => {
    renderPage();

    expect(
      screen.getByRole('heading', { name: /This portal is accessible to Admin users only\./i }),
    ).toBeInTheDocument();
  });

  it('tells the user to contact their system administrator', () => {
    renderPage();

    expect(
      screen.getByText(/please contact your system administrator/i),
    ).toBeInTheDocument();
  });

  it('navigates to the ISO+ home page from its only action', async () => {
    const user = userEvent.setup();
    renderPage();
    const button = screen.getByRole('button', { name: /Return to ISO\+™ Main Website/i });

    const href = await captureNavigation(async () => {
      await user.click(button);
    });

    expect(href).toBe('https://app.isoplus.online/home');
  });
});
