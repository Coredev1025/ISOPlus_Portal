import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../../msw/server';
import { ContextProvider } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
} from '../../../page-test-utils';
import XeroIntegrationPage from '@/app/workspace/[id]/xero-integration/page';
import { dismissAllToasts } from '@/lib/toast-utils';

/**
 * The Xero page reads the connection state off the business profile, decides
 * connected / connected-but-expired / disconnected from it, and runs the OAuth
 * handshake through a popup plus a `postMessage` from the callback window.
 *
 * These tests pin all three states, the redirect request, the popup that is
 * opened, and — the part a spy could not prove — the exact body posted to
 * `/api/business/xero/connect` once the popup reports success.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/xero-integration';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const ORGANIZATION = {
  name: 'Hillsgrade Care Pty Ltd',
  legalName: 'Hillsgrade Care Proprietary Limited',
  shortCode: '!HGC1',
  baseCurrency: 'AUD',
  countryCode: 'AU',
};

const NOW_SECONDS = Math.floor(Date.now() / 1000);

type ProfileOptions = {
  xeroIntegrated?: boolean;
  expiresAt?: number;
  organization?: unknown;
  status?: number;
};

let redirectRequests: string[] = [];
let connectBodies: unknown[] = [];
let disconnectBodies: unknown[] = [];
let updateOrgBodies: unknown[] = [];
/** Arguments window.open was called with. */
let popupCalls: unknown[][] = [];

/**
 * The page adds a `message` listener when a connect flow starts and only ever
 * removes it when a XERO_AUTH message arrives — never on unmount. Without this
 * bookkeeping a listener left behind by one test fires again in the next one.
 * See the last test in this file, which pins that leak deliberately.
 */
let leakedMessageListeners: EventListenerOrEventListenerObject[] = [];
const realAddEventListener = window.addEventListener.bind(window);

function trackMessageListeners() {
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'message') leakedMessageListeners.push(listener);
    return realAddEventListener(type, listener, options);
  }) as typeof window.addEventListener);
}

function stubXero(profile: ProfileOptions = {}, redirect: { url?: string; error?: string } = {}) {
  server.use(
    http.get('*/api/business/profile', () => {
      if (profile.status && profile.status !== 200) {
        return HttpResponse.json({ message: 'Profile unavailable' }, { status: profile.status });
      }
      const integrated = profile.xeroIntegrated ?? false;
      return HttpResponse.json({
        name: 'Hillsgrade Care',
        headOfficeTimezone: 'Australia/Sydney',
        xeroIntegrated: integrated,
        xeroTokens: integrated
          ? { expiresAt: profile.expiresAt ?? NOW_SECONDS }
          : undefined,
        xeroOrganization:
          'organization' in profile ? profile.organization : ORGANIZATION,
      });
    }),
    http.get('*/api/xero/redirect', ({ request }) => {
      redirectRequests.push(request.url);
      return HttpResponse.json(
        redirect.url !== undefined || redirect.error !== undefined
          ? redirect
          : { url: 'https://login.xero.com/identity/connect/authorize?state=abc' },
      );
    }),
    http.post('*/api/business/xero/connect', async ({ request }) => {
      connectBodies.push(await request.json());
      return HttpResponse.json({ success: true });
    }),
    http.post('*/api/business/xero/disconnect', async ({ request }) => {
      disconnectBodies.push(await request.json());
      return HttpResponse.json({ success: true });
    }),
    http.post('*/api/business/xero/update-organization', async ({ request }) => {
      updateOrgBodies.push(await request.json());
      return HttpResponse.json({
        success: true,
        organization: { ...ORGANIZATION, name: 'Hillsgrade Care (refreshed)' },
      });
    }),
  );
}

