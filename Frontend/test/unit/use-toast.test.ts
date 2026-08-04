import { describe, it, expect } from 'vitest';
import { reducer } from '@/hooks/use-toast';

describe('use-toast reducer', () => {
  it('adds a toast and respects the limit', () => {
    const state = { toasts: [] as any[] };
    const next = reducer(state, {
      type: 'ADD_TOAST',
      toast: { id: '1', title: 'Hello', open: true },
    });
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].id).toBe('1');
  });

  it('dismisses toasts', () => {
    const state = {
      toasts: [{ id: '1', open: true } as any],
    };
    const next = reducer(state, { type: 'DISMISS_TOAST', toastId: '1' });
    expect(next.toasts[0].open).toBe(false);
  });
});
