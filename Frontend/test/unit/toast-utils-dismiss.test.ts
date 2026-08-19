import { afterEach, describe, expect, it, vi } from 'vitest';
import Toastify from 'toastify-js';
import { dismissAllToasts, showSuccessToast } from '@/lib/toast-utils';

describe('dismissAllToasts', () => {
  afterEach(() => {
    vi.useRealTimers();
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.toastify').forEach((node) => node.remove());
    }
  });

  it('dismisses active toasts without throwing after jsdom teardown', async () => {
    vi.useFakeTimers();
    showSuccessToast('Saved', { duration: 4000 });

    dismissAllToasts();
    await vi.advanceTimersByTimeAsync(1000);

    expect(document.querySelectorAll('.toastify')).toHaveLength(0);
  });

  it('does not throw if Toastify.reposition runs after document is gone', () => {
    const originalDocument = globalThis.document;
    // @ts-expect-error simulating jsdom teardown
    delete globalThis.document;
    expect(() => Toastify.reposition()).not.toThrow();
    globalThis.document = originalDocument;
  });
});
