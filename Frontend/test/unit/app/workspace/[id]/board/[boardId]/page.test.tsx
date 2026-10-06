import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../../../msw/server';
import { ContextProvider, useAppContext } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
  ISOPLUS_USER,
} from '../../../../page-test-utils';
import BoardDetail from '@/app/workspace/[id]/board/[boardId]/page';

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
 * The board landing page is a router: it slices the ids out of the pathname,
 * loads the one board, caches it in sessionStorage for the sync helpers, and
 * decides which of the four feature cards this user and this board label are
 * allowed to see. These tests pin the id slicing, the context lifecycle, the
 * loading/loaded/failed states, the card gating and every destination.
 */

installBrowserStubs();

const router = makeRouter();
// id = pathname.split('/')[2]; boardId = pathname.split('/').pop()
const PATHNAME = '/workspace/ws-1/board/b-1';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const WORKSPACE = { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' };

const SAH_BOARD = {
  id: 'b-1',
  name: 'SaH Care Management',
  label: 'Care Management - SaH',
};

/** Every /api/boards request the page issued, in order. */
let boardRequestUrls: string[] = [];

function stubBoard(
  board: Record<string, unknown> | null = SAH_BOARD,
  options: { status?: number; gate?: Promise<void> } = {},
) {
  server.use(
    http.get('*/api/boards', async ({ request }) => {
      boardRequestUrls.push(request.url);
      if (options.gate) await options.gate;
      if (options.status && options.status !== 200) {
        return HttpResponse.json(
          { message: 'Board not found' },
          { status: options.status },
        );
      }
      return HttpResponse.json({ board });
    }),
  );
}

/** Reads currentWorkspaceId out of the REAL provider, so no spy is involved. */
function WorkspaceIdProbe() {
  const { currentWorkspaceId } = useAppContext();
  return <div data-testid="ws-id">{currentWorkspaceId ?? 'null'}</div>;
}

function renderPage() {
  return render(
    <ContextProvider>
      <WorkspaceIdProbe />
      <BoardDetail />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  boardRequestUrls = [];
  router.push.mockClear();
  router.replace.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  seedContextStorage(SUPPORT_ADMIN, [WORKSPACE]);
  stubChromeRequests(SUPPORT_ADMIN);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('Board detail page', () => {
  it('asks for the board named in the pathname', async () => {
    stubBoard();
    renderPage();

    await screen.findByRole('heading', { name: 'SaH Care Management' });

    // The fetch effect lists `workspace` in its deps, so it re-runs once when
    // the provider hydrates from localStorage; every request is for the same
    // board id sliced out of the pathname.
    expect(boardRequestUrls.length).toBeGreaterThan(0);
    expect(
      boardRequestUrls.map((u) => new URL(u).searchParams.get('id')),
    ).toEqual(boardRequestUrls.map(() => 'b-1'));
  });

  it('publishes the workspace id from the pathname to context, and clears it when the page unmounts', async () => {
    stubBoard();

    function Harness({ showPage }: { showPage: boolean }) {
      return (
        <ContextProvider>
          <WorkspaceIdProbe />
          {showPage ? <BoardDetail /> : null}
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

  it('renders nothing until the board arrives', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubBoard(SAH_BOARD, { gate });

    renderPage();

    await waitFor(() => {
      expect(boardRequestUrls.length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByRole('heading', { name: 'SaH Care Management' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Back to Workspace' }),
    ).not.toBeInTheDocument();

    release!();

    expect(
      await screen.findByRole('heading', { name: 'SaH Care Management' }),
    ).toBeInTheDocument();
  });

  it('shows the board name, its id and its label once loaded', async () => {
    stubBoard();
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'SaH Care Management' }),
    ).toBeInTheDocument();
    expect(screen.getByText('ID: b-1')).toBeInTheDocument();
    expect(screen.getByText('Care Management - SaH')).toBeInTheDocument();
  });

  it('hides the label badge for an unlabelled board', async () => {
    stubBoard({ id: 'b-1', name: 'Untagged Board', label: 'No Label' });
    renderPage();

    await screen.findByRole('heading', { name: 'Untagged Board' });
    expect(screen.queryByText('No Label')).not.toBeInTheDocument();
  });

  it('caches the board and workspace in sessionStorage for the sync helpers', async () => {
    stubBoard();
    renderPage();

    await waitFor(() => {
      expect(sessionStorage.getItem('currentBoard')).not.toBeNull();
    });

    const stored = JSON.parse(sessionStorage.getItem('currentBoard')!);
    expect(stored).toMatchObject({
      boardId: 'b-1',
      boardName: 'SaH Care Management',
      boardLabel: 'Care Management - SaH',
      workspaceId: 'ws-1',
      workspaceName: 'Hillsgrade Care',
    });
    expect(typeof stored.timestamp).toBe('string');
  });

  it('renders nothing and logs when the board request fails', async () => {
    stubBoard(null, { status: 500 });
    renderPage();

    await waitFor(() => {
      expect(console.error).toHaveBeenCalled();
    });
    expect(
      screen.queryByRole('button', { name: 'Back to Workspace' }),
    ).not.toBeInTheDocument();
    expect(sessionStorage.getItem('currentBoard')).toBeNull();
  });

  it('navigates back to the workspace this board belongs to', async () => {
    stubBoard();
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Back to Workspace' }),
    );

    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1');
  });

  it('offers every feature of a Support-at-Home board to a support admin, each pointing at its own route', async () => {
    stubBoard();
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Configure Board' }),
    );
    await user.click(screen.getByRole('button', { name: 'Generate QR Code' }));
    await user.click(screen.getByRole('button', { name: 'Generate Invoice' }));
    await user.click(screen.getByRole('button', { name: 'View Statement' }));

    expect(router.push.mock.calls.map((c) => c[0])).toEqual([
      '/workspace/ws-1/board/b-1/configuration',
      '/workspace/ws-1/board/b-1/qr-generator',
      '/workspace/ws-1/board/b-1/invoice-generator',
      '/workspace/ws-1/board/b-1/monthly-statement',
    ]);
  });

  it('offers only the QR generator on a job-management board', async () => {
    stubBoard({ id: 'b-1', name: 'Field Jobs', label: 'Job Management' });
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Generate QR Code' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Configure Board' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Generate Invoice' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'View Statement' }),
    ).not.toBeInTheDocument();
  });

  it('withholds the monthly statement from an NDIS certification board but keeps invoicing', async () => {
    stubBoard({
      id: 'b-1',
      name: 'NDIS Cert',
      label: 'Care Management - NDIS - Certification',
    });
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Generate Invoice' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'View Statement' }),
    ).not.toBeInTheDocument();
  });

  it('withholds board configuration from a workspace admin who is not ISO+ support', async () => {
    localStorage.clear();
    seedContextStorage(ISOPLUS_USER, [
      { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'admin' },
    ]);
    stubChromeRequests(ISOPLUS_USER);
    stubBoard();
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Generate Invoice' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Configure Board' }),
    ).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each(['full_member', 'member'] as const)(
    'lets a workspace %s open board tools but not configuration',
    async (user_role) => {
      localStorage.clear();
      seedContextStorage(ISOPLUS_USER, [
        { id: 'ws-1', name: 'Hillsgrade Care', user_role },
      ]);
      stubChromeRequests(ISOPLUS_USER);
      stubBoard();
      renderPage();

      expect(
        await screen.findByRole('button', { name: 'Generate QR Code' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Generate Invoice' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'View Statement' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Configure Board' }),
      ).not.toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it('sends an ISO+ user with no workspace membership to access-denied', async () => {
    localStorage.clear();
    seedContextStorage(ISOPLUS_USER, [
      { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'viewer' },
    ]);
    stubChromeRequests(ISOPLUS_USER);
    stubBoard();
    renderPage();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/workspace/access-denied');
    });
  });
});

/**
 * KAN-22. Same problem as the workspace page: the dashboard caches an
 * `isoplus_user` as "restricted_member" unless a search enriched the role, so
 * the board page asks for the real role of this workspace and writes it into
 * the shared context before anything reads it.
 */
describe('Board detail page: refreshing the member role', () => {
  /**
   * Every role lookup, in order: `/api/workspaces?includeDetails=true`. The
   * page and its header may read `/api/workspaces` without that flag, which is
   * not what is under test here.
   */
  let roleRequests: URL[] = [];

  function stubRoleLookup(
    respond: (url: URL) => Response | Promise<Response>,
  ) {
    server.use(
      http.get('*/api/workspaces', ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('includeDetails') === 'true') {
          roleRequests.push(url);
        }
        return respond(url);
      }),
    );
  }

  function WorkspaceRoleProbe() {
    const { workspaces } = useAppContext();
    const role = workspaces.find((w) => w.id.toString() === 'ws-1')?.user_role;
    return <div data-testid="ws-role">{role ?? 'none'}</div>;
  }

  function renderWithRoleProbe() {
    return render(
      <ContextProvider>
        <WorkspaceRoleProbe />
        <BoardDetail />
      </ContextProvider>,
    );
  }

  beforeEach(() => {
    roleRequests = [];
    localStorage.clear();
    seedContextStorage(ISOPLUS_USER, [
      { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'restricted_member' },
    ]);
    stubChromeRequests(ISOPLUS_USER);
    stubBoard();
  });

  it('replaces the default restricted_member role with the real one for this workspace', async () => {
    stubRoleLookup(() =>
      HttpResponse.json({
        workspace: [{ id: 'ws-1', name: 'Hillsgrade Care', user_role: 'admin' }],
      }),
    );

    renderWithRoleProbe();

    await waitFor(() => {
      expect(screen.getByTestId('ws-role')).toHaveTextContent('admin');
    });
    const asked = roleRequests[0].searchParams;
    expect(asked.get('includeDetails')).toBe('true');
    expect(asked.get('q')).toBe('ws-1');
    expect(asked.get('limit')).toBe('10');
  });

  it('takes the role of this exact workspace id, not a workspace whose id merely contains it', async () => {
    stubRoleLookup(() =>
      HttpResponse.json({
        workspace: [
          { id: 'ws-10', name: 'Another Care', user_role: 'owner' },
          { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'full_member' },
        ],
      }),
    );

    renderWithRoleProbe();

    await waitFor(() => {
      expect(screen.getByTestId('ws-role')).toHaveTextContent('full_member');
    });
  });

  it('keeps the cached role and still opens the board when the lookup fails', async () => {
    stubRoleLookup(() =>
      HttpResponse.json({ message: 'ISO+ is unavailable' }, { status: 500 }),
    );

    renderWithRoleProbe();

    await waitFor(() => expect(roleRequests).not.toHaveLength(0));
    expect(
      await screen.findByRole('heading', { name: 'SaH Care Management' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('ws-role')).toHaveTextContent('restricted_member');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('never lets the lookup change the role of portal staff', async () => {
    // The context starts as an isoplus_user until it hydrates from storage, so
    // staff also send one lookup on mount. Its answer is discarded once the
    // real role (support_admin) is known; this pins that the discard happens.
    localStorage.clear();
    seedContextStorage(SUPPORT_ADMIN, [
      { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' },
    ]);
    stubChromeRequests(SUPPORT_ADMIN);
    stubRoleLookup(() =>
      HttpResponse.json({
        workspace: [
          { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'restricted_member' },
        ],
      }),
    );

    renderWithRoleProbe();

    await waitFor(() => expect(boardRequestUrls.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByTestId('ws-role')).toHaveTextContent('owner');
  });
});
