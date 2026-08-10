import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../../msw/server';
import { ContextProvider, useAppContext } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
} from '../../../page-test-utils';
import AuditTrailPage from '@/app/workspace/[id]/audit-trail/page';

// These pages raise real toastify-js toasts that nothing here asserts, and each
// one schedules a dismiss timer that outlives the test. When such a timer fires
// after jsdom is torn down it throws `ReferenceError: window is not defined` as
// an unhandled error, failing the run with exit code 1 even though every
// assertion passed. Stubbing the toast helpers removes the timer entirely.
vi.mock('@/lib/toast-utils', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
  showWarningToast: vi.fn(),
  showLoadingToast: vi.fn(() => 1),
  showFetchSuccessToast: vi.fn(),
  showFetchErrorToast: vi.fn(),
  showSaveSuccessToast: vi.fn(),
  showSaveErrorToast: vi.fn(),
  dismissToast: vi.fn(),
  dismissAllToasts: vi.fn(),
}));


/**
 * The audit trail page reads its workspace id out of the MIDDLE of the pathname
 * (`split('/')[2]`), asks the business profile for the timezone it renders
 * timestamps in, then pages `/api/audit/`. Search and the two Select filters
 * are applied client-side to the page that came back — they are deliberately
 * NOT sent to the backend, and these tests pin that.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/audit-trail';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Two realistic AuditTrail documents. The first is a raw HTTP audit row, which
 * the page humanizes; the second already carries a friendly action.
 */
const AUDIT_ITEMS = [
  {
    _id: 'a-1',
    action: 'HTTP POST',
    method: 'POST',
    path: '/api/pdf/901/monthly-statement?workspaceId=ws-1',
    userEmail: 'ada@example.com',
    userIp: '203.0.113.7',
    detail: '{"statusCode":200,"durationMs":12.5}',
    createdAt: '2026-03-04T14:00:00.000Z',
  },
  {
    _id: 'a-2',
    action: 'Sync Board',
    method: 'POST',
    path: '/api/sync/board/901',
    userEmail: 'grace@example.com',
    userIp: '198.51.100.4',
    detail: 'Manual sync triggered',
    createdAt: '2026-03-04T13:00:00.000Z',
  },
];

let auditRequests: string[] = [];

function stubAudit(options: {
  timezone?: string;
  respond?: (url: URL) => Response | Promise<Response>;
} = {}) {
  server.use(
    http.get('*/api/business/profile', () =>
      HttpResponse.json({
        name: 'Hillsgrade Care',
        headOfficeTimezone: options.timezone ?? 'Australia/Sydney',
      }),
    ),
    http.get('*/api/audit/', ({ request }) => {
      auditRequests.push(request.url);
      const url = new URL(request.url);
      if (options.respond) return options.respond(url);
      return HttpResponse.json({
        items: AUDIT_ITEMS,
        total: 2,
        page: Number(url.searchParams.get('page')),
        totalPages: 1,
      });
    }),
  );
}

function WorkspaceIdProbe() {
  const { currentWorkspaceId } = useAppContext();
  return <div data-testid="ws-id">{currentWorkspaceId ?? 'null'}</div>;
}

function renderPage() {
  return render(
    <ContextProvider>
      <WorkspaceIdProbe />
      <AuditTrailPage />
    </ContextProvider>,
  );
}

