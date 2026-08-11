import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { useInvoiceGeneratorSetup } from '@/lib/use-invoice-generator-setup';
import { server } from '../../msw/server';

/**
 * Characterization tests for the invoice generator's page bootstrap hook.
 *
 * The hook owns four effects and no state of its own: it registers the current
 * workspace, loads the business timezone, loads the board label, and bounces a
 * user who may not see the invoice generator. Everything observable therefore
 * shows up as an HTTP request, a callback, or a router navigation.
 */

const BACKEND = 'https://api.isoplus.test';
const PROFILE_URL = `${BACKEND}/api/business/profile`;
const BOARDS_URL = `${BACKEND}/api/boards`;

// One router object for the whole file. A fresh object per useRouter() call
// would re-fire the redirect effect on every render and make call counts lie.
const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/workspace/1420/board/9911/invoice-generator',
  useParams: () => ({ id: '1420', boardId: '9911' }),
}));

let originalBackendUrl: string | undefined;
let profileRequests: string[] = [];
let boardRequests: string[] = [];

type SetupProps = Parameters<typeof useInvoiceGeneratorSetup>[0];

function makeProps(overrides: Partial<SetupProps> = {}): SetupProps {
  return {
    id: '1420',
    boardId: '9911',
    boardLabel: 'Care Management - SaH - Low Cat',
    user: { role: 'support_admin' },
    workspace: { user_role: 'admin' },
    setCurrentWorkspaceId: vi.fn(),
    onBusinessTimezoneLoaded: vi.fn(),
    setBoardLabel: vi.fn(),
    ...overrides,
  };
}

