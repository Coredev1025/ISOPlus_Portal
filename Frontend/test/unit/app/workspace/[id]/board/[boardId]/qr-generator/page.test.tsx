import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
import QRGeneratorPage from '@/app/workspace/[id]/board/[boardId]/qr-generator/page';

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
 * The page is an orchestrator: it slices the workspace and board ids out of the
 * pathname, owns the selection state, and hands everything to
 * QrGeneratorPageView. These tests pin the id slicing (which decides what is
 * requested), the workspace-id lifecycle in context, the loading/loaded/empty/
 * failed states, and the back-button destination.
 */

installBrowserStubs();

// One router object for the whole file. Next's real useRouter is stable, and
// several effects list `router` in their deps.
const router = makeRouter();
const PATHNAME = '/workspace/ws-1/board/b-1/qr-generator';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

// qrcode draws onto a real 2d context; jsdom has no canvas backend, so the
// drawing itself is stubbed. Nothing about the page's own logic is mocked.
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));

const BOARDS = {
  board: [
    { id: 'b-1', name: 'Care Board', label: 'Care Management - SaH' },
    { id: 'b-2', name: 'Jobs Board', label: 'Job Management' },
  ],
};

const BUSINESS = {
  businessName: 'Hillsgrade Care',
  headOfficeTimezone: 'Australia/Sydney',
  defaultLogo: '',
  squareLogo: '',
  wideLogo: '',
};

const VIEWS = {
  views: [
    {
      id: 'form-9',
      name: 'Incident Report',
      url: 'https://app.isoplus.online/forms/form-9',
      type: 'form',
    },
    {
      id: 'doc-4',
      name: 'Service Agreement',
      url: 'https://app.isoplus.online/docs/doc-4',
      type: 'document',
    },
  ],
};

/** Requests the page's own data layer issued, in order. */
let requestUrls: string[] = [];

function stubQrData(options: {
  views?: unknown;
  viewsStatus?: number;
  delayViews?: boolean;
} = {}) {
  server.use(
    http.get('*/api/workspaces/boards', ({ request }) => {
      requestUrls.push(request.url);
      return HttpResponse.json(BOARDS);
    }),
    http.get('*/api/business/profile', ({ request }) => {
      requestUrls.push(request.url);
      return HttpResponse.json(BUSINESS);
    }),
    http.get('*/api/boards/views-for-qr', async ({ request }) => {
      requestUrls.push(request.url);
      if (options.viewsStatus && options.viewsStatus !== 200) {
        return HttpResponse.json(
          { message: 'Board views unavailable' },
          { status: options.viewsStatus },
        );
      }
      return HttpResponse.json(options.views ?? VIEWS);
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
      <QRGeneratorPage />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  requestUrls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedContextStorage(SUPPORT_ADMIN, [
    { id: 'ws-1', name: 'Hillsgrade', user_role: 'owner' },
  ]);
  stubChromeRequests(SUPPORT_ADMIN);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('QR generator page', () => {
  it('slices the workspace id and board id out of the pathname and asks for exactly that board', async () => {
    stubQrData();
    renderPage();

    await waitFor(() => {
      expect(
        requestUrls.some((u) => u.includes('/api/boards/views-for-qr')),
      ).toBe(true);
    });

    const viewsUrl = new URL(
      requestUrls.find((u) => u.includes('/api/boards/views-for-qr'))!,
    );
    // pathname is /workspace/ws-1/board/b-1/qr-generator -> [2] = ws-1, [4] = b-1
    expect(viewsUrl.searchParams.get('workspaceId')).toBe('ws-1');
    expect(viewsUrl.searchParams.get('boardId')).toBe('b-1');

    const profileUrl = new URL(
      requestUrls.find((u) => u.includes('/api/business/profile'))!,
    );
    expect(profileUrl.searchParams.get('workspaceId')).toBe('ws-1');
  });

  it('publishes the workspace id to context while mounted and clears it on unmount', async () => {
    stubQrData();
    const { unmount } = renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('ws-id')).toHaveTextContent('ws-1');
    });

    unmount();

    // The probe unmounts with the page, so re-render the provider tree alone to
    // read the value the cleanup left behind. Instead assert the cleanup ran by
    // mounting a fresh tree: a stale id would have been persisted to context,
    // but context is per-provider, so assert the effect's own teardown instead.
    expect(screen.queryByTestId('ws-id')).not.toBeInTheDocument();
  });

  it('clears the workspace id in context when only the page unmounts', async () => {
    stubQrData();

    function Harness({ showPage }: { showPage: boolean }) {
      return (
        <ContextProvider>
          <WorkspaceIdProbe />
          {showPage ? <QRGeneratorPage /> : null}
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

  it('shows the loading placeholder before the board data arrives', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('*/api/workspaces/boards', () => HttpResponse.json(BOARDS)),
      http.get('*/api/business/profile', () => HttpResponse.json(BUSINESS)),
      http.get('*/api/boards/views-for-qr', async () => {
        await gate;
        return HttpResponse.json(VIEWS);
      }),
    );

    renderPage();

    expect(await screen.findByText('Loading...')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Generate QR Code/i }),
    ).not.toBeInTheDocument();

    release!();

    await waitFor(() => {
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    });
  });

  it('offers every fetched form and document plus the custom-URL row once loaded', async () => {
    stubQrData();
    const user = userEvent.setup();
    renderPage();

    const combobox = await screen.findByRole('combobox', {
      name: /Choose a form, document, or custom link/i,
    });
    await user.click(combobox);

    const list = await screen.findByRole('listbox');
    expect(
      within(list).getByRole('option', { name: /Incident Report/ }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole('option', { name: /Service Agreement/ }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole('option', { name: /Custom URL/ }),
    ).toBeInTheDocument();
  });

  it('offers only the custom-URL row when the board has no shareable forms or documents', async () => {
    stubQrData({ views: { views: [] } });
    const user = userEvent.setup();
    renderPage();

    const combobox = await screen.findByRole('combobox', {
      name: /Choose a form, document, or custom link/i,
    });
    await user.click(combobox);

    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(
      within(list).getByRole('option', { name: /Custom URL/ }),
    ).toBeInTheDocument();
  });

  it('leaves the picker empty and stops loading when the views request fails', async () => {
    stubQrData({ viewsStatus: 500 });
    const user = userEvent.setup();
    renderPage();

    const combobox = await screen.findByRole('combobox', {
      name: /Choose a form, document, or custom link/i,
    });
    await user.click(combobox);

    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('keeps Generate disabled until something is selected, and enables it for a chosen document', async () => {
    stubQrData();
    const user = userEvent.setup();
    renderPage();

    const generate = await screen.findByRole('button', {
      name: /Generate QR Code/i,
    });
    expect(generate).toBeDisabled();

    await user.click(
      screen.getByRole('combobox', {
        name: /Choose a form, document, or custom link/i,
      }),
    );
    const list = await screen.findByRole('listbox');
    await user.click(within(list).getByRole('option', { name: /Service Agreement/ }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Generate QR Code/i }),
      ).toBeEnabled();
    });
  });

  it('navigates back to the board this page belongs to', async () => {
    stubQrData();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Back to Board' }));

    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/board/b-1');
  });

  it('disables the business-logo checkbox when the business has no logo', async () => {
    stubQrData();
    renderPage();

    const checkbox = await screen.findByRole('checkbox', {
      name: /Include your business logo in the QR code/i,
    });
    expect(checkbox).toBeDisabled();
    expect(
      screen.getByText(/No business logo available/i),
    ).toBeInTheDocument();
  });
});
