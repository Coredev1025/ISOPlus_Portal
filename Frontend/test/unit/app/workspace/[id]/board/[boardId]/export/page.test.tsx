import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../../../../msw/server';
import { ContextProvider, useAppContext } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
} from '../../../../../page-test-utils';
import ExportPage from '@/app/workspace/[id]/board/[boardId]/export/page';

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
 * The export page is a shell: it slices the ids out of the pathname, loads the
 * workspace's boards so it can find the one it is scoped to, and renders a
 * static form. It renders nothing at all until both the workspace (from
 * context) and that board are available. These tests pin the id slicing, the
 * requests, the context lifecycle, the null/loaded states and the back button.
 */

installBrowserStubs();

const router = makeRouter();
// id = pathname.split('/')[2]; boardId = pathname.split('/')[4]
const PATHNAME = '/workspace/ws-1/board/b-1/export';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const WORKSPACE = { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' };

const BOARD_LIST = {
  board: [
    { id: 'b-1', name: 'SaH Care Management' },
    { id: 'b-2', name: 'Field Jobs' },
  ],
};

let boardsListUrls: string[] = [];
let boardDetailUrls: string[] = [];

function stubExportData(
  options: {
    boardList?: unknown;
    boardListStatus?: number;
    boardDetailStatus?: number;
    gate?: Promise<void>;
  } = {},
) {
  server.use(
    http.get('*/api/workspaces/boards', async ({ request }) => {
      boardsListUrls.push(request.url);
      if (options.gate) await options.gate;
      if (options.boardListStatus && options.boardListStatus !== 200) {
        return HttpResponse.json(
          { message: 'Workspace boards unavailable' },
          { status: options.boardListStatus },
        );
      }
      return HttpResponse.json(options.boardList ?? BOARD_LIST);
    }),
    http.get('*/api/boards', ({ request }) => {
      boardDetailUrls.push(request.url);
      if (options.boardDetailStatus && options.boardDetailStatus !== 200) {
        return HttpResponse.json(
          { message: 'Board not found' },
          { status: options.boardDetailStatus },
        );
      }
      return HttpResponse.json({
        board: { id: 'b-1', name: 'SaH Care Management', label: 'Care Management - SaH' },
      });
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
      <ExportPage />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  boardsListUrls = [];
  boardDetailUrls = [];
  router.push.mockClear();
  router.replace.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedContextStorage(SUPPORT_ADMIN, [WORKSPACE]);
  stubChromeRequests(SUPPORT_ADMIN);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Board export page', () => {
  it('asks for the boards of the workspace named in the pathname', async () => {
    stubExportData();
    renderPage();

    await screen.findByRole('heading', { name: 'Export Data' });

    expect(boardsListUrls.length).toBeGreaterThan(0);
    expect(new URL(boardsListUrls[0]).searchParams.get('workspaceId')).toBe('ws-1');
  });

  it('looks up a label per board, but always for the board in the pathname', async () => {
    stubExportData();
    renderPage();

    await screen.findByRole('heading', { name: 'Export Data' });

    // One request per board in the list...
    expect(boardDetailUrls).toHaveLength(BOARD_LIST.board.length);
    // ...but each one asks for the pathname's board id, never board.id, so
    // every board in the list ends up wearing b-1's label.
    expect(
      boardDetailUrls.map((u) => new URL(u).searchParams.get('id')),
    ).toEqual(['b-1', 'b-1']);
  });

  it('publishes the workspace id from the pathname to context, and clears it when the page unmounts', async () => {
    stubExportData();

    function Harness({ showPage }: { showPage: boolean }) {
      return (
        <ContextProvider>
          <WorkspaceIdProbe />
          {showPage ? <ExportPage /> : null}
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

  it('renders nothing until the board list arrives', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubExportData({ gate });

    renderPage();

    await waitFor(() => {
      expect(boardsListUrls.length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByRole('heading', { name: 'Export Data' }),
    ).not.toBeInTheDocument();

    release!();

    expect(
      await screen.findByRole('heading', { name: 'Export Data' }),
    ).toBeInTheDocument();
  });

  it('shows the export form, both tabs and the defaulted selections once loaded', async () => {
    stubExportData();
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Export Data' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Time Entries/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Reports/ })).toBeInTheDocument();

    // Only the active tab is mounted: a date-range picker and a format picker.
    const [dateRange, format] = screen.getAllByRole('combobox');
    expect(dateRange).toHaveTextContent('Last 30 Days');
    expect(format).toHaveTextContent('Excel');
    expect(
      screen.getByRole('button', { name: 'Export Time Entries' }),
    ).toBeInTheDocument();
  });

  it('stays blank when the workspace has no board matching the pathname', async () => {
    stubExportData({ boardList: { board: [{ id: 'b-9', name: 'Some Other Board' }] } });
    renderPage();

    await waitFor(() => {
      expect(boardDetailUrls.length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByRole('heading', { name: 'Export Data' }),
    ).not.toBeInTheDocument();
  });

  it('stays blank and logs when the board list request fails', async () => {
    stubExportData({ boardListStatus: 500 });
    renderPage();

    await waitFor(() => {
      expect(console.error).toHaveBeenCalled();
    });
    expect(
      screen.queryByRole('heading', { name: 'Export Data' }),
    ).not.toBeInTheDocument();
    expect(boardDetailUrls).toHaveLength(0);
  });

  it('still renders when only the per-board label lookup fails', async () => {
    stubExportData({ boardDetailStatus: 500 });
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Export Data' }),
    ).toBeInTheDocument();
    expect(console.error).toHaveBeenCalled();
  });

  it('navigates back to the board this page belongs to', async () => {
    stubExportData();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Back to Board/ }));

    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/board/b-1');
  });
});
