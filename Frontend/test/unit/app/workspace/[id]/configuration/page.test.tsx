import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import WorkspaceConfiguration from '@/app/workspace/[id]/configuration/page';

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
 * The workspace configuration page is a two-button console over the dynamic
 * board-linking endpoints. It has no form fields; "bad input" is impossible, so
 * what is worth pinning is the workspace-scoped URL each button posts to, the
 * mutually-exclusive result panels, the HTML-entity decoding applied to the
 * matched template, and the two gates in front of the page (workspace not yet
 * in context, viewer not owner/support).
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/configuration';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const LINK_RESULT = [
  {
    link: {
      label: 'Client Register',
      targetBoardName: 'Care Board',
      targetName: 'Client Item',
    },
    originalMatch: '{{ Client Register &gt; Care Board &gt; Client Item }}',
    originItem: 'https://app.isoplus.online/items/123',
  },
];

let checkRequests: string[] = [];
let createRequests: string[] = [];

function stubLinks(options: { checkStatus?: number; checkResult?: unknown } = {}) {
  server.use(
    http.post('*/check-links', ({ request }) => {
      checkRequests.push(request.url);
      if (options.checkStatus && options.checkStatus !== 200) {
        return HttpResponse.json(
          { message: 'Board linking is unavailable' },
          { status: options.checkStatus },
        );
      }
      return HttpResponse.json(options.checkResult ?? LINK_RESULT);
    }),
    http.post('*/create-links', ({ request }) => {
      createRequests.push(request.url);
      return HttpResponse.json(LINK_RESULT);
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
      <WorkspaceConfiguration />
    </ContextProvider>,
  );
}

/** The Card wrapping a results heading. */
function resultsCard(heading: string): HTMLElement {
  return screen.getByText(heading).closest('div') as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
  // The router object is shared by every test in this file; reset its call log
  // so "was navigated" / "was not navigated" assertions cannot see an earlier
  // test's clicks.
  Object.values(router).forEach((fn) => fn.mockClear());
  checkRequests = [];
  createRequests = [];
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

describe('workspace configuration page', () => {
  it('publishes the workspace id to context and clears it when the page unmounts', async () => {
    stubLinks();

    function Harness({ showPage }: { showPage: boolean }) {
      return (
        <ContextProvider>
          <WorkspaceIdProbe />
          {showPage ? <WorkspaceConfiguration /> : null}
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

  it('shows only "Loading..." while the workspace is not in context yet', async () => {
    stubLinks();
    localStorage.clear();
    // A signed-in user whose workspace list has not been hydrated yet.
    localStorage.setItem('user', JSON.stringify(SUPPORT_ADMIN));

    renderPage();

    expect(await screen.findByText('Loading...')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Check Links/ }),
    ).not.toBeInTheDocument();
    // Still publishes the id, so the effect above the early return did run.
    expect(screen.getByTestId('ws-id')).toHaveTextContent('ws-1');
  });

  it('redirects an ISO+ user to access-denied and renders nothing', async () => {
    localStorage.clear();
    seedContextStorage(ISOPLUS_USER, [
      { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' },
    ]);
    stubChromeRequests(ISOPLUS_USER);
    stubLinks();

    renderPage();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/workspace/access-denied');
    });
    expect(
      screen.queryByRole('heading', { name: 'Workspace Configuration' }),
    ).not.toBeInTheDocument();
  });

  it('checks links against the workspace-scoped endpoint and renders each match decoded', async () => {
    stubLinks();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Check Links/ }));

    await waitFor(() => expect(checkRequests).toHaveLength(1));
    expect(
      new URL(checkRequests[0]).pathname.endsWith('/api/workspaces/ws-1/check-links'),
    ).toBe(true);

    const card = await screen
      .findByText('Link Check Results')
      .then((h) => h.closest('div') as HTMLElement);
    expect(card).toHaveTextContent('Label: Client Register');
    expect(card).toHaveTextContent('Target Board: Care Board');
    expect(card).toHaveTextContent('Target Name: Client Item');
    // "&gt;" arrives escaped from the API and is decoded before display.
    expect(card).toHaveTextContent('{{ Client Register > Care Board > Client Item }}');

    expect(
      screen.getByRole('link', { name: 'https://app.isoplus.online/items/123' }),
    ).toHaveAttribute('href', 'https://app.isoplus.online/items/123');
    expect(screen.queryByText('Link Creation Results')).not.toBeInTheDocument();
  });

  it('shows the no-links message when the check comes back empty', async () => {
    stubLinks({ checkResult: [] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Check Links/ }));

    expect(await screen.findByText('No links found to check')).toBeInTheDocument();
    expect(screen.queryByText('Label:')).not.toBeInTheDocument();
  });

  it('shows no results panel and logs when the check request fails', async () => {
    stubLinks({ checkStatus: 500 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Check Links/ }));

    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Error checking links:',
        expect.anything(),
      );
    });
    expect(screen.queryByText('Link Check Results')).not.toBeInTheDocument();
    // The button is usable again.
    expect(screen.getByRole('button', { name: /Check Links/ })).toBeEnabled();
  });

  it('creates links against its own endpoint and replaces the check results', async () => {
    stubLinks();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Check Links/ }));
    await screen.findByText('Link Check Results');

    await user.click(screen.getByRole('button', { name: /Create Links/ }));

    await waitFor(() => expect(createRequests).toHaveLength(1));
    expect(
      new URL(createRequests[0]).pathname.endsWith('/api/workspaces/ws-1/create-links'),
    ).toBe(true);

    expect(await screen.findByText('Link Creation Results')).toBeInTheDocument();
    expect(screen.queryByText('Link Check Results')).not.toBeInTheDocument();
    expect(resultsCard('Link Creation Results')).toHaveTextContent(
      'Label: Client Register',
    );
  });

  it('goes back to the workspace this page belongs to', async () => {
    stubLinks();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Back to Workspace/ }));
    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1');
  });
});
