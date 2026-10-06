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
} from '../../../page-test-utils';
import PDFOutputPage from '@/app/workspace/[id]/pdf-output/page';

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
 * The PDF output page reshapes `/api/pdf-links` rows for display: it renames
 * fields, hardcodes the signature provider, formats `createdAt` in the
 * business timezone and derives the download filename from the S3 link. It
 * paginates client-side at 10 rows. These tests pin that mapping, the paging,
 * the empty/failed states and the two navigations out of the page.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/pdf-output';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

/** Two realistic PDFLink documents. */
const PDF_LINKS = [
  {
    itemId: 'item-1001',
    type: 'Invoice',
    createdAt: '2026-03-04T14:00:00.000Z',
    createdBy: 'ada@example.com',
    SignatureStatus: true,
    pdfLink: 'https://isoplus-pdfs.s3.amazonaws.com/ws-1/INV-1000.pdf',
  },
  {
    itemId: 'item-1002',
    type: 'Quote',
    createdAt: '2026-03-03T09:30:00.000Z',
    createdBy: 'grace@example.com',
    SignatureStatus: false,
    pdfLink: 'https://isoplus-pdfs.s3.amazonaws.com/ws-1/QT-0007.pdf',
  },
];

/** 12 rows, so the 10-per-page client pagination has something to do. */
const MANY_PDF_LINKS = Array.from({ length: 12 }, (_, i) => ({
  itemId: `item-${2000 + i}`,
  type: i === 11 ? 'Purchase Order' : 'Invoice',
  createdAt: '2026-03-04T14:00:00.000Z',
  createdBy: `user${i}@example.com`,
  SignatureStatus: false,
  pdfLink: `https://isoplus-pdfs.s3.amazonaws.com/ws-1/DOC-${2000 + i}.pdf`,
}));

let listRequests: string[] = [];
let downloadBodies: unknown[] = [];
let anchorClicks: Array<{ href: string; download: string }> = [];

