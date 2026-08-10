import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../msw/server';
import { ContextProvider, useAppContext } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
  ISOPLUS_USER,
} from '../../page-test-utils';
import WorkspaceDetail from '@/app/workspace/[id]/page';

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
 * The workspace landing page slices its id off the END of the pathname
 * (`split('/').pop()`), looks the workspace up in context, gates the whole page
 * on the viewer's role, and pages through `/api/workspaces/boards`.
 *
 * These tests pin: the id that ends up in the outgoing request, the
 * currentWorkspaceId lifecycle in the real provider, loading/loaded/empty/
 * failed, the search box (client filter + re-request), cursor paging, the
 * access-denied redirect, and the destinations of the action cards.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const BOARDS_PAGE_1 = {
  board: [
    { id: '901', name: 'Care Board', label: 'Care Management - SaH' },
    { id: '902', name: 'Jobs Board', label: 'Job Management' },
  ],
  hasMore: false,
  nextAfter: null,
};

/** Every `/api/workspaces/boards` URL the page requested, in order. */
let boardRequests: string[] = [];

function stubBoards(
  respond: (url: URL) => Response | Promise<Response> = () =>
    HttpResponse.json(BOARDS_PAGE_1),
) {
  server.use(
    http.get('*/api/workspaces/boards', ({ request }) => {
      boardRequests.push(request.url);
      return respond(new URL(request.url));
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
      <WorkspaceDetail />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // The router object is shared by every test in this file; reset its call log
  // so "was navigated" / "was not navigated" assertions cannot see an earlier
  // test's clicks.
  Object.values(router).forEach((fn) => fn.mockClear());
  boardRequests = [];
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

describe('workspace detail page', () => {
  it('asks for the boards of the workspace id at the end of the pathname', async () => {
    stubBoards();
    renderPage();

    await waitFor(() => expect(boardRequests).toHaveLength(1));

    const url = new URL(boardRequests[0]);
    // NEXT_PUBLIC_BACKEND_URL is unset under vitest, so the path is prefixed
    // with the literal "undefined" the app interpolated.
    expect(url.pathname.endsWith('/api/workspaces/boards')).toBe(true);
    // pathname is /workspace/ws-1 -> split('/').pop() === 'ws-1'
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('after')).toBeNull();
    expect(url.searchParams.get('q')).toBeNull();
  });

  it('publishes the workspace id to context while mounted and clears it when the page unmounts', async () => {
    stubBoards();

    function Harness({ showPage }: { showPage: boolean }) {
      return (
        <ContextProvider>
          <WorkspaceIdProbe />
          {showPage ? <WorkspaceDetail /> : null}
        </ContextProvider>
      );
    }

    const { rerender } = render(<Harness showPage />);

    await waitFor(() => {
      expect(screen.getByTestId('ws-id')).toHaveTextContent('ws-1');
    });

    rerender(<Harness showPage={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('ws-id')).toHaveTextContent('null');
    });
  });

  it('shows the boards spinner until the request settles', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubBoards(async () => {
      await gate;
      return HttpResponse.json(BOARDS_PAGE_1);
    });

    renderPage();

    expect(await screen.findByText('Loading boards...')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    release!();

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByText('Loading boards...')).not.toBeInTheDocument();
  });

  it('renders one row per board with its id, name and label', async () => {
    stubBoards();
    renderPage();

    const table = await screen.findByRole('table');
    const rows = await within(table).findAllByRole('row');
    // 1 header row + 2 board rows
    expect(rows).toHaveLength(3);

    const careRow = within(table).getByRole('cell', { name: '901' })
      .closest('tr') as HTMLElement;
    expect(within(careRow).getByRole('cell', { name: 'Care Board' })).toBeInTheDocument();
    expect(
      within(careRow).getByRole('cell', { name: 'Care Management - SaH' }),
    ).toBeInTheDocument();
    expect(within(careRow).getByRole('button', { name: 'Open' })).toBeEnabled();

    expect(screen.getByRole('heading', { name: 'Hillsgrade Care' })).toBeInTheDocument();
    expect(screen.getByText('ID: ws-1')).toBeInTheDocument();
  });

  it('shows the empty message when the workspace has no boards', async () => {
    stubBoards(() =>
      HttpResponse.json({ board: [], hasMore: false, nextAfter: null }),
    );
    renderPage();

    expect(
      await screen.findByText('No boards found matching your search.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more boards' }),
    ).not.toBeInTheDocument();
  });

  it('falls back to the empty message and logs when the boards request fails', async () => {
    stubBoards(() =>
      HttpResponse.json({ message: 'Boards unavailable' }, { status: 500 }),
    );
    renderPage();

    expect(
      await screen.findByText('No boards found matching your search.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Error fetching boards:',
        expect.anything(),
      );
    });
  });

  it('filters the visible rows immediately and re-requests with the debounced query', async () => {
    stubBoards();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('cell', { name: 'Care Board' });

    await user.type(
      screen.getByPlaceholderText('Search by board ID, name, or label...'),
      'Jobs',
    );

    // Client-side filter is immediate, before any new request lands.
    await waitFor(() => {
      expect(screen.queryByRole('cell', { name: 'Care Board' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('cell', { name: 'Jobs Board' })).toBeInTheDocument();

    // ...and 300ms later the query reaches the backend.
    await waitFor(
      () => {
        expect(boardRequests).toHaveLength(2);
      },
      { timeout: 3000 },
    );
    expect(new URL(boardRequests[1]).searchParams.get('q')).toBe('Jobs');
  });

  it('pages with the cursor the server returned and merges the next page in', async () => {
    let call = 0;
    stubBoards(() => {
      call += 1;
      if (call === 1) {
        return HttpResponse.json({
          board: [{ id: '901', name: 'Care Board', label: 'Care Management - SaH' }],
          hasMore: true,
          nextAfter: 'cursor-901',
        });
      }
      return HttpResponse.json({
        board: [{ id: '902', name: 'Jobs Board', label: 'Job Management' }],
        hasMore: false,
        nextAfter: null,
      });
    });

    const user = userEvent.setup();
    renderPage();

    const loadMore = await screen.findByRole('button', { name: 'Load more boards' });
    await user.click(loadMore);

    await waitFor(() => expect(boardRequests).toHaveLength(2));
    const second = new URL(boardRequests[1]);
    expect(second.searchParams.get('after')).toBe('cursor-901');
    expect(second.searchParams.get('workspaceId')).toBe('ws-1');
    expect(second.searchParams.get('limit')).toBe('50');

    await waitFor(() => {
      expect(screen.getByRole('cell', { name: 'Jobs Board' })).toBeInTheDocument();
    });
    expect(screen.getByRole('cell', { name: 'Care Board' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more boards' }),
    ).not.toBeInTheDocument();
  });

  it('redirects an ISO+ member with no workspace role to access-denied and asks for no boards', async () => {
    localStorage.clear();
    seedContextStorage(ISOPLUS_USER, [
      { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'member' },
    ]);
    stubChromeRequests(ISOPLUS_USER);
    stubBoards();

    renderPage();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/workspace/access-denied');
    });
    expect(boardRequests).toHaveLength(0);
  });

  it('sends each action card to the matching workspace sub-page', async () => {
    stubBoards();
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Configure Business' }),
    );
    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/configure-business');

    await user.click(screen.getByRole('button', { name: 'Setup Xero' }));
    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/xero-integration');

    await user.click(screen.getByRole('button', { name: 'View Audit Trail' }));
    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/audit-trail');

    await user.click(screen.getByRole('button', { name: 'Configure Workspace' }));
    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/configuration');

    await user.click(screen.getByRole('button', { name: /View Usage Report/ }));
    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/usage-report');

    const careRow = screen.getByRole('cell', { name: '901' })
      .closest('tr') as HTMLElement;
    await user.click(within(careRow).getByRole('button', { name: 'Open' }));
    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/board/901');
  });
});
