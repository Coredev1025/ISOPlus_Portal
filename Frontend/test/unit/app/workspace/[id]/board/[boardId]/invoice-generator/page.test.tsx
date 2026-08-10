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
import InvoiceGenerator from '@/app/workspace/[id]/board/[boardId]/invoice-generator/page';
import { dismissAllToasts } from '@/lib/toast-utils';

/**
 * The invoice generator page is an orchestrator: it slices the ids out of the
 * pathname, learns the board label (which decides both the endpoints it calls
 * and whether the user is allowed here at all), owns every filter and the page
 * number, and hands the lot to InvoiceGeneratorPageView. These tests pin the
 * id slicing, the context lifecycle, the loading/loaded/empty/failed states,
 * the label-driven endpoint switch, the filter-to-request wiring including the
 * page reset, and the back button.
 */

installBrowserStubs();

const router = makeRouter();
// id = pathname.split('/')[2]; boardId = pathname.split('/')[4]
const PATHNAME = '/workspace/ws-1/board/b-1/invoice-generator';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const WORKSPACE = { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' };

const BUSINESS = {
  name: 'Hillsgrade Care',
  headOfficeTimezone: 'Australia/Sydney',
};

/** One realistic Support-at-Home service record, as the API returns it. */
const RECORD = {
  id: 'item-9001',
  participant: 'Ivy Chen',
  service: 'Personal care - weekday daytime',
  // 15 March 2026 13:30 in Australia/Sydney (UTC+11).
  scheduledServiceDate: '2026-03-15T02:30:00.000Z',
  serviceDeliveryDate: '2026-03-15T04:00:00.000Z',
  transactionStatus: 'Delivered - To be claimed and invoiced.',
  unit: 'Hour',
  quantity: 2,
  unitPrice: 82.5,
  totalAmount: 165,
  govSubsidy: 148.5,
  participantContribution: 16.5,
  fundingSource: 'Home Support(HS) Quarterly',
  notes: '<p>Client requested a later start.</p>',
  paymentStatus: 'Gov Claim Submitted',
  invoiceNumber: '',
  fileUrl: '',
};

const RECORDS_RESPONSE = {
  items: [RECORD],
  total: 1,
  invoiced: 0,
  pending: 1,
  totalAmount: 165,
  totalGovSubsidy: 148.5,
  totalParticipantContribution: 16.5,
};

/** Service-record request URLs, in order, for both board flavours. */
let serviceRecordUrls: string[] = [];
let ndisServiceRecordUrls: string[] = [];

function stubInvoiceData(
  options: {
    boardLabel?: string;
    records?: Record<string, unknown>;
    recordsStatus?: number;
    recordsMessage?: string;
    gate?: Promise<void>;
  } = {},
) {
  server.use(
    http.get('*/api/business/profile', () => HttpResponse.json(BUSINESS)),
    http.get('*/api/boards', () =>
      HttpResponse.json({
        board: {
          id: 'b-1',
          name: 'SaH Care Management',
          label: options.boardLabel ?? 'Care Management - SaH',
        },
      }),
    ),
    http.get('*/api/items/:workspaceId/:boardId/invoice-generator/participants', () =>
      HttpResponse.json({ participants: ['Ivy Chen', 'Marcus Webb', ''] }),
    ),
    http.get('*/api/items/:workspaceId/:boardId/invoice-generator-ndis/participants', () =>
      HttpResponse.json({ participants: ['Ivy Chen', 'Marcus Webb'] }),
    ),
    http.get(
      '*/api/items/:workspaceId/:boardId/invoice-generator-ndis/payment-status-options',
      () => HttpResponse.json({ options: ['Awaiting Payment', 'Paid'] }),
    ),
    http.get('*/api/items/:workspaceId/:boardId/invoice-generator', async ({ request }) => {
      serviceRecordUrls.push(request.url);
      if (options.gate) await options.gate;
      if (options.recordsStatus && options.recordsStatus !== 200) {
        return HttpResponse.json(
          { message: options.recordsMessage ?? 'Service records unavailable' },
          { status: options.recordsStatus },
        );
      }
      return HttpResponse.json(options.records ?? RECORDS_RESPONSE);
    }),
    http.get('*/api/items/:workspaceId/:boardId/invoice-generator-ndis', ({ request }) => {
      ndisServiceRecordUrls.push(request.url);
      return HttpResponse.json({
        ...RECORDS_RESPONSE,
        statusFieldLabel: 'Claim Status',
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
      <InvoiceGenerator />
    </ContextProvider>,
  );
}

/** The last service-record request the page issued. */
function lastServiceRecordParams() {
  return new URL(serviceRecordUrls[serviceRecordUrls.length - 1]).searchParams;
}

beforeEach(() => {
  localStorage.clear();
  serviceRecordUrls = [];
  ndisServiceRecordUrls = [];
  router.push.mockClear();
  router.replace.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedContextStorage(SUPPORT_ADMIN, [WORKSPACE]);
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

describe('Invoice generator page', () => {
  it('asks for the service records of the workspace and board named in the pathname', async () => {
    stubInvoiceData();
    renderPage();

    await screen.findByText('Ivy Chen');

    const url = new URL(serviceRecordUrls[serviceRecordUrls.length - 1]);
    expect(url.pathname).toBe(
      '/undefined/api/items/ws-1/b-1/invoice-generator',
    );
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('sortBy')).toBe('scheduledServiceDate');
    expect(url.searchParams.get('sortOrder')).toBe('asc');
  });

  it('publishes the workspace id from the pathname to context, and clears it when the page unmounts', async () => {
    stubInvoiceData();

    function Harness({ showPage }: { showPage: boolean }) {
      return (
        <ContextProvider>
          <WorkspaceIdProbe />
          {showPage ? <InvoiceGenerator /> : null}
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

  it('shows the loading row until the service records arrive', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubInvoiceData({ gate });

    renderPage();

    expect(
      await screen.findByText('Loading service records...'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Ivy Chen')).not.toBeInTheDocument();

    release!();

    expect(await screen.findByText('Ivy Chen')).toBeInTheDocument();
    expect(
      screen.queryByText('Loading service records...'),
    ).not.toBeInTheDocument();
  });

  it('renders each service record and the totals the API reported', async () => {
    stubInvoiceData();
    renderPage();

    const participantCell = await screen.findByText('Ivy Chen');
    const row = participantCell.closest('tr')!;
    expect(within(row).getByText('Personal care - weekday daytime')).toBeInTheDocument();
    // Both dates fall on 15 March 2026 in Australia/Sydney.
    expect(within(row).getAllByText('15/03/2026')).toHaveLength(2);
    expect(within(row).getByText('Hour')).toBeInTheDocument();
    expect(within(row).getByText('$82.50')).toBeInTheDocument();
    expect(within(row).getByText('$165.00')).toBeInTheDocument();
    expect(within(row).getByText('$148.50')).toBeInTheDocument();
    expect(within(row).getByText('$16.50')).toBeInTheDocument();
    // Notes are stored as HTML and shown as plain text.
    expect(within(row).getByText('Client requested a later start.')).toBeInTheDocument();

    expect(screen.getByText('Total Records')).toBeInTheDocument();
    expect(screen.getByText('Total Government Subsidy')).toBeInTheDocument();
    expect(screen.getByText('Total Participant Contribution')).toBeInTheDocument();
  });

  it('says so when no record matches the current filters', async () => {
    stubInvoiceData({
      records: {
        items: [],
        total: 0,
        invoiced: 0,
        pending: 0,
        totalAmount: 0,
        totalGovSubsidy: 0,
        totalParticipantContribution: 0,
      },
    });
    renderPage();

    expect(
      await screen.findByText('No service records found matching your criteria.'),
    ).toBeInTheDocument();
  });

  it('shows the API error message in the table when the request fails', async () => {
    stubInvoiceData({
      recordsStatus: 500,
      recordsMessage: 'Board b-1 has not been synced yet',
    });
    renderPage();

    expect(
      await screen.findByText('Error: Board b-1 has not been synced yet'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Ivy Chen')).not.toBeInTheDocument();
    expect(console.error).toHaveBeenCalled();
  });

  it('re-requests filtered by the chosen participant', async () => {
    stubInvoiceData();
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Ivy Chen');
    const before = serviceRecordUrls.length;

    // The participant filter is the first combobox in the filters row.
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', {
        name: 'Marcus Webb',
      }),
    );

    await waitFor(() => {
      expect(serviceRecordUrls.length).toBeGreaterThan(before);
    });
    expect(lastServiceRecordParams().get('participant')).toBe('Marcus Webb');
  });

  it('drops back to the first page when a filter changes', async () => {
    stubInvoiceData({ records: { ...RECORDS_RESPONSE, total: 25 } });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Ivy Chen');

    // 25 records at 10 per page is 3 pages. The page links are anchors with no
    // href, so they carry no link role — query them inside the pagination nav.
    const pagination = screen.getByRole('navigation', { name: 'pagination' });
    await user.click(within(pagination).getByText('3'));
    await waitFor(() => {
      expect(lastServiceRecordParams().get('page')).toBe('3');
    });

    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', {
        name: 'Marcus Webb',
      }),
    );

    await waitFor(() => {
      expect(lastServiceRecordParams().get('participant')).toBe('Marcus Webb');
    });
    expect(lastServiceRecordParams().get('page')).toBe('1');
  });

  it('switches to the NDIS endpoints and columns once the board label says NDIS', async () => {
    stubInvoiceData({ boardLabel: 'Care Management - NDIS - Certification' });
    renderPage();

    await waitFor(() => {
      expect(ndisServiceRecordUrls.length).toBeGreaterThan(0);
    });
    expect(new URL(ndisServiceRecordUrls[0]).pathname).toBe(
      '/undefined/api/items/ws-1/b-1/invoice-generator-ndis',
    );
    expect(
      await screen.findByText('Manage NDIS service records and export NDIA claim CSV.'),
    ).toBeInTheDocument();
    // The NDIS table drops the two subsidy/contribution stat cards...
    expect(screen.queryByText('Total Government Subsidy')).not.toBeInTheDocument();
    // ...and names its status column from the API's statusFieldLabel.
    expect(
      screen.getByRole('columnheader', { name: 'Claim Status' }),
    ).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('turns the user away from a board that is not care management', async () => {
    stubInvoiceData({ boardLabel: 'Job Management' });
    renderPage();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/workspace/access-denied');
    });
  });

  it('navigates back to the board this page belongs to', async () => {
    stubInvoiceData();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Back to Board' }));

    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/board/b-1');
  });
});