/** The row containing a given user's email. */
function rowFor(email: string): HTMLElement {
  return screen.getByRole('cell', { name: email }).closest('tr') as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
  // The router object is shared by every test in this file; reset its call log
  // so "was navigated" / "was not navigated" assertions cannot see an earlier
  // test's clicks.
  Object.values(router).forEach((fn) => fn.mockClear());
  auditRequests = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedContextStorage(SUPPORT_ADMIN, [
    { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' },
  ]);
  stubChromeRequests(SUPPORT_ADMIN);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('audit trail page', () => {
  it('asks for page 1 of the audit log for the workspace id in the pathname', async () => {
    stubAudit();
    renderPage();

    await waitFor(() => expect(auditRequests.length).toBeGreaterThan(0));

    const url = new URL(auditRequests[0]);
    expect(url.pathname.endsWith('/api/audit/')).toBe(true);
    // pathname is /workspace/ws-1/audit-trail -> split('/')[2] === 'ws-1'
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('sortBy')).toBe('createdAt');
    expect(url.searchParams.get('sortOrder')).toBe('desc');
  });

  it('never publishes the workspace id to context, so no sync polling starts', async () => {
    stubAudit();
    renderPage();

    // Wait until the page has actually finished loading, so this is not a
    // vacuous check against a not-yet-run effect.
    await screen.findByRole('cell', { name: 'ada@example.com' });
    expect(screen.getByTestId('ws-id')).toHaveTextContent('null');
  });

  it('shows the loading placeholder until the audit request settles', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubAudit({
      respond: async () => {
        await gate;
        return HttpResponse.json({
          items: AUDIT_ITEMS,
          total: 2,
          page: 1,
          totalPages: 1,
        });
      },
    });

    renderPage();

    expect(await screen.findByText('Loading audit trail...')).toBeInTheDocument();
    expect(screen.queryByText('No audit trail found')).not.toBeInTheDocument();

    release!();

    await screen.findByRole('cell', { name: 'ada@example.com' });
    expect(screen.queryByText('Loading audit trail...')).not.toBeInTheDocument();
  });

  it('humanizes the HTTP action, summarizes the JSON detail and renders the timestamp in the business timezone', async () => {
    stubAudit();
    renderPage();

    const row = await screen
      .findByRole('cell', { name: 'ada@example.com' })
      .then((cell) => cell.closest('tr') as HTMLElement);

    // "HTTP POST" + path ending /monthly-statement -> the friendly name.
    expect(
      within(row).getByRole('cell', { name: 'Generate Monthly Statement' }),
    ).toBeInTheDocument();
    // {"statusCode":200,"durationMs":12.5} -> "OK status=200 durationMs=12.5"
    expect(within(row).getByText('OK status=200 durationMs=12.5')).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: '203.0.113.7' })).toBeInTheDocument();
    // 2026-03-04T14:00:00Z in Australia/Sydney (UTC+11 in March) is the 5th.
    expect(
      within(row).getByText((text) => text.startsWith('05/03/2026')),
    ).toBeInTheDocument();
    expect(
      within(row).getByText((text) => text.includes('01:00:00')),
    ).toBeInTheDocument();

    // A non-HTTP action and a plain-text detail pass through untouched.
    const other = rowFor('grace@example.com');
    expect(within(other).getByRole('cell', { name: 'Sync Board' })).toBeInTheDocument();
    expect(within(other).getByText('Manual sync triggered')).toBeInTheDocument();

    expect(screen.getByText('Showing 2 of 2 entries (Page 1 of 1)')).toBeInTheDocument();
  });

  it('honours the timezone the business profile returns rather than a hardcoded one', async () => {
    stubAudit({ timezone: 'Australia/Perth' });
    renderPage();

    await screen.findByRole('cell', { name: 'ada@example.com' });

    // Same instant, Australia/Perth (UTC+8) -> still the 4th, 22:00:00 pm.
    // The first render uses the default Australia/Sydney, so wait for the
    // profile's timezone to land and the rows to be re-rendered.
    await waitFor(() => {
      const row = rowFor('ada@example.com');
      expect(
        within(row).getByText((text) => text.startsWith('04/03/2026')),
      ).toBeInTheDocument();
    });
    expect(
      within(rowFor('ada@example.com')).getByText((text) =>
        text.includes('10:00:00'),
      ),
    ).toBeInTheDocument();
  });

  it('shows the empty state when the workspace has no audit entries', async () => {
    stubAudit({
      respond: () =>
        HttpResponse.json({ items: [], total: 0, page: 1, totalPages: 0 }),
    });
    renderPage();

    expect(await screen.findByText('No audit trail found')).toBeInTheDocument();
    expect(screen.queryByText(/Showing .* entries/)).not.toBeInTheDocument();
  });

  it('shows the empty state and logs when the audit request fails', async () => {
    stubAudit({
      respond: () =>
        HttpResponse.json({ message: 'Audit unavailable' }, { status: 500 }),
    });
    renderPage();

    expect(await screen.findByText('No audit trail found')).toBeInTheDocument();
    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Error fetching audit trail:',
        expect.anything(),
      );
    });
  });

  it('filters rows by user without adding any filter parameter to the request', async () => {
    stubAudit();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('cell', { name: 'ada@example.com' });
    const requestsBefore = auditRequests.length;

    // Both Select triggers render with an EMPTY accessible name until their
    // content has mounted once, so neither can be queried by name. In document
    // order they are: action filter, then user filter.
    const [actionFilter, userFilter] = screen.getAllByRole('combobox');
    expect(actionFilter).toHaveAccessibleName('');
    await user.click(userFilter);
    const listbox = await screen.findByRole('listbox');
    await user.click(
      within(listbox).getByRole('option', { name: 'grace@example.com' }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole('cell', { name: 'ada@example.com' }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole('cell', { name: 'grace@example.com' })).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 2 entries (Page 1 of 1)')).toBeInTheDocument();

    // The filter change re-runs the fetch, but carries no filter parameters.
    await waitFor(() =>
      expect(auditRequests.length).toBeGreaterThan(requestsBefore),
    );
    const latest = new URL(auditRequests[auditRequests.length - 1]);
    expect(latest.searchParams.get('user')).toBeNull();
    expect(latest.searchParams.get('search')).toBeNull();
    expect([...latest.searchParams.keys()].sort()).toEqual([
      'limit',
      'page',
      'sortBy',
      'sortOrder',
      'workspaceId',
    ]);
  });

  it('narrows the visible rows to those matching the debounced search text', async () => {
    stubAudit();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('cell', { name: 'ada@example.com' });

    await user.type(
      screen.getByPlaceholderText('Search audit trail...'),
      '198.51.100.4',
    );

    await waitFor(
      () => {
        expect(
          screen.queryByRole('cell', { name: 'ada@example.com' }),
        ).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.getByRole('cell', { name: 'grace@example.com' })).toBeInTheDocument();
  });

  it('requests the next page when a pagination link is clicked', async () => {
    stubAudit({
      respond: (url) =>
        HttpResponse.json({
          items: AUDIT_ITEMS,
          total: 120,
          page: Number(url.searchParams.get('page')),
          totalPages: 3,
        }),
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('cell', { name: 'ada@example.com' });

    // The search-debounce effect runs on MOUNT too, and its 400ms timer calls
    // setCurrentPage(1) unconditionally. Clicking page 2 before it fires would
    // bounce the page straight back to 1 (a real race in the page, reported
    // separately), so let it elapse first and pin the intended behaviour.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    // PaginationLink renders an <a> with no href, so it has no link role.
    const pagination = screen.getByRole('navigation', { name: 'pagination' });
    await user.click(within(pagination).getByText('2'));

    await waitFor(() =>
      expect(
        auditRequests.map((u) => new URL(u).searchParams.get('page')),
      ).toEqual(['1', '2']),
    );
    expect(new URL(auditRequests[1]).searchParams.get('workspaceId')).toBe('ws-1');

    await waitFor(() => {
      expect(
        screen.getByText('Showing 2 of 120 entries (Page 2 of 3)'),
      ).toBeInTheDocument();
    });
  });
});