function stubPdfLinks(options: {
  rows?: unknown;
  status?: number;
  respond?: () => Response | Promise<Response>;
} = {}) {
  server.use(
    http.get('*/api/business/profile', () =>
      HttpResponse.json({
        name: 'Hillsgrade Care',
        headOfficeTimezone: 'Australia/Sydney',
      }),
    ),
    http.get('*/api/pdf-links', ({ request }) => {
      listRequests.push(request.url);
      if (options.respond) return options.respond();
      if (options.status && options.status !== 200) {
        return HttpResponse.json(
          { message: 'PDF links unavailable' },
          { status: options.status },
        );
      }
      return HttpResponse.json(options.rows ?? PDF_LINKS);
    }),
    http.post('*/api/pdf-links', async ({ request }) => {
      downloadBodies.push(await request.json());
      return new HttpResponse(new Uint8Array([37, 80, 68, 70]), {
        headers: { 'Content-Type': 'application/pdf' },
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
      <PDFOutputPage />
    </ContextProvider>,
  );
}

/** Document order: [0] is the Usage Summary table, [1] is Output History. */
function historyTable(): HTMLElement {
  return screen.getAllByRole('table')[1];
}

beforeEach(() => {
  localStorage.clear();
  // The router object is shared by every test in this file; reset its call log
  // so "was navigated" / "was not navigated" assertions cannot see an earlier
  // test's clicks.
  Object.values(router).forEach((fn) => fn.mockClear());
  listRequests = [];
  downloadBodies = [];
  anchorClicks = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // jsdom refuses to follow an <a download> click; record it instead.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchorClicks.push({ href: this.href, download: this.download });
  });
  seedContextStorage(SUPPORT_ADMIN, [
    { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' },
  ]);
  stubChromeRequests(SUPPORT_ADMIN);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('PDF output page', () => {
  it('asks for the PDF links of the workspace id in the pathname', async () => {
    stubPdfLinks();
    renderPage();

    await waitFor(() => expect(listRequests).toHaveLength(1));
    const url = new URL(listRequests[0]);
    expect(url.pathname.endsWith('/api/pdf-links')).toBe(true);
    // pathname is /workspace/ws-1/pdf-output -> split('/')[2] === 'ws-1'
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
  });

  it('leaves the history table empty until the request resolves', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubPdfLinks({
      respond: async () => {
        await gate;
        return HttpResponse.json(PDF_LINKS);
      },
    });

    renderPage();

    await screen.findByRole('heading', { name: 'Output History' });
    // header row only
    expect(within(historyTable()).getAllByRole('row')).toHaveLength(1);

    release!();

    await waitFor(() => {
      expect(within(historyTable()).getAllByRole('row')).toHaveLength(3);
    });
  });

  it('renders each PDF link with its type, business-timezone timestamp, author and signature state', async () => {
    stubPdfLinks();
    renderPage();

    await waitFor(() => {
      expect(within(historyTable()).getAllByRole('row')).toHaveLength(3);
    });

    const signed = within(historyTable())
      .getByRole('cell', { name: 'ada@example.com' })
      .closest('tr') as HTMLElement;
    // 2026-03-04T14:00:00Z in Australia/Sydney (UTC+11) -> 05/03/2026 01:00
    expect(
      within(signed).getAllByRole('cell').map((c) => c.textContent),
    ).toEqual(['Invoice', '05/03/2026 01:00', 'ada@example.com', 'Signed via ISOPlus', '']);

    const unsigned = within(historyTable())
      .getByRole('cell', { name: 'grace@example.com' })
      .closest('tr') as HTMLElement;
    // 2026-03-03T09:30:00Z in Australia/Sydney -> 03/03/2026 20:30
    expect(
      within(unsigned).getAllByRole('cell').map((c) => c.textContent),
    ).toEqual(['Quote', '03/03/2026 20:30', 'grace@example.com', 'Unsigned', '']);
  });

  it('renders no history rows and no pagination when the workspace has no PDFs', async () => {
    stubPdfLinks({ rows: [] });
    renderPage();

    await screen.findByRole('heading', { name: 'Output History' });
    await waitFor(() => expect(listRequests).toHaveLength(1));
    expect(within(historyTable()).getAllByRole('row')).toHaveLength(1);
    expect(screen.queryByRole('navigation', { name: 'pagination' })).not.toBeInTheDocument();
  });

  it('renders no history rows and logs when the PDF links request fails', async () => {
    stubPdfLinks({ status: 500 });
    renderPage();

    await screen.findByRole('heading', { name: 'Output History' });
    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Error fetching PDF outputs:',
        expect.anything(),
      );
    });
    expect(within(historyTable()).getAllByRole('row')).toHaveLength(1);
  });

  it('paginates the history at ten rows per page without re-requesting', async () => {
    stubPdfLinks({ rows: MANY_PDF_LINKS });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await waitFor(() => {
      // header + 10 rows
      expect(within(historyTable()).getAllByRole('row')).toHaveLength(11);
    });
    expect(screen.getByRole('cell', { name: 'user0@example.com' })).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'user11@example.com' }),
    ).not.toBeInTheDocument();

    const pagination = screen.getByRole('navigation', { name: 'pagination' });
    await user.click(within(pagination).getByText('2'));

    await waitFor(() => {
      // header + the remaining 2 rows
      expect(within(historyTable()).getAllByRole('row')).toHaveLength(3);
    });
    expect(screen.getByRole('cell', { name: 'user11@example.com' })).toBeInTheDocument();
    expect(listRequests).toHaveLength(1);
  });

  it('opens the detail page for the row that was clicked', async () => {
    stubPdfLinks();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    const row = await screen
      .findByRole('cell', { name: 'ada@example.com' })
      .then((cell) => cell.closest('tr') as HTMLElement);
    await user.click(row);

    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/pdf-output/item-1001');
  });

  it('downloads a row under the filename derived from its S3 link, without navigating', async () => {
    stubPdfLinks();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    const row = await screen
      .findByRole('cell', { name: 'ada@example.com' })
      .then((cell) => cell.closest('tr') as HTMLElement);
    await user.click(within(row).getByRole('button'));

    await waitFor(() => expect(downloadBodies).toHaveLength(1));
    expect(downloadBodies[0]).toEqual({ workspaceId: 'ws-1' });

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    // .../ws-1/INV-1000.pdf -> pop() -> "INV-1000.pdf" -> split('.pdf')[0]
    expect(anchorClicks[0].download).toBe('INV-1000.pdf');

    // The download button stops the row's own click handler.
    expect(router.push).not.toHaveBeenCalled();
  });

  it('routes Setup and Back to the workspace-scoped destinations', async () => {
    stubPdfLinks();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/pdf-output/configure');

    await user.click(screen.getByRole('button', { name: /Back to Workspace/ }));
    expect(router.replace).toHaveBeenCalledWith('/workspace/ws-1');
  });

  it('never publishes the workspace id to context', async () => {
    stubPdfLinks();
    renderPage();

    await screen.findByRole('cell', { name: 'ada@example.com' });
    expect(screen.getByTestId('ws-id')).toHaveTextContent('null');
  });
});
