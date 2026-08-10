/**
 * Shared setup for the App Router page tests under `test/unit/app/`.
 *
 * These are characterization tests: every page here is rendered for real,
 * including its `*-page-view` component, its shadcn/Radix primitives and the
 * `<Header />` most of them mount. Everything below exists to make jsdom + MSW
 * survive that, and nothing here doubles application code.
 *
 * NOT a test file — vitest's `include` is `**\/*.test.{ts,tsx}`, so this is
 * only ever imported.
 */
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';

/**
 * jsdom implements none of these, and Radix's Select / Popover / Command /
 * Dialog primitives call all of them while opening. This is environment
 * setup, not component mocking.
 */
export function installBrowserStubs(): void {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();

  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  }

  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as never;
  }

  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => 'blob:stub');
    URL.revokeObjectURL = vi.fn();
  }
}

/** A stable router object. Build ONE per test file at module scope. */
export function makeRouter() {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  };
}

/**
 * `NEXT_PUBLIC_BACKEND_URL` is unset under vitest, so the app requests
 * `undefined/api/...`. A leading `*` matches whatever origin it ends up with.
 *
 * `vitest.setup.ts` runs MSW with `onUnhandledRequest: 'error'`, so every
 * request a page makes has to be stubbed. `<Header />` verifies the session on
 * mount and `<SyncStatusIndicator />` (which Header renders) polls sync status
 * once a workspace id is in context.
 */
export function stubChromeRequests(
  user: Record<string, unknown> | null = null,
): void {
  server.use(
    http.get('*/api/auth/verify', () =>
      user
        ? HttpResponse.json({ user })
        : HttpResponse.json({ user: null }, { status: 401 }),
    ),
    http.get('*/api/sync/workspace/status/*', () =>
      HttpResponse.json({ boards: [] }),
    ),
    http.post('*/api/auth/logout', () => HttpResponse.json({ ok: true })),
  );
}

/** Realistic ISO+ users, matching the roles in `app/context/index.tsx`. */
export const SUPPORT_ADMIN = {
  id: 'u-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  avatar: '',
  role: 'support_admin',
};

export const ISOPLUS_USER = {
  id: 'u-2',
  name: 'Grace Hopper',
  email: 'grace@example.com',
  avatar: '',
  role: 'isoplus_user',
};

/**
 * Seeds `localStorage` the way a real signed-in session would, so the real
 * `ContextProvider` hydrates with them on mount.
 */
export function seedContextStorage(
  user: Record<string, unknown>,
  workspaces: Array<Record<string, unknown>> = [],
): void {
  localStorage.setItem('user', JSON.stringify(user));
  localStorage.setItem('workspace', JSON.stringify(workspaces));
}
