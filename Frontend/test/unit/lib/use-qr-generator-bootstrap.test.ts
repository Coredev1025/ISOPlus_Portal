import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../../msw/server';
import { useQrGeneratorBootstrap } from '@/lib/use-qr-generator-bootstrap';

process.env.NEXT_PUBLIC_BACKEND_URL = 'https://api.isoplus.test';

const { showFetchErrorToast } = vi.hoisted(() => ({ showFetchErrorToast: vi.fn() }));
vi.mock('@/lib/toast-utils', () => ({ showFetchErrorToast, showSuccessToast: vi.fn() }));

const BOARDS_PAYLOAD = {
  board: [
    { id: 204, name: 'Participants', label: 'NDIS', workspaceId: '5512' },
    { id: 998, name: 'Incidents', label: null, workspaceId: '5512' },
  ],
  nextAfter: null,
  hasMore: false,
};

const BUSINESS_PAYLOAD = {
  _id: '66f0c9e1b8a1d2f3a4b5c6d7',
  workspaceId: '5512',
  name: 'Hillsgrade Care',
  abn: '12345678901',
  defaultLogo: 'business/5512/default.png',
  squareLogo: null,
  wideLogo: null,
  logoUrls: {
    defaultLogo: {
      url: 'https://s3.example/business/5512/default.png?sig=abc',
      expiresAt: '2026-08-10T11:00:00.000Z',
    },
  },
};

const VIEWS_PAYLOAD = {
  views: [
    {
      id: '9241',
      name: 'Alpha intake form',
      url: 'https://app.isoplus.online/form/9241',
      type: 'form',
    },
    {
      id: '77821',
      name: 'Zebra checklist',
      url: 'https://app.isoplus.online/p/i5512-31007/zebra-checklist-77821',
      type: 'document',
    },
  ],
};

let boardsHits = 0;

function stubSuccess(delayMs = 0) {
  server.use(
    http.get('https://api.isoplus.test/api/workspaces/boards', async () => {
      boardsHits += 1;
      if (delayMs) await delay(delayMs);
      return HttpResponse.json(BOARDS_PAYLOAD);
    }),
    http.get('https://api.isoplus.test/api/business/profile', async () => {
      if (delayMs) await delay(delayMs);
      return HttpResponse.json(BUSINESS_PAYLOAD);
    }),
    http.get('https://api.isoplus.test/api/boards/views-for-qr', async () => {
      if (delayMs) await delay(delayMs);
      return HttpResponse.json(VIEWS_PAYLOAD);
    }),
  );
}

function makeSetters() {
  return {
    setBoard: vi.fn(),
    setBusiness: vi.fn(),
    setItems: vi.fn(),
    setLoading: vi.fn(),
  };
}

/** Each test uses its own workspace id so the module-level fetch cache cannot leak between them. */
let workspaceSeq = 0;
function nextWorkspaceId() {
  workspaceSeq += 1;
  return `5512${workspaceSeq}`;
}

