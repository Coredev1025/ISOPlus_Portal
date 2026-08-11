import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../msw/server';
import { ContextProvider } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
  ISOPLUS_USER,
} from '../page-test-utils';
import Dashboard from '@/app/dashboard/page';
import { dismissAllToasts } from '@/lib/toast-utils';

/**
 * The dashboard is the workspace picker. It loads the workspaces this user is
 * allowed to see, sorts them, and routes on from there — including two
 * automatic routes (no workspaces at all, and an ISO+ user with exactly one).
 * These tests pin the request, the loading/loaded/empty/failed states, the
 * sorting, the destination of "Open", and the role gating of the admin-only
 * pieces.
 */

installBrowserStubs();

const router = makeRouter();

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

const HILLSGRADE = { id: 41207, name: 'Hillsgrade Care', user_role: 'owner' };
const ACACIA = { id: 39114, name: 'Acacia Support Services', user_role: 'admin' };

/** Every /api/workspaces request the page issued, in order. */
let workspaceRequestUrls: string[] = [];

function stubWorkspaces(
  options: {
    workspaces?: Array<Record<string, unknown>>;
    hasMore?: boolean;
    nextAfter?: string | null;
    status?: number;
    message?: string;
    gate?: Promise<void>;
    pages?: Array<Record<string, unknown>>;
  } = {},
) {
  let call = 0;
  server.use(
    http.get('*/api/workspaces', async ({ request }) => {
      workspaceRequestUrls.push(request.url);
      if (options.gate) await options.gate;
      if (options.status && options.status !== 200) {
        return HttpResponse.json(
          { message: options.message ?? 'Workspaces unavailable' },
          { status: options.status },
        );
      }
      if (options.pages) {
        const page = options.pages[Math.min(call, options.pages.length - 1)];
        call += 1;
        return HttpResponse.json(page);
      }
      return HttpResponse.json({
        workspace: options.workspaces ?? [HILLSGRADE, ACACIA],
        hasMore: options.hasMore ?? false,
        nextAfter: options.nextAfter ?? null,
      });
    }),
  );
}

