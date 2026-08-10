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
import MonthlyStatement from '@/app/workspace/[id]/board/[boardId]/monthly-statement/page';
import { dismissAllToasts } from '@/lib/toast-utils';

/**
 * The monthly statement page slices the ids out of the pathname, checks the
 * board label decides this page is allowed at all, loads the participant list
 * and the business profile, and then loads one statement on demand. These
 * tests pin the id slicing, the label gate, the participant picker, the
 * empty/loaded/failed states of the statement itself, and the back button.
 */

installBrowserStubs();

const router = makeRouter();
// id = pathname.split('/')[2]; boardId = pathname.split('/')[4]
const PATHNAME = '/workspace/ws-1/board/b-1/monthly-statement';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const WORKSPACE = { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' };

const BUSINESS = {
  name: 'Hillsgrade Care Pty Ltd',
  phone: '02 4782 1000',
  email: 'accounts@hillsgrade.example',
  address: {
    street: '12 Wattle Street',
    suburb: 'Katoomba',
    state: 'NSW',
    postcode: '2780',
    country: 'Australia',
  },
  companyRegistrationId: '51 824 753 556',
  headOfficeTimezone: 'Australia/Sydney',
};

const SERVICE = {
  id: 'item-7001',
  participant: 'Ivy Chen',
  service: 'Personal care - weekday daytime',
  taskName: 'Personal care - weekday daytime',
  scheduledServiceDate: '2026-03-05T22:00:00.000Z',
  serviceDeliveryDate: '2026-03-05T23:30:00.000Z',
  transactionStatus: 'Delivered - To be claimed and invoiced.',
  fundingSource: 'Home Support(HS) Quarterly',
  unit: 'Hour',
  quantity: 2,
  unitPrice: 82.5,
  totalAmount: 165,
  govSubsidy: 148.5,
  participantContribution: 16.5,
  notes: '',
};

const STATEMENT = {
  participant: 'Ivy Chen',
  participantProfile: 'Ivy Chen',
  month: 'March',
  monthNumber: '03',
  year: '2026',
  participantAddress: '8 Banksia Court',
  participantSuburb: 'Leura',
  participantState: 'NSW',
  participantPostcode: '2780',
  myAgedCareIdNumber: 'AC-90210',
  providerId: 'PRV-4471',
  fundingSources: [],
  budgetCategories: [],
  budgetItems: { items: {}, page: 1, limit: 10, total: 0 },
  serviceItems: {
    items: [SERVICE],
    page: 1,
    limit: 10,
    total: 1,
    distinctTransactionStatuses: ['Delivered - To be claimed and invoiced.'],
    distinctFundingSources: ['Home Support(HS) Quarterly'],
  },
  summary: {
    totalServices: 1,
    totalHours: 2,
    totalAmount: 165,
    govSubsidy: 148.5,
    participantContribution: 16.5,
  },
};

let boardUrls: string[] = [];
let participantUrls: string[] = [];
let statementUrls: string[] = [];

function stubStatementData(
  options: {
    boardLabel?: string;
    participants?: string[];
    statementStatus?: number;
  } = {},
) {
  server.use(
    http.get('*/api/boards', ({ request }) => {
      boardUrls.push(request.url);
      return HttpResponse.json({
        board: {
          id: 'b-1',
          name: 'SaH Care Management',
          label: options.boardLabel ?? 'Care Management - SaH',
        },
      });
    }),
    http.get('*/api/business/profile', () => HttpResponse.json(BUSINESS)),
    http.get(
      '*/api/items/:workspaceId/:boardId/monthly-statement/participants',
      ({ request }) => {
        participantUrls.push(request.url);
        return HttpResponse.json({
          participants: options.participants ?? ['Ivy Chen', 'Marcus Webb'],
        });
      },
    ),
    http.get('*/api/items/:workspaceId/:boardId/monthly-statement', ({ request }) => {
      statementUrls.push(request.url);
      if (options.statementStatus && options.statementStatus !== 200) {
        return HttpResponse.json(
          { message: 'Statement unavailable' },
          { status: options.statementStatus },
        );
      }
      return HttpResponse.json(STATEMENT);
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
      <MonthlyStatement />
    </ContextProvider>,
  );
}

/** Picks a participant in the first combobox of the toolbar. */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  comboboxIndex: number,
  optionName: string,
) {
  await user.click(screen.getAllByRole('combobox')[comboboxIndex]);
  await user.click(
    within(await screen.findByRole('listbox')).getByRole('option', {
      name: optionName,
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  boardUrls = [];
  participantUrls = [];
  statementUrls = [];
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

describe('Monthly statement page', () => {
  it('asks for the board and the participants named in the pathname', async () => {
    stubStatementData();
    renderPage();

    await waitFor(() => {
      expect(participantUrls.length).toBeGreaterThan(0);
    });
    expect(new URL(boardUrls[0]).searchParams.get('id')).toBe('b-1');
    expect(new URL(participantUrls[0]).pathname).toBe(
      '/undefined/api/items/ws-1/b-1/monthly-statement/participants',
    );
  });

  it('never publishes a workspace id to context, unlike its sibling board pages', async () => {
    stubStatementData();
    renderPage();

    await screen.findByRole('heading', { name: 'Monthly Statement Generator' });
    await waitFor(() => {
      expect(participantUrls.length).toBeGreaterThan(0);
    });

    // The page reads syncStatuses from context but never calls
    // setCurrentWorkspaceId, so the header's sync indicator stays idle here.
    expect(screen.getByTestId('ws-id')).toHaveTextContent('null');
  });

  it('offers every participant the board returned', async () => {
    stubStatementData();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Monthly Statement Generator' });
    await user.click(screen.getAllByRole('combobox')[0]);

    const list = await screen.findByRole('listbox');
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Ivy Chen', 'Marcus Webb']);
  });

  it('says so when the board has no participants at all', async () => {
    stubStatementData({ participants: [] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Monthly Statement Generator' });
    await user.click(screen.getAllByRole('combobox')[0]);

    expect(
      await screen.findByRole('option', { name: 'No participants found' }),
    ).toBeInTheDocument();
  });

  it('starts empty, with the statement locked until a participant is chosen', async () => {
    stubStatementData();
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'No Statement Loaded' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load Statement' })).toBeDisabled();
    expect(statementUrls).toHaveLength(0);

    await choose(user, 0, 'Ivy Chen');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Load Statement' })).toBeEnabled();
    });
    // Choosing a participant does not load anything on its own.
    expect(statementUrls).toHaveLength(0);
  });

  it('loads the statement for the chosen participant and month', async () => {
    stubStatementData();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Monthly Statement Generator' });
    await choose(user, 0, 'Ivy Chen');
    await choose(user, 1, 'March');
    await user.click(screen.getByRole('button', { name: 'Load Statement' }));

    await waitFor(() => {
      expect(statementUrls).toHaveLength(1);
    });
    const params = new URL(statementUrls[0]).searchParams;
    expect(new URL(statementUrls[0]).pathname).toBe(
      '/undefined/api/items/ws-1/b-1/monthly-statement',
    );
    expect(params.get('participant')).toBe('Ivy Chen');
    expect(params.get('month')).toBe('03');
    expect(params.get('budgetPage')).toBe('1');
    expect(params.get('budgetLimit')).toBe('10');
    expect(params.get('servicePage')).toBe('1');
    expect(params.get('serviceLimit')).toBe('10');
    expect(params.get('serviceSortBy')).toBe('scheduledServiceDate');
    expect(params.get('serviceSortOrder')).toBe('asc');

    const heading = await screen.findByRole('heading', {
      name: 'Support at Home Monthly Statement',
    });
    // The statement header names the period and the participant it is for.
    const headerBlock = heading.parentElement!;
    expect(within(headerBlock).getByText('March 2026')).toBeInTheDocument();
    expect(within(headerBlock).getByText('Ivy Chen')).toBeInTheDocument();
    // ...and the participant details come straight from the API payload.
    expect(screen.getByText('8 Banksia Court')).toBeInTheDocument();
    expect(screen.getByText('AC-90210')).toBeInTheDocument();
    expect(screen.getByText('PRV-4471')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'No Statement Loaded' }),
    ).not.toBeInTheDocument();
  });

  it('defaults the month and year to today when the user changes neither', async () => {
    stubStatementData();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Monthly Statement Generator' });
    await choose(user, 0, 'Ivy Chen');
    await user.click(screen.getByRole('button', { name: 'Load Statement' }));

    await waitFor(() => {
      expect(statementUrls).toHaveLength(1);
    });
    const now = new Date();
    const params = new URL(statementUrls[0]).searchParams;
    expect(params.get('month')).toBe(String(now.getMonth() + 1).padStart(2, '0'));
    expect(params.get('year')).toBe(String(now.getFullYear()));
  });

  it('keeps the empty state and reports the failure when the statement will not load', async () => {
    stubStatementData({ statementStatus: 500 });
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Monthly Statement Generator' });
    await choose(user, 0, 'Ivy Chen');
    await user.click(screen.getByRole('button', { name: 'Load Statement' }));

    expect(
      await screen.findByText('Failed to fetch statement data'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'No Statement Loaded' }),
    ).toBeInTheDocument();
    expect(console.error).toHaveBeenCalled();
  });

  it('turns the user away from a low-category board', async () => {
    stubStatementData({ boardLabel: 'Care Management - SaH - Low Cat' });
    renderPage();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/workspace/access-denied');
    });
    expect(participantUrls).toHaveLength(0);
  });

  it('turns the user away from a board that is not care management', async () => {
    stubStatementData({ boardLabel: 'Job Management' });
    renderPage();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/workspace/access-denied');
    });
    expect(participantUrls).toHaveLength(0);
  });

  it('navigates back to the board this page belongs to', async () => {
    stubStatementData();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Back to Board' }));

    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/board/b-1');
  });
});