function renderPage() {
  return render(
    <ContextProvider>
      <XeroIntegrationPage />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // The router object is shared by every test in this file; reset its call log
  // so "was navigated" / "was not navigated" assertions cannot see an earlier
  // test's clicks.
  Object.values(router).forEach((fn) => fn.mockClear());
  redirectRequests = [];
  connectBodies = [];
  disconnectBodies = [];
  updateOrgBodies = [];
  popupCalls = [];
  leakedMessageListeners = [];
  trackMessageListeners();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // jsdom has no window.open; the page needs one that returns something with
  // close(). Environment stub, not a stand-in for page logic.
  vi.stubGlobal(
    'open',
    vi.fn((...args: unknown[]) => {
      popupCalls.push(args);
      return { close: vi.fn() };
    }),
  );
  seedContextStorage(SUPPORT_ADMIN, [
    { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' },
  ]);
  stubChromeRequests(SUPPORT_ADMIN);
});

afterEach(() => {
  leakedMessageListeners.forEach((listener) =>
    window.removeEventListener('message', listener),
  );
  leakedMessageListeners = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});


// Removing the toastify nodes does not cancel the dismiss timer toastify-js
// schedules for each one. When that timer fires after jsdom has been torn down
// it throws `ReferenceError: document is not defined` as an unhandled error,
// failing the run even though every assertion passed. Dismissing through the
// app's own API clears the timers too.
afterEach(() => {
  dismissAllToasts();
});

describe('Xero integration page', () => {
  it('checks the connection using the workspace id in the pathname', async () => {
    let profileUrl = '';
    server.use(
      http.get('*/api/business/profile', ({ request }) => {
        profileUrl = request.url;
        return HttpResponse.json({ xeroIntegrated: false });
      }),
    );
    renderPage();

    await waitFor(() => expect(profileUrl).not.toBe(''));
    const url = new URL(profileUrl);
    expect(url.pathname.endsWith('/api/business/profile')).toBe(true);
    // pathname is /workspace/ws-1/xero-integration -> split('/')[2] === 'ws-1'
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
  });

  it('offers Connect and shows no organization panel when Xero is not integrated', async () => {
    stubXero({ xeroIntegrated: false });
    renderPage();

    expect(
      await screen.findByRole('button', { name: /Connect to Xero/ }),
    ).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: /Disconnect from Xero/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Connected Organization')).not.toBeInTheDocument();
  });

  it('shows the connected organization and offers Disconnect when the token is current', async () => {
    stubXero({ xeroIntegrated: true, expiresAt: NOW_SECONDS });
    renderPage();

    expect(await screen.findByText('Connected Organization')).toBeInTheDocument();
    expect(screen.getByText('Hillsgrade Care Pty Ltd')).toBeInTheDocument();
    expect(screen.getByText('Hillsgrade Care Proprietary Limited')).toBeInTheDocument();
    expect(screen.getByText('!HGC1')).toBeInTheDocument();
    expect(screen.getByText('AUD')).toBeInTheDocument();
    expect(screen.getByText('AU')).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: /Disconnect from Xero/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Reconnect to Xero/ }),
    ).not.toBeInTheDocument();
  });

  it('offers Reconnect instead when the stored token has aged past the refresh window', async () => {
    // expiresAt is in seconds; 0 puts (expiresAt + 60d - 30m) * 1000 in 1970.
    stubXero({ xeroIntegrated: true, expiresAt: 0 });
    renderPage();

    expect(
      await screen.findByRole('button', { name: /Reconnect to Xero/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Disconnect from Xero/ }),
    ).not.toBeInTheDocument();
  });

  it('prompts for the organization details when connected without them', async () => {
    stubXero({ xeroIntegrated: true, organization: undefined });
    renderPage();

    expect(await screen.findByText('Connected to Xero')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Get Organization Info' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Connected Organization')).not.toBeInTheDocument();
  });

  it('asks the backend for a redirect URL and opens it in the Xero popup', async () => {
    stubXero({ xeroIntegrated: false });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Connect to Xero/ }));

    await waitFor(() => expect(redirectRequests).toHaveLength(1));
    const url = new URL(redirectRequests[0]);
    expect(url.pathname.endsWith('/api/xero/redirect')).toBe(true);
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');

    await waitFor(() => expect(popupCalls).toHaveLength(1));
    expect(popupCalls[0][0]).toBe(
      'https://login.xero.com/identity/connect/authorize?state=abc',
    );
    expect(popupCalls[0][1]).toBe('Xero Integration');
    expect(String(popupCalls[0][2])).toContain('width=600,height=600');
  });

  it('posts the tokens and organization the popup reports back, scoped to this workspace', async () => {
    stubXero({ xeroIntegrated: false });
    const user = userEvent.setup();
    const { container } = renderPage();

    await user.click(await screen.findByRole('button', { name: /Connect to Xero/ }));
    await waitFor(() => expect(popupCalls).toHaveLength(1));

    const tokenSet = {
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expiresAt: NOW_SECONDS + 1800,
    };

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'XERO_AUTH',
            success: true,
            tokenSet,
            organization: ORGANIZATION,
          },
        }),
      );
    });

    await waitFor(() => expect(connectBodies).toHaveLength(1));
    expect(connectBodies[0]).toEqual({
      workspaceId: 'ws-1',
      tokens: tokenSet,
      organization: ORGANIZATION,
    });

    // Scoped to the page: the same wording is also rendered into a toast that
    // Toastify appends directly to document.body.
    await waitFor(() => {
      expect(
        within(container).getByText('Successfully connected to Xero!'),
      ).toBeInTheDocument();
    });
    expect(within(container).getByText('Hillsgrade Care Pty Ltd')).toBeInTheDocument();
  });

  it('reports the reason and opens no popup when the backend returns no redirect URL', async () => {
    stubXero({ xeroIntegrated: false }, { error: 'Xero client is not configured' });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Connect to Xero/ }));

    expect(
      await screen.findByText('Error: Xero client is not configured'),
    ).toBeInTheDocument();
    expect(popupCalls).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: /Connect to Xero/ }),
    ).toBeEnabled();
  });

  it('disconnects with the workspace id in the body and returns to the disconnected state', async () => {
    stubXero({ xeroIntegrated: true, expiresAt: NOW_SECONDS });
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: /Disconnect from Xero/ }),
    );

    await waitFor(() => expect(disconnectBodies).toHaveLength(1));
    expect(disconnectBodies[0]).toEqual({ workspaceId: 'ws-1' });

    expect(
      await screen.findByText('Successfully disconnected from Xero!'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect to Xero/ })).toBeInTheDocument();
    expect(screen.queryByText('Connected Organization')).not.toBeInTheDocument();
  });

  it('refreshes the organization details from the backend on demand', async () => {
    stubXero({ xeroIntegrated: true, expiresAt: NOW_SECONDS });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(updateOrgBodies).toHaveLength(1));
    expect(updateOrgBodies[0]).toEqual({ workspaceId: 'ws-1' });

    expect(
      await screen.findByText('Hillsgrade Care (refreshed)'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Organization information updated successfully!'),
    ).toBeInTheDocument();
  });

  it('keeps listening for the popup handshake after the page has unmounted', async () => {
    // Characterization, not endorsement: handleConnectXero returns its cleanup
    // function to nobody, so the `message` listener outlives the component and
    // a late callback still posts to the backend.
    stubXero({ xeroIntegrated: false });
    const user = userEvent.setup();
    const { unmount } = renderPage();

    await user.click(await screen.findByRole('button', { name: /Connect to Xero/ }));
    await waitFor(() => expect(popupCalls).toHaveLength(1));

    unmount();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'XERO_AUTH',
            success: true,
            tokenSet: { access_token: 'at-late' },
            organization: ORGANIZATION,
          },
        }),
      );
    });

    await waitFor(() => expect(connectBodies).toHaveLength(1));
    expect(connectBodies[0]).toEqual({
      workspaceId: 'ws-1',
      tokens: { access_token: 'at-late' },
      organization: ORGANIZATION,
    });
  });

  it('stays on the disconnected state and logs when the profile lookup fails', async () => {
    stubXero({ status: 500 });
    renderPage();

    expect(
      await screen.findByRole('button', { name: /Connect to Xero/ }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Error checking Xero connection:',
        expect.anything(),
      );
    });
  });
});