function renderPage() {
  return render(
    <ContextProvider>
      <Dashboard />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  workspaceRequestUrls = [];
  router.push.mockClear();
  router.replace.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedContextStorage(SUPPORT_ADMIN, []);
  stubChromeRequests(SUPPORT_ADMIN);
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

describe('Dashboard page', () => {
  it('asks for the first page of workspaces, unfiltered', async () => {
    stubWorkspaces();
    renderPage();

    await screen.findByText('Hillsgrade Care');

    expect(workspaceRequestUrls).toHaveLength(1);
    const params = new URL(workspaceRequestUrls[0]).searchParams;
    expect(params.get('limit')).toBe('50');
    expect(params.get('q')).toBeNull();
    expect(params.get('includeDetails')).toBeNull();
  });

  it('greets the signed-in user by first name', async () => {
    stubWorkspaces();
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Welcome back, Ada' }),
    ).toBeInTheDocument();
  });

  it('shows placeholder rows, not the empty message, while the workspaces load', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubWorkspaces({ gate });

    const { container } = renderPage();

    // Five skeleton rows of three cells each, from the isLoading branch.
    await waitFor(() => {
      expect(container.querySelectorAll('.animate-pulse')).toHaveLength(15);
    });
    expect(
      screen.queryByText('No workspaces match your search.'),
    ).not.toBeInTheDocument();

    release!();

    expect(await screen.findByText('Hillsgrade Care')).toBeInTheDocument();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
  });

  it('lists every workspace by id and name, sorted by name', async () => {
    stubWorkspaces();
    renderPage();

    await screen.findByText('Hillsgrade Care');

    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows).toHaveLength(2);
    // The API returned Hillsgrade first; the page sorts by name.
    expect(within(rows[0]).getByText('Acacia Support Services')).toBeInTheDocument();
    expect(within(rows[0]).getByText('39114')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Hillsgrade Care')).toBeInTheDocument();
    expect(within(rows[1]).getByText('41207')).toBeInTheDocument();
  });

  it('opens the workspace whose row was clicked', async () => {
    stubWorkspaces();
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Hillsgrade Care');
    const rows = screen.getAllByRole('row').slice(1);
    await user.click(within(rows[1]).getByRole('button', { name: /Open/ }));

    expect(router.push).toHaveBeenCalledWith('/workspace/41207');
  });

  it('sends a user with no workspaces at all to the access-denied page', async () => {
    stubWorkspaces({ workspaces: [] });
    renderPage();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/access-denied');
    });
  });

  it('searches by the typed query and reports when nothing matches', async () => {
    stubWorkspaces({ pages: [
      { workspace: [HILLSGRADE, ACACIA], hasMore: false, nextAfter: null },
      { workspace: [], hasMore: false, nextAfter: null },
    ] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Hillsgrade Care');
    await user.type(
      screen.getByRole('textbox', { name: 'Search workspaces' }),
      'kalgoorlie',
    );

    expect(
      await screen.findByText('No workspaces match your search.'),
    ).toBeInTheDocument();

    const params = new URL(workspaceRequestUrls[1]).searchParams;
    expect(params.get('q')).toBe('kalgoorlie');
    expect(params.get('includeDetails')).toBe('true');
    expect(params.get('limit')).toBe('50');
    // A search that returns nothing is not an access problem.
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('reports a failed workspace load without navigating away', async () => {
    stubWorkspaces({ status: 500, message: 'ISO+ is not reachable right now' });
    renderPage();

    expect(
      await screen.findByText('ISO+ is not reachable right now'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('No workspaces match your search.'),
    ).toBeInTheDocument();
    expect(console.error).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('loads the next page of workspaces from the cursor the API returned', async () => {
    stubWorkspaces({ pages: [
      { workspace: [HILLSGRADE], hasMore: true, nextAfter: 'cursor-41207' },
      { workspace: [ACACIA], hasMore: false, nextAfter: null },
    ] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Hillsgrade Care');
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Acacia Support Services')).toBeInTheDocument();
    expect(new URL(workspaceRequestUrls[1]).searchParams.get('after')).toBe(
      'cursor-41207',
    );
    // Both pages are kept, still sorted by name.
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => row.cells[1].textContent)).toEqual([
      'Acacia Support Services',
      'Hillsgrade Care',
    ]);
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();
  });

  it('gives a support admin the logs tab and the user export', async () => {
    stubWorkspaces();
    renderPage();

    await screen.findByText('Hillsgrade Care');
    expect(
      screen.getByRole('tab', { name: /Application logs/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Export all users \(CSV\)/ }),
    ).toBeInTheDocument();
  });

  it('gives an ISO+ user neither, and opens their only workspace for them', async () => {
    localStorage.clear();
    seedContextStorage(ISOPLUS_USER, []);
    stubChromeRequests(ISOPLUS_USER);
    stubWorkspaces({ workspaces: [HILLSGRADE] });
    renderPage();

    await screen.findByText('Hillsgrade Care');

    expect(
      screen.queryByRole('tab', { name: /Application logs/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Export all users \(CSV\)/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/workspace/41207');
    });
  });

  it('drops workspaces an ISO+ user only has guest access to', async () => {
    localStorage.clear();
    seedContextStorage(ISOPLUS_USER, []);
    stubChromeRequests(ISOPLUS_USER);
    stubWorkspaces({
      workspaces: [
        HILLSGRADE,
        { id: 50001, name: 'Zephyr Guest Workspace', user_role: 'guest' },
      ],
    });
    renderPage();

    await screen.findByText('Hillsgrade Care');
    expect(screen.queryByText('Zephyr Guest Workspace')).not.toBeInTheDocument();
  });
});
