import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
} from '../../../../page-test-utils';
import ConfigurePDFPage from '@/app/workspace/[id]/pdf-output/configure/page';

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
 * The PDF configure page is a plain controlled form over `/api/pdf/config`.
 * It performs NO client-side validation — the tests below pin that, because
 * "empty credentials are still submitted" is behaviour someone will otherwise
 * assume is guarded. They also pin the exact PUT body (the whole config object
 * plus the workspace id), the post-save navigation, and that a failed save
 * keeps the user's typing.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/pdf-output/configure';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const STORED_CONFIG = {
  basicPDF: { enabled: true, templates: { Invoice: 'template2' } },
  adobeSign: { enabled: false, clientId: '', clientSecret: '' },
  docuSign: { enabled: true, integrationKey: 'ik-abc123', accountId: 'acct-77' },
  pandaDoc: { enabled: false, apiKey: '', workspaceId: '' },
};

let getRequests: string[] = [];
let putBodies: unknown[] = [];

function stubConfig(options: {
  config?: unknown;
  getStatus?: number;
  putStatus?: number;
  gate?: Promise<void>;
} = {}) {
  server.use(
    http.get('*/api/pdf/config', ({ request }) => {
      getRequests.push(request.url);
      if (options.getStatus && options.getStatus !== 200) {
        return HttpResponse.json(
          { message: 'Config unavailable' },
          { status: options.getStatus },
        );
      }
      return HttpResponse.json(options.config ?? STORED_CONFIG);
    }),
    http.put('*/api/pdf/config', async ({ request }) => {
      putBodies.push(await request.json());
      if (options.gate) await options.gate;
      if (options.putStatus && options.putStatus !== 200) {
        return HttpResponse.json(
          { message: 'Could not save configuration' },
          { status: options.putStatus },
        );
      }
      return HttpResponse.json({ success: true });
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
      <ConfigurePDFPage />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.values(router).forEach((fn) => fn.mockClear());
  getRequests = [];
  putBodies = [];
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

describe('configure PDF output page', () => {
  it('loads the config for the workspace id in the pathname', async () => {
    stubConfig();
    renderPage();

    await waitFor(() => expect(getRequests).toHaveLength(1));
    const url = new URL(getRequests[0]);
    expect(url.pathname.endsWith('/api/pdf/config')).toBe(true);
    // pathname is /workspace/ws-1/pdf-output/configure -> split('/')[2] === 'ws-1'
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
  });

  it('fills the controls from the stored config', async () => {
    stubConfig();
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeChecked();
    });

    await user.click(screen.getByRole('tab', { name: 'DocuSign' }));

    expect(
      await screen.findByPlaceholderText('Enter your DocuSign Integration Key'),
    ).toHaveValue('ik-abc123');
    expect(
      screen.getByPlaceholderText('Enter your DocuSign Account ID'),
    ).toHaveValue('acct-77');
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('keeps the built-in empty defaults and logs when the config cannot be loaded', async () => {
    stubConfig({ getStatus: 500 });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Error fetching PDF configuration:',
        expect.anything(),
      );
    });
    expect(screen.getByRole('switch')).not.toBeChecked();

    await user.click(screen.getByRole('tab', { name: 'PandaDoc' }));
    expect(
      await screen.findByPlaceholderText('Enter your PandaDoc API Key'),
    ).toHaveValue('');
  });

  it('puts the whole config plus the workspace id, then returns to the PDF output page', async () => {
    stubConfig();
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(getRequests).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Save Configuration' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({ ...STORED_CONFIG, workspaceId: 'ws-1' });

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/pdf-output');
    });
  });

  it('sends the edits made in a provider tab', async () => {
    stubConfig();
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(getRequests).toHaveLength(1));
    await user.click(screen.getByRole('tab', { name: 'DocuSign' }));

    const accountId = await screen.findByPlaceholderText(
      'Enter your DocuSign Account ID',
    );
    await user.clear(accountId);
    await user.type(accountId, 'acct-99');

    await user.click(screen.getByRole('button', { name: 'Save Configuration' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({
      ...STORED_CONFIG,
      docuSign: { enabled: true, integrationKey: 'ik-abc123', accountId: 'acct-99' },
      workspaceId: 'ws-1',
    });
  });

  it('saves an entirely blank set of credentials without validating anything', async () => {
    const BLANK = {
      basicPDF: { enabled: false, templates: {} },
      adobeSign: { enabled: true, clientId: '', clientSecret: '' },
      docuSign: { enabled: true, integrationKey: '', accountId: '' },
      pandaDoc: { enabled: true, apiKey: '', workspaceId: '' },
    };
    stubConfig({ config: BLANK });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(getRequests).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Save Configuration' }));

    // Three providers enabled with no keys at all: still submitted as-is.
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({ ...BLANK, workspaceId: 'ws-1' });
    expect(screen.queryByText(/required/i)).not.toBeInTheDocument();
  });

  it('shows the saving state while the request is in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubConfig({ gate });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(getRequests).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Save Configuration' }));

    expect(await screen.findByRole('button', { name: /Saving\.\.\./ })).toBeDisabled();

    release!();

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/workspace/ws-1/pdf-output');
    });
  });

  it('keeps the typed values and stays on the page when the save fails', async () => {
    stubConfig({ putStatus: 500 });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(getRequests).toHaveLength(1));
    await user.click(screen.getByRole('tab', { name: 'Adobe Sign' }));

    const clientId = await screen.findByPlaceholderText(
      'Enter your Adobe Sign Client ID',
    );
    await user.type(clientId, 'adobe-client-1');

    await user.click(screen.getByRole('button', { name: 'Save Configuration' }));

    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Error saving PDF configuration:',
        expect.anything(),
      );
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(
      screen.getByPlaceholderText('Enter your Adobe Sign Client ID'),
    ).toHaveValue('adobe-client-1');
    expect(
      screen.getByRole('button', { name: 'Save Configuration' }),
    ).toBeEnabled();
  });

  it('goes back through history rather than to a computed route', async () => {
    stubConfig();
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: /Back to PDF Output/ }),
    );
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('never publishes the workspace id to context', async () => {
    stubConfig();
    renderPage();

    await waitFor(() => expect(getRequests).toHaveLength(1));
    expect(screen.getByTestId('ws-id')).toHaveTextContent('null');
  });
});
