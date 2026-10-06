import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../../../msw/server';
import { ContextProvider, useAppContext } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
} from '../../../../page-test-utils';
import PDFOutputDetailPage from '@/app/workspace/[id]/pdf-output/[outputId]/page';

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
 * CHARACTERIZATION ONLY — this page does not do what its route says.
 *
 * `id` is `pathname.split('/')[2]`, i.e. the WORKSPACE id, and the row it looks
 * for is the one whose `itemId` equals the string `pdf-<workspaceId>`. The
 * `[outputId]` segment the user actually navigated to is never read, so for
 * real data the lookup always misses and the page bounces back to the list.
 * These tests pin that behaviour exactly as it stands; they are the thing that
 * would have to change if the lookup is ever fixed.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/pdf-output/item-1001';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

/** A row whose itemId is the outputId in the URL — the realistic case. */
const REAL_ROW = {
  itemId: 'item-1001',
  type: 'Invoice',
  createdAt: '2026-03-04T14:00:00.000Z',
  createdBy: 'ada@example.com',
  SignatureStatus: true,
  pdfLink: 'https://isoplus-pdfs.s3.amazonaws.com/ws-1/INV-1000.pdf',
};

/** The only shape this page can actually display: itemId === `pdf-${id}`. */
const MATCHABLE_ROW = { ...REAL_ROW, itemId: 'pdf-ws-1' };

let listRequests: string[] = [];

function stubPdfLinks(rows: unknown[] | null, status = 200) {
  server.use(
    http.get('*/api/pdf-links', ({ request }) => {
      listRequests.push(request.url);
      if (status !== 200) {
        return HttpResponse.json({ message: 'PDF links unavailable' }, { status });
      }
      return HttpResponse.json(rows ?? []);
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
      <PDFOutputDetailPage />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.values(router).forEach((fn) => fn.mockClear());
  listRequests = [];
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

describe('PDF output detail page', () => {
  it('requests the whole PDF link list for the workspace, not the single output in the URL', async () => {
    stubPdfLinks([REAL_ROW]);
    renderPage();

    await waitFor(() => expect(listRequests).toHaveLength(1));
    const url = new URL(listRequests[0]);
    expect(url.pathname.endsWith('/api/pdf-links')).toBe(true);
    // pathname is /workspace/ws-1/pdf-output/item-1001 -> split('/')[2] === 'ws-1'
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
    expect(url.searchParams.get('outputId')).toBeNull();
    expect(url.searchParams.get('itemId')).toBeNull();
  });

  it('bounces back to the list for a row whose itemId is the outputId in the URL', async () => {
    stubPdfLinks([REAL_ROW]);
    renderPage();

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/pdf-output');
    });
    expect(screen.queryByRole('heading', { name: 'INV-1000' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/ })).not.toBeInTheDocument();
  });

  it('bounces back to the list when the workspace has no PDFs at all', async () => {
    stubPdfLinks([]);
    renderPage();

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/pdf-output');
    });
  });

  it('bounces back to the list and logs when the request fails', async () => {
    stubPdfLinks(null, 500);
    renderPage();

    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Error fetching PDF outputs:',
        expect.anything(),
      );
    });
    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/pdf-output');
  });

  it('renders the document only when a row carries the synthetic id "pdf-<workspaceId>"', async () => {
    stubPdfLinks([MATCHABLE_ROW]);
    renderPage();

    // documentName comes from the S3 link: ".../INV-1000.pdf" -> "INV-1000"
    expect(await screen.findByRole('heading', { name: 'INV-1000' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download PDF/ })).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Signed via ISOPlus')).toBeInTheDocument();

    // The list mapper never produces signedBy/signedAt, so a signed document
    // still shows no "Signed By" block.
    expect(screen.queryByText('Signed By')).not.toBeInTheDocument();
  });

  it('pushes back to the list on the first render, before the fetch has resolved', async () => {
    // The redirect effect only tests `!output`, which is true on mount for
    // every visit — including the one visit that can eventually render.
    stubPdfLinks([MATCHABLE_ROW]);
    renderPage();

    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/pdf-output');
    expect(await screen.findByRole('heading', { name: 'INV-1000' })).toBeInTheDocument();
  });

  it('never publishes the workspace id to context', async () => {
    stubPdfLinks([MATCHABLE_ROW]);
    renderPage();

    await screen.findByRole('heading', { name: 'INV-1000' });
    expect(screen.getByTestId('ws-id')).toHaveTextContent('null');
  });
});
