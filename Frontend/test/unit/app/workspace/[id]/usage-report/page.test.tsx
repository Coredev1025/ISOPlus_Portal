import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  ISOPLUS_USER,
} from '../../../page-test-utils';
import UsageReportPage from '@/app/workspace/[id]/usage-report/page';

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
 * The usage report is owner/support-only, fetches a summary and a daily series
 * in parallel, and falls back to a hardcoded demo dataset when either request
 * fails. These tests pin the role gate, both request URLs, the date-range
 * control, the loaded/empty states, and the silent fallback — which is the
 * behaviour most likely to hide a broken endpoint.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/usage-report';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const SUMMARY = [
  { service: 'Invoice', currentCycle: 3, total: 41, avgDaily: 1.4 },
  { service: 'Quote', currentCycle: 1, total: 9, avgDaily: 0.3 },
];

const DAILY = [
  {
    date: '2026-03-03',
    'Purchase Order': 1,
    Invoice: 2,
    Quote: 0,
    'Employee Agreement': 0,
    'Contractor Agreement': 0,
    'Xero API Calls': 4,
  },
  {
    date: '2026-03-04',
    'Purchase Order': 2,
    Invoice: 1,
    Quote: 1,
    'Employee Agreement': 0,
    'Contractor Agreement': 0,
    'Xero API Calls': 6,
  },
];

let summaryRequests: string[] = [];
let dailyRequests: string[] = [];

function stubUsage(options: { summaryStatus?: number; summary?: unknown } = {}) {
  server.use(
    http.get('*/api/usage/summary', ({ request }) => {
      summaryRequests.push(request.url);
      if (options.summaryStatus && options.summaryStatus !== 200) {
        return HttpResponse.json(
          { message: 'Usage unavailable' },
          { status: options.summaryStatus },
        );
      }
      return HttpResponse.json(options.summary ?? SUMMARY);
    }),
    http.get('*/api/usage/daily', ({ request }) => {
      dailyRequests.push(request.url);
      return HttpResponse.json(DAILY);
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
      <UsageReportPage />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // The router object is shared by every test in this file; reset its call log
  // so "was navigated" / "was not navigated" assertions cannot see an earlier
  // test's clicks.
  Object.values(router).forEach((fn) => fn.mockClear());
  summaryRequests = [];
  dailyRequests = [];
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

describe('usage report page', () => {
  it('asks both usage endpoints for the workspace in the pathname with the default 30-day range', async () => {
    stubUsage();
    renderPage();

    await waitFor(() => {
      expect(summaryRequests).toHaveLength(1);
      expect(dailyRequests).toHaveLength(1);
    });

    const summary = new URL(summaryRequests[0]);
    expect(summary.pathname.endsWith('/api/usage/summary')).toBe(true);
    // pathname is /workspace/ws-1/usage-report -> split('/')[2] === 'ws-1'
    expect(summary.searchParams.get('workspaceId')).toBe('ws-1');
    expect(summary.searchParams.get('dateRange')).toBe('30');

    const daily = new URL(dailyRequests[0]);
    expect(daily.pathname.endsWith('/api/usage/daily')).toBe(true);
    expect(daily.searchParams.get('workspaceId')).toBe('ws-1');
    expect(daily.searchParams.get('dateRange')).toBe('30');
  });

  it('shows the loading text until both requests settle', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('*/api/usage/summary', async () => {
        await gate;
        return HttpResponse.json(SUMMARY);
      }),
      http.get('*/api/usage/daily', () => HttpResponse.json(DAILY)),
    );

    renderPage();

    expect(await screen.findByText('Loading usage data...')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    release!();

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByText('Loading usage data...')).not.toBeInTheDocument();
  });

  it('renders one summary row per service the API returned', async () => {
    stubUsage();
    renderPage();

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // 1 header row + 2 service rows
    expect(rows).toHaveLength(3);

    const invoiceRow = within(table)
      .getByRole('cell', { name: 'Invoice' })
      .closest('tr') as HTMLElement;
    const cells = within(invoiceRow).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['Invoice', '3', '41', '1.4']);

    // The hardcoded demo dataset must not leak in when the API answered.
    expect(
      screen.queryByRole('cell', { name: 'Xero API Calls' }),
    ).not.toBeInTheDocument();
  });

  it('renders a summary table with no service rows when the API returns none', async () => {
    stubUsage({ summary: [] });
    renderPage();

    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Usage Summary' })).toBeInTheDocument();
  });

  it('silently substitutes the hardcoded demo dataset when the usage request fails', async () => {
    stubUsage({ summaryStatus: 500 });
    renderPage();

    // The six demo services, with their literal demo numbers.
    const xeroRow = await screen
      .findByRole('cell', { name: 'Xero API Calls' })
      .then((cell) => cell.closest('tr') as HTMLElement);
    expect(
      within(xeroRow).getAllByRole('cell').map((c) => c.textContent),
    ).toEqual(['Xero API Calls', '234', '2892', '42.6']);

    // No error is shown to the user at all.
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Error fetching usage data:',
        expect.anything(),
      );
    });
  });

  it('re-requests both endpoints with the newly chosen date range', async () => {
    stubUsage();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('table');

    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'Last 7 Days' }));

    await waitFor(() => expect(summaryRequests).toHaveLength(2));
    expect(new URL(summaryRequests[1]).searchParams.get('dateRange')).toBe('7');
    expect(new URL(dailyRequests[1]).searchParams.get('dateRange')).toBe('7');
    expect(new URL(summaryRequests[1]).searchParams.get('workspaceId')).toBe('ws-1');
  });

  it('redirects an ISO+ user away and renders nothing, issuing no usage requests', async () => {
    localStorage.clear();
    seedContextStorage(ISOPLUS_USER, [
      { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' },
    ]);
    stubChromeRequests(ISOPLUS_USER);
    stubUsage();

    renderPage();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/workspace/access-denied');
    });
    expect(screen.queryByRole('heading', { name: 'Usage Report' })).not.toBeInTheDocument();
    expect(summaryRequests).toHaveLength(0);
    expect(dailyRequests).toHaveLength(0);
  });

  it('never publishes the workspace id to context', async () => {
    stubUsage();
    renderPage();

    await screen.findByRole('table');
    expect(screen.getByTestId('ws-id')).toHaveTextContent('null');
  });
});
