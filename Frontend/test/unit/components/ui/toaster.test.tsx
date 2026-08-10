import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@/components/ui/toaster';
import { toast, reducer } from '@/hooks/use-toast';

/**
 * Toaster is the bridge between the module-global toast store and the Radix
 * primitives: it subscribes, maps each queued entry onto a <Toast>, and renders
 * the viewport. The store is global, so each test drains it first through the
 * store's own public API rather than reaching into internals.
 */

beforeEach(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(() => {
  act(() => {
    // Dismiss everything so one test's toasts cannot leak into the next.
    toast({ title: '__drain__' }).dismiss();
  });
});

describe('Toaster', () => {
  it('renders no toast when the queue is empty', () => {
    render(<Toaster />);

    expect(screen.queryAllByRole('status').filter((el) => el.tagName === 'LI')).toHaveLength(0);
  });

  it('renders a queued toast title', async () => {
    render(<Toaster />);

    act(() => {
      toast({ title: 'Sync finished' });
    });

    expect(await screen.findByText('Sync finished')).toBeInTheDocument();
  });

  it('renders the description alongside the title', async () => {
    render(<Toaster />);

    act(() => {
      toast({ title: 'Sync failed', description: 'ISO+ returned 502' });
    });

    expect(await screen.findByText('Sync failed')).toBeInTheDocument();
    expect(screen.getByText('ISO+ returned 502')).toBeInTheDocument();
  });

  it('renders a toast that has only a description', async () => {
    render(<Toaster />);

    act(() => {
      toast({ description: 'Saved' });
    });

    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('gives every toast a close control, but with no accessible name', async () => {
    // components/ui/toast.tsx renders ToastClose as a bare lucide <X> with no
    // aria-label, sr-only text or title, so the button has no accessible name
    // and cannot be found or announced by name. Documents current behaviour;
    // this is a real accessibility gap.
    const { container } = render(<Toaster />);

    act(() => {
      toast({ title: 'Sync finished' });
    });
    await screen.findByText('Sync finished');

    const close = container.querySelector('[toast-close]');
    expect(close).not.toBeNull();
    expect(close).toHaveAccessibleName('');
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('removes the toast from view when its close control is pressed', async () => {
    const user = userEvent.setup();
    const { container } = render(<Toaster />);

    act(() => {
      toast({ title: 'Sync finished' });
    });
    await screen.findByText('Sync finished');

    await user.click(container.querySelector('[toast-close]') as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByText('Sync finished')).not.toBeInTheDocument();
    });
  });

  it('renders the action element it is handed', async () => {
    render(<Toaster />);

    act(() => {
      toast({
        title: 'Sync failed',
        action: <button type="button">Retry</button> as never,
      });
    });

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders the destructive variant distinctly from the default', async () => {
    render(<Toaster />);

    act(() => {
      toast({ title: 'Sync failed', variant: 'destructive' });
    });
    await screen.findByText('Sync failed');

    const item = screen.getAllByRole('status').find((el) => el.tagName === 'LI');
    expect(item?.className).toContain('destructive');
  });

  it('mounts the viewport that positions the stack', () => {
    render(<Toaster />);

    const list = screen.getByRole('region').querySelector('ol');
    expect(list).not.toBeNull();
    expect(list!.className.split(/\s+/)).toContain('fixed');
  });
});

describe('use-toast reducer, as Toaster consumes it', () => {
  it('adds a toast to the front of the queue', () => {
    const state = reducer(
      { toasts: [{ id: '1', title: 'old', open: true }] },
      { type: 'ADD_TOAST', toast: { id: '2', title: 'new', open: true } },
    );

    expect(state.toasts[0].title).toBe('new');
  });

  it('marks a dismissed toast closed rather than dropping it immediately', () => {
    const state = reducer(
      { toasts: [{ id: '1', title: 'a', open: true }] },
      { type: 'DISMISS_TOAST', toastId: '1' },
    );

    expect(state.toasts[0].open).toBe(false);
  });

  it('removes a toast outright', () => {
    const state = reducer(
      { toasts: [{ id: '1', title: 'a', open: true }] },
      { type: 'REMOVE_TOAST', toastId: '1' },
    );

    expect(state.toasts).toHaveLength(0);
  });
});