beforeEach(() => {
  boardsHits = 0;
  showFetchErrorToast.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useQrGeneratorBootstrap', () => {
  it('does nothing when the workspace id is missing', async () => {
    stubSuccess();
    const s = makeSetters();

    renderHook(() => useQrGeneratorBootstrap(undefined, '204', s.setBoard, s.setBusiness, s.setItems, s.setLoading));

    await Promise.resolve();
    expect(boardsHits).toBe(0);
    expect(s.setLoading).not.toHaveBeenCalled();
    expect(s.setBoard).not.toHaveBeenCalled();
  });

  it('does nothing when the board id is missing', async () => {
    stubSuccess();
    const s = makeSetters();

    renderHook(() => useQrGeneratorBootstrap('5512', undefined, s.setBoard, s.setBusiness, s.setItems, s.setLoading));

    await Promise.resolve();
    expect(boardsHits).toBe(0);
    expect(s.setLoading).not.toHaveBeenCalled();
  });

  it('loads the board, business and sorted items, toggling loading around the fetch', async () => {
    stubSuccess();
    const s = makeSetters();
    const workspaceId = nextWorkspaceId();

    renderHook(() => useQrGeneratorBootstrap(workspaceId, '204', s.setBoard, s.setBusiness, s.setItems, s.setLoading));

    expect(s.setLoading).toHaveBeenCalledWith(true);
    await waitFor(() => expect(s.setLoading).toHaveBeenCalledTimes(2));

    expect(s.setLoading.mock.calls).toEqual([[true], [false]]);
    expect(s.setBoard).toHaveBeenCalledWith({
      id: 204,
      name: 'Participants',
      label: 'NDIS',
      workspaceId: '5512',
    });
    expect(s.setBusiness).toHaveBeenCalledWith(BUSINESS_PAYLOAD);
    expect(s.setItems).toHaveBeenCalledWith([
      {
        id: '9241',
        name: 'Alpha intake form',
        url: 'https://app.isoplus.online/form/9241',
        type: 'form',
      },
      {
        id: '77821',
        name: 'Zebra checklist',
        url: 'https://app.isoplus.online/p/i5512-31007/zebra-checklist-77821',
        type: 'document',
      },
    ]);
    expect(showFetchErrorToast).not.toHaveBeenCalled();
  });

  it('shares one in-flight request between two hooks on the same workspace and board', async () => {
    stubSuccess(20);
    const a = makeSetters();
    const b = makeSetters();
    const workspaceId = nextWorkspaceId();

    renderHook(() => useQrGeneratorBootstrap(workspaceId, '204', a.setBoard, a.setBusiness, a.setItems, a.setLoading));
    renderHook(() => useQrGeneratorBootstrap(workspaceId, '204', b.setBoard, b.setBusiness, b.setItems, b.setLoading));

    await waitFor(() => expect(b.setBoard).toHaveBeenCalled());
    expect(boardsHits).toBe(1);
    expect(a.setBoard).toHaveBeenCalledWith(BOARDS_PAYLOAD.board[0]);
    expect(b.setBoard).toHaveBeenCalledWith(BOARDS_PAYLOAD.board[0]);
  });

  it('does not share between different boards', async () => {
    stubSuccess(20);
    const a = makeSetters();
    const b = makeSetters();
    const workspaceId = nextWorkspaceId();

    renderHook(() => useQrGeneratorBootstrap(workspaceId, '204', a.setBoard, a.setBusiness, a.setItems, a.setLoading));
    renderHook(() => useQrGeneratorBootstrap(workspaceId, '998', b.setBoard, b.setBusiness, b.setItems, b.setLoading));

    await waitFor(() => expect(b.setBoard).toHaveBeenCalled());
    expect(boardsHits).toBe(2);
    expect(b.setBoard).toHaveBeenCalledWith(BOARDS_PAYLOAD.board[1]);
  });

  it('drops the cache entry once settled, so a later mount refetches', async () => {
    stubSuccess();
    const a = makeSetters();
    const workspaceId = nextWorkspaceId();

    const first = renderHook(() =>
      useQrGeneratorBootstrap(workspaceId, '204', a.setBoard, a.setBusiness, a.setItems, a.setLoading),
    );
    await waitFor(() => expect(a.setLoading).toHaveBeenCalledTimes(2));
    first.unmount();

    const b = makeSetters();
    renderHook(() => useQrGeneratorBootstrap(workspaceId, '204', b.setBoard, b.setBusiness, b.setItems, b.setLoading));
    await waitFor(() => expect(b.setBoard).toHaveBeenCalled());

    expect(boardsHits).toBe(2);
  });

  it('ignores a response that arrives after unmount', async () => {
    stubSuccess(30);
    const s = makeSetters();
    const workspaceId = nextWorkspaceId();

    const { unmount } = renderHook(() =>
      useQrGeneratorBootstrap(workspaceId, '204', s.setBoard, s.setBusiness, s.setItems, s.setLoading),
    );
    unmount();

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(boardsHits).toBe(1);
    expect(s.setLoading.mock.calls).toEqual([[true]]);
    expect(s.setBoard).not.toHaveBeenCalled();
    expect(s.setBusiness).not.toHaveBeenCalled();
    expect(s.setItems).not.toHaveBeenCalled();
    expect(showFetchErrorToast).not.toHaveBeenCalled();
  });

  it('surfaces the backend error message and clears loading', async () => {
    server.use(
      http.get('https://api.isoplus.test/api/workspaces/boards', () => {
        boardsHits += 1;
        return HttpResponse.json(BOARDS_PAYLOAD);
      }),
      http.get('https://api.isoplus.test/api/business/profile', () =>
        HttpResponse.json({ message: 'Business profile not found' }, { status: 404 }),
      ),
      http.get('https://api.isoplus.test/api/boards/views-for-qr', () =>
        HttpResponse.json(VIEWS_PAYLOAD),
      ),
    );
    const s = makeSetters();
    const workspaceId = nextWorkspaceId();

    renderHook(() => useQrGeneratorBootstrap(workspaceId, '204', s.setBoard, s.setBusiness, s.setItems, s.setLoading));

    await waitFor(() => expect(showFetchErrorToast).toHaveBeenCalled());
    expect(showFetchErrorToast).toHaveBeenCalledWith('data', 'Business profile not found');
    expect(s.setLoading.mock.calls).toEqual([[true], [false]]);
    expect(s.setBoard).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the failure carries no response body', async () => {
    server.use(
      http.get('https://api.isoplus.test/api/workspaces/boards', () => {
        boardsHits += 1;
        return HttpResponse.error();
      }),
      http.get('https://api.isoplus.test/api/business/profile', () =>
        HttpResponse.json(BUSINESS_PAYLOAD),
      ),
      http.get('https://api.isoplus.test/api/boards/views-for-qr', () =>
        HttpResponse.json(VIEWS_PAYLOAD),
      ),
    );
    const s = makeSetters();
    const workspaceId = nextWorkspaceId();

    renderHook(() => useQrGeneratorBootstrap(workspaceId, '204', s.setBoard, s.setBusiness, s.setItems, s.setLoading));

    await waitFor(() => expect(showFetchErrorToast).toHaveBeenCalled());
    expect(showFetchErrorToast).toHaveBeenCalledWith('data', 'Failed to load data');
    expect(s.setLoading.mock.calls).toEqual([[true], [false]]);
  });

  it('stays silent after unmount when the request fails', async () => {
    server.use(
      http.get('https://api.isoplus.test/api/workspaces/boards', async () => {
        boardsHits += 1;
        await delay(30);
        return HttpResponse.json({ message: 'Server error' }, { status: 500 });
      }),
      http.get('https://api.isoplus.test/api/business/profile', async () => {
        await delay(30);
        return HttpResponse.json(BUSINESS_PAYLOAD);
      }),
      http.get('https://api.isoplus.test/api/boards/views-for-qr', async () => {
        await delay(30);
        return HttpResponse.json(VIEWS_PAYLOAD);
      }),
    );
    const s = makeSetters();
    const workspaceId = nextWorkspaceId();

    const { unmount } = renderHook(() =>
      useQrGeneratorBootstrap(workspaceId, '204', s.setBoard, s.setBusiness, s.setItems, s.setLoading),
    );
    unmount();

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(showFetchErrorToast).not.toHaveBeenCalled();
    expect(s.setLoading.mock.calls).toEqual([[true]]);
  });
});