function queryOf(url: string) {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

beforeAll(() => {
  originalBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
  process.env.NEXT_PUBLIC_BACKEND_URL = BACKEND;
});

afterAll(() => {
  process.env.NEXT_PUBLIC_BACKEND_URL = originalBackendUrl;
});

beforeEach(() => {
  routerMock.replace.mockClear();
  routerMock.push.mockClear();
  profileRequests = [];
  boardRequests = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // Recording defaults. A test-specific server.use() is prepended and wins.
  server.use(
    http.get(PROFILE_URL, ({ request }) => {
      profileRequests.push(request.url);
      return HttpResponse.json({ headOfficeTimezone: 'Australia/Sydney' });
    }),
    http.get(BOARDS_URL, ({ request }) => {
      boardRequests.push(request.url);
      return HttpResponse.json({ board: { id: 9911, label: 'Care Management - SaH - Low Cat' } });
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInvoiceGeneratorSetup — current workspace registration', () => {
  it('registers the workspace id on mount and clears it on unmount', async () => {
    const props = makeProps();
    const { unmount } = renderHook(() => useInvoiceGeneratorSetup(props));

    expect((props.setCurrentWorkspaceId as any).mock.calls).toEqual([['1420']]);

    unmount();

    expect((props.setCurrentWorkspaceId as any).mock.calls).toEqual([['1420'], [null]]);
  });

  it('clears the registration but never registers an empty workspace id', async () => {
    const props = makeProps({ id: '' });
    const { unmount } = renderHook(() => useInvoiceGeneratorSetup(props));

    expect((props.setCurrentWorkspaceId as any).mock.calls).toEqual([]);

    unmount();

    expect((props.setCurrentWorkspaceId as any).mock.calls).toEqual([[null]]);
  });

  it('swaps the registration when the workspace id changes', async () => {
    const props = makeProps();
    const { rerender } = renderHook((current: SetupProps) => useInvoiceGeneratorSetup(current), {
      initialProps: props,
    });

    rerender({ ...props, id: '1421' });

    expect((props.setCurrentWorkspaceId as any).mock.calls).toEqual([['1420'], [null], ['1421']]);
  });
});

describe('useInvoiceGeneratorSetup — business timezone', () => {
  it('asks for that workspace profile and adopts its head office timezone', async () => {
    const props = makeProps();
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(props.onBusinessTimezoneLoaded).toHaveBeenCalled());

    expect(profileRequests).toHaveLength(1);
    expect(new URL(profileRequests[0]).pathname).toBe('/api/business/profile');
    expect(queryOf(profileRequests[0])).toEqual({ workspaceId: '1420' });
    expect((props.onBusinessTimezoneLoaded as any).mock.calls).toEqual([['Australia/Sydney']]);
  });

  it('leaves the timezone alone when the profile carries none', async () => {
    server.use(
      http.get(PROFILE_URL, ({ request }) => {
        profileRequests.push(request.url);
        return HttpResponse.json({ businessName: 'Hillsgrade Care', headOfficeAddress: '12 Grade St' });
      })
    );

    const props = makeProps();
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(profileRequests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(props.onBusinessTimezoneLoaded).not.toHaveBeenCalled();
  });

  it('treats an empty timezone string as no timezone at all', async () => {
    server.use(
      http.get(PROFILE_URL, ({ request }) => {
        profileRequests.push(request.url);
        return HttpResponse.json({ headOfficeTimezone: '' });
      })
    );

    const props = makeProps();
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(profileRequests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(props.onBusinessTimezoneLoaded).not.toHaveBeenCalled();
  });

  it('logs a failed profile request and keeps the timezone unset', async () => {
    server.use(http.get(PROFILE_URL, () => HttpResponse.json({ message: 'Business not found' }, { status: 404 })));

    const props = makeProps();
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(console.error).toHaveBeenCalled());

    expect(props.onBusinessTimezoneLoaded).not.toHaveBeenCalled();
    expect((console.error as any).mock.calls[0][0]).toBeInstanceOf(Error);
    expect((console.error as any).mock.calls[0][0].message).toBe('Request failed with status code 404');
  });

  it('aborts the in-flight profile request on unmount without logging the cancellation', async () => {
    // Gate the response on a promise this test resolves, rather than a timer.
    // With a delay the response can land before unmount under load, and the
    // setter fires — a race, not a regression.
    let releaseProfile = () => {};
    const inFlight = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });

    server.use(
      http.get(PROFILE_URL, async ({ request }) => {
        profileRequests.push(request.url);
        await inFlight;
        return HttpResponse.json({ headOfficeTimezone: 'Australia/Sydney' });
      })
    );

    const props = makeProps();
    const { unmount } = renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(profileRequests).toHaveLength(1));
    unmount();

    // Only now can the response resolve, so it is guaranteed to arrive after
    // the hook has torn down and aborted.
    releaseProfile();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(props.onBusinessTimezoneLoaded).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('refetches the profile for the new workspace when the id changes', async () => {
    const props = makeProps();
    const { rerender } = renderHook((current: SetupProps) => useInvoiceGeneratorSetup(current), {
      initialProps: props,
    });

    await waitFor(() => expect(profileRequests).toHaveLength(1));

    rerender({ ...props, id: '1421' });

    await waitFor(() => expect(profileRequests).toHaveLength(2));
    expect(profileRequests.map((url) => queryOf(url).workspaceId)).toEqual(['1420', '1421']);
  });

  it('issues no profile request while the workspace id is empty', async () => {
    const props = makeProps({ id: '' });
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(boardRequests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(profileRequests).toEqual([]);
    expect(props.onBusinessTimezoneLoaded).not.toHaveBeenCalled();
  });
});

describe('useInvoiceGeneratorSetup — board label', () => {
  it('fetches the board by id and adopts the label it returns', async () => {
    let acceptHeader: string | null = null;
    server.use(
      http.get(BOARDS_URL, ({ request }) => {
        boardRequests.push(request.url);
        acceptHeader = request.headers.get('Accept');
        return HttpResponse.json({ board: { id: 9911, label: 'Care Management - NDIS - Certification' } });
      })
    );

    const props = makeProps();
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(props.setBoardLabel).toHaveBeenCalled());

    expect(new URL(boardRequests[0]).pathname).toBe('/api/boards');
    expect(queryOf(boardRequests[0])).toEqual({ id: '9911' });
    expect(acceptHeader).toBe('application/json');
    expect((props.setBoardLabel as any).mock.calls).toEqual([['Care Management - NDIS - Certification']]);
  });

  it('leaves the label alone when the board payload has none', async () => {
    server.use(
      http.get(BOARDS_URL, ({ request }) => {
        boardRequests.push(request.url);
        return HttpResponse.json({ board: { id: 9911 } });
      })
    );

    const props = makeProps();
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(boardRequests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(props.setBoardLabel).not.toHaveBeenCalled();
  });

  it('logs a failed board request under its own message', async () => {
    server.use(http.get(BOARDS_URL, () => HttpResponse.json({ message: 'Board not found' }, { status: 404 })));

    const props = makeProps();
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() =>
      expect(console.error).toHaveBeenCalledWith('Error fetching board label:', expect.any(Error))
    );

    expect(props.setBoardLabel).not.toHaveBeenCalled();
  });

  it('issues no board request while the board id is empty', async () => {
    const props = makeProps({ boardId: '' });
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(profileRequests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(boardRequests).toEqual([]);
    expect(props.setBoardLabel).not.toHaveBeenCalled();
  });

  it('does not refetch the board when only the label changes', async () => {
    const props = makeProps();
    const { rerender } = renderHook((current: SetupProps) => useInvoiceGeneratorSetup(current), {
      initialProps: props,
    });

    await waitFor(() => expect(boardRequests).toHaveLength(1));

    rerender({ ...props, boardLabel: 'Care Management - NDIS - Verification' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(boardRequests).toHaveLength(1);
  });

  it('refetches the board when the board id changes', async () => {
    const props = makeProps();
    const { rerender } = renderHook((current: SetupProps) => useInvoiceGeneratorSetup(current), {
      initialProps: props,
    });

    await waitFor(() => expect(boardRequests).toHaveLength(1));

    rerender({ ...props, boardId: '9912' });

    await waitFor(() => expect(boardRequests).toHaveLength(2));
    expect(boardRequests.map((url) => queryOf(url).id)).toEqual(['9911', '9912']);
  });
});

describe('useInvoiceGeneratorSetup — access control', () => {
  it('keeps a support admin on a care management board', async () => {
    const props = makeProps();
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(profileRequests).toHaveLength(1));

    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('redirects a support admin away from a board that is not care management', async () => {
    const props = makeProps({ boardLabel: 'Rostering' });
    renderHook(() => useInvoiceGeneratorSetup(props));

    expect(routerMock.replace.mock.calls).toEqual([['/workspace/access-denied']]);
  });

  it('decides nothing until the board label has loaded', async () => {
    const props = makeProps({ boardLabel: '' });
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(boardRequests).toHaveLength(1));

    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('defers the decision for an ISO+ user whose workspace has not loaded yet', async () => {
    const props = makeProps({ boardLabel: 'Rostering', user: { role: 'isoplus_user' }, workspace: null });
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(boardRequests).toHaveLength(1));

    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('redirects an ISO+ user who is only a member of the workspace', async () => {
    const props = makeProps({ user: { role: 'isoplus_user' }, workspace: { user_role: 'member' } });
    renderHook(() => useInvoiceGeneratorSetup(props));

    expect(routerMock.replace.mock.calls).toEqual([['/workspace/access-denied']]);
  });

  it('keeps an ISO+ user who administers the workspace', async () => {
    const props = makeProps({ user: { role: 'isoplus_user' }, workspace: { user_role: 'admin' } });
    renderHook(() => useInvoiceGeneratorSetup(props));

    await waitFor(() => expect(profileRequests).toHaveLength(1));

    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('redirects an ISO+ workspace owner off a non care management board', async () => {
    const props = makeProps({
      boardLabel: 'Rostering',
      user: { role: 'isoplus_user' },
      workspace: { user_role: 'owner' },
    });
    renderHook(() => useInvoiceGeneratorSetup(props));

    expect(routerMock.replace.mock.calls).toEqual([['/workspace/access-denied']]);
  });

  it('redirects once, not once per render, while nothing relevant changes', async () => {
    const props = makeProps({ boardLabel: 'Rostering' });
    const { rerender } = renderHook((current: SetupProps) => useInvoiceGeneratorSetup(current), {
      initialProps: props,
    });

    rerender({ ...props });
    rerender({ ...props });

    expect(routerMock.replace.mock.calls).toEqual([['/workspace/access-denied']]);
  });
});
