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

  it('does not leave a Toastify.reposition timer that needs document after teardown', async () => {
    vi.useFakeTimers();
    showSuccessToast('Saved', { duration: 4000 });
    const reposition = vi.spyOn(Toastify, 'reposition');

    dismissAllToasts();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reposition).not.toHaveBeenCalled();
  });

  it('does not throw if Toastify.reposition runs after document is gone', () => {
    const originalDocument = globalThis.document;
    // @ts-expect-error simulating jsdom teardown
    delete globalThis.document;
    expect(() => Toastify.reposition()).not.toThrow();
    globalThis.document = originalDocument;
  });
});
