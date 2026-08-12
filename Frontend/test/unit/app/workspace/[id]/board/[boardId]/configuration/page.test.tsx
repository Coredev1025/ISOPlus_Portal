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
  ISOPLUS_USER,
} from '../../../../../page-test-utils';
import ConfigurationPage from '@/app/workspace/[id]/board/[boardId]/configuration/page';
import { dismissAllToasts } from '@/lib/toast-utils';

/**
 * The board configuration page slices the ids out of the pathname, loads the
 * board and the ISO+ attributes it may point at, and writes the whole form
 * back with one PUT. These tests pin the id slicing, the context lifecycle,
 * the support-only gate, the loading/loaded/failed states, the attribute
 * filtering and sorting, the label suggestion, and the exact save payload.
 */

installBrowserStubs();

const router = makeRouter();
// id = pathname.split('/')[2]; boardId = pathname.split('/')[4]
const PATHNAME = '/workspace/ws-1/board/b-1/configuration';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const WORKSPACE = { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' };

/** Deliberately unsorted, and mixing both ISO+ attribute types. */
const ATTRIBUTES = {
  attributes: [
    { id: 'attr-3', name: 'Zulu Integration Notes', type: 'long_text' },
    { id: 'attr-1', name: 'Client Reference', type: 'text' },
    { id: 'attr-2', name: 'Alpha PDF Links', type: 'long_text' },
  ],
};

const BOARD = {
  board: {
    id: 'b-1',
    name: 'SaH Care Management',
    label: 'Care Management - SaH',
    attribute: { id: 'attr-3', name: 'Zulu Integration Notes' },
    pdfAttribute: { id: 'attr-2', name: 'Alpha PDF Links' },
    syncData: true,
  },
};

let attributeUrls: string[] = [];
let boardUrls: string[] = [];
let boardPuts: Array<Record<string, unknown>> = [];
let automationPutUrls: string[] = [];

function stubConfigurationData(
  options: {
    board?: unknown;
    boardStatus?: number;
    attributesStatus?: number;
    gate?: Promise<void>;
  } = {},
) {
  server.use(
    http.get('*/api/boards/attribute', ({ request }) => {
      attributeUrls.push(request.url);
      if (options.attributesStatus && options.attributesStatus !== 200) {
        return HttpResponse.json(
          { message: 'Attributes unavailable' },
          { status: options.attributesStatus },
        );
      }
      return HttpResponse.json(ATTRIBUTES);
    }),
    http.get('*/api/boards', async ({ request }) => {
      boardUrls.push(request.url);
      if (options.gate) await options.gate;
      if (options.boardStatus && options.boardStatus !== 200) {
        return HttpResponse.json(
          { message: 'Board not found' },
          { status: options.boardStatus },
        );
      }
      return HttpResponse.json(options.board ?? BOARD);
    }),
    http.put('*/api/boards', async ({ request }) => {
      boardPuts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true });
    }),
    http.put('*/api/automation/*', ({ request }) => {
      automationPutUrls.push(request.url);
      return HttpResponse.json({ ok: true });
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
      <ConfigurationPage />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  attributeUrls = [];
  boardUrls = [];
  boardPuts = [];
  automationPutUrls = [];
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

describe('Board configuration page', () => {
  it('asks for the attributes and the board named in the pathname', async () => {
    stubConfigurationData();
    renderPage();

    await screen.findByRole('heading', { name: 'Board Configuration' });

    const attributeUrl = new URL(attributeUrls[0]);
    expect(attributeUrl.searchParams.get('workspaceId')).toBe('ws-1');
    expect(attributeUrl.searchParams.get('boardId')).toBe('b-1');
    expect(new URL(boardUrls[0]).searchParams.get('id')).toBe('b-1');
  });

  it('publishes the workspace id from the pathname to context, and clears it when the page unmounts', async () => {
    stubConfigurationData();

    function Harness({ showPage }: { showPage: boolean }) {
      return (
        <ContextProvider>
          <WorkspaceIdProbe />
          {showPage ? <ConfigurationPage /> : null}
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

  it('turns an ISO+ workspace owner away without loading anything', async () => {
    localStorage.clear();
    seedContextStorage(ISOPLUS_USER, [
      { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' },
    ]);
    stubChromeRequests(ISOPLUS_USER);
    stubConfigurationData();
    renderPage();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/workspace/access-denied');
    });
    expect(
      screen.queryByRole('heading', { name: 'Board Configuration' }),
    ).not.toBeInTheDocument();
    expect(attributeUrls).toHaveLength(0);
    expect(boardUrls).toHaveLength(0);
  });

  it('renders nothing until the board arrives', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubConfigurationData({ gate });

    renderPage();

    await waitFor(() => {
      expect(boardUrls.length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByRole('heading', { name: 'Board Configuration' }),
    ).not.toBeInTheDocument();

    release!();

    expect(
      await screen.findByRole('heading', { name: 'Board Configuration' }),
    ).toBeInTheDocument();
  });

  it("shows the board's saved label, attributes and sync flag once loaded", async () => {
    stubConfigurationData();
    renderPage();

    await screen.findByRole('heading', { name: 'Board Configuration' });

    const [labelSelect, messageAttribute, pdfAttribute] =
      screen.getAllByRole('combobox');
    expect(labelSelect).toHaveTextContent('Care Management - SaH');
    expect(messageAttribute).toHaveTextContent('Zulu Integration Notes');
    expect(pdfAttribute).toHaveTextContent('Alpha PDF Links');

    expect(
      screen.getByRole('checkbox', {
        name: 'Sync data from ISO+ to Portal database',
      }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Update Portal Automation' }),
    ).not.toBeChecked();
  });

  it('offers only long-text attributes, sorted by name', async () => {
    stubConfigurationData();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Board Configuration' });

    await user.click(screen.getAllByRole('combobox')[1]);

    const list = await screen.findByRole('listbox');
    // 'Client Reference' is type "text", so it is filtered out; the two
    // long-text attributes are sorted alphabetically, not left in API order.
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Alpha PDF LinksLong Text', 'Zulu Integration NotesLong Text']);
  });

  it('falls back to an empty board when the board request fails', async () => {
    stubConfigurationData({ boardStatus: 500 });
    renderPage();

    await screen.findByRole('heading', { name: 'Board Configuration' });

    expect(console.error).toHaveBeenCalled();
    expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('No Label');
    expect(
      screen.getByRole('checkbox', {
        name: 'Sync data from ISO+ to Portal database',
      }),
    ).not.toBeChecked();
  });

  it('still renders the form when the attribute request fails, with no attributes to pick', async () => {
    stubConfigurationData({ attributesStatus: 500 });
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Board Configuration' });
    expect(console.error).toHaveBeenCalled();

    await user.click(screen.getAllByRole('combobox')[1]);
    const list = await screen.findByRole('listbox');
    expect(within(list).queryAllByRole('option')).toHaveLength(0);
  });

  it('suggests a label from the board name and applies it when confirmed', async () => {
    stubConfigurationData({
      board: {
        board: {
          id: 'b-1',
          name: 'SaH Low Cat Support',
          label: 'No Label',
          syncData: false,
        },
      },
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Board Configuration' });
    await user.click(screen.getByRole('button', { name: /Suggest Label/ }));

    expect(
      await screen.findByText(
        "Based on the board name containing 'SaH' and 'Low Cat', we suggest labeling this as a Care Management - SaH - Low Cat board.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Yes, update label' }));

    await waitFor(() => {
      expect(screen.getAllByRole('combobox')[0]).toHaveTextContent(
        'Care Management - SaH - Low Cat',
      );
    });
  });

  it('saves the whole form as one board update carrying both ids from the pathname', async () => {
    stubConfigurationData();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Board Configuration' });
    await user.click(screen.getByRole('button', { name: 'Save Configuration' }));

    await waitFor(() => {
      expect(boardPuts).toHaveLength(1);
    });
    expect(boardPuts[0]).toEqual({
      id: 'b-1',
      name: 'SaH Care Management',
      label: 'Care Management - SaH',
      attributeId: 'attr-3',
      pdfAttributeId: 'attr-2',
      syncData: true,
      attribute: { id: 'attr-3', name: 'Zulu Integration Notes' },
      pdfAttribute: { id: 'attr-2', name: 'Alpha PDF Links' },
      boardId: 'b-1',
      workspaceId: 'ws-1',
    });
    expect(automationPutUrls).toHaveLength(0);
  });

  it('saves the label and sync flag the user actually changed', async () => {
    stubConfigurationData();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await screen.findByRole('heading', { name: 'Board Configuration' });
    const save = await screen.findByRole('button', { name: 'Save Configuration' });
    await waitFor(() => expect(save).toBeEnabled());

    await user.click(
      screen.getByRole('checkbox', {
        name: 'Sync data from ISO+ to Portal database',
      }),
    );
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', {
        name: 'Job Management',
      }),
    );
    await user.click(save);

    await waitFor(() => {
      expect(boardPuts).toHaveLength(1);
    });
    expect(boardPuts[0]).toMatchObject({
      label: 'Job Management',
      syncData: false,
      boardId: 'b-1',
      workspaceId: 'ws-1',
    });
  });

  it('updates the portal automation for this workspace and board only when asked', async () => {
    stubConfigurationData();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await screen.findByRole('heading', { name: 'Board Configuration' });
    const save = await screen.findByRole('button', { name: 'Save Configuration' });
    await waitFor(() => expect(save).toBeEnabled());

    await user.click(
      screen.getByRole('checkbox', { name: 'Update Portal Automation' }),
    );
    await user.click(save);

    await waitFor(() => {
      expect(automationPutUrls).toHaveLength(1);
    });
    // NEXT_PUBLIC_BACKEND_URL is unset under vitest, so the base is literally
    // "undefined"; the path the page builds is what matters.
    expect(new URL(automationPutUrls[0]).pathname).toBe(
      '/undefined/api/automation/ws-1/b-1',
    );
  });

  it('navigates back to the board this page belongs to', async () => {
    stubConfigurationData();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Back to Board/ }));

    expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/board/b-1');
  });
});
