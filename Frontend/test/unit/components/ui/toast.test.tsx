import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';

// jsdom implements no Pointer Capture API; Radix's swipe-to-dismiss handler
// calls it on every pointerdown. Environment setup, not a stub of the component.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

function renderToast(ui: React.ReactNode) {
  return render(
    <ToastProvider>
      {ui}
      <ToastViewport />
    </ToastProvider>,
  );
}

// Radix renders the toast itself as an <li role="status"> in the viewport, plus a
// visually-hidden <span role="status"> announcement carrying the same text.
function getToastRoot() {
  const root = screen.getAllByRole('status').find((el) => el.tagName === 'LI');
  if (!root) throw new Error('no toast <li> in the document');
  return root;
}

// Radix wraps the viewport in an unstyled [role=region]; the ToastViewport
// className lands on the <ol> inside it, so class assertions must target that.
function getViewportList() {
  const list = screen.getByRole('region').querySelector('ol');
  if (!list) throw new Error('no viewport <ol> in the document');
  return list;
}

function tokens(el: Element) {
  return el.className.split(/\s+/).filter(Boolean);
}

describe('Toast', () => {
  it('renders the title and description inside the toast', () => {
    renderToast(
      <Toast>
        <ToastTitle>Sync finished</ToastTitle>
        <ToastDescription>412 items updated</ToastDescription>
      </Toast>,
    );

    const toast = within(getToastRoot());
    expect(toast.getByText('Sync finished')).toBeInTheDocument();
    expect(toast.getByText('412 items updated')).toBeInTheDocument();
  });

  it('uses the background/foreground tokens for the default variant', () => {
    renderToast(
      <Toast>
        <ToastTitle>Sync finished</ToastTitle>
      </Toast>,
    );

    const applied = tokens(getToastRoot());
    expect(applied).toContain('bg-background');
    expect(applied).toContain('text-foreground');
    expect(applied).not.toContain('bg-destructive');
  });

  it('uses the destructive tokens for the destructive variant', () => {
    renderToast(
      <Toast variant="destructive">
        <ToastTitle>Sync failed</ToastTitle>
      </Toast>,
    );

    const applied = tokens(getToastRoot());
    expect(applied).toContain('bg-destructive');
    expect(applied).toContain('border-destructive');
    expect(applied).toContain('text-destructive-foreground');
    // the bare `destructive` token is what the `group-[.destructive]:` rules on
    // the action and close buttons key off
    expect(applied).toContain('destructive');
    expect(applied).not.toContain('bg-background');
  });

  it('keeps a caller className alongside the variant classes', () => {
    renderToast(
      <Toast className="w-64">
        <ToastTitle>Sync finished</ToastTitle>
      </Toast>,
    );

    const applied = tokens(getToastRoot());
    expect(applied).toContain('w-64');
    expect(applied).toContain('bg-background');
  });

  it('renders the action as a button and calls its handler when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderToast(
      <Toast>
        <ToastTitle>Sync failed</ToastTitle>
        <ToastAction altText="Retry the sync" onClick={onClick}>
          Retry
        </ToastAction>
      </Toast>,
    );

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('dismisses the toast when the close button is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderToast(
      <Toast onOpenChange={onOpenChange}>
        <ToastTitle>Sync finished</ToastTitle>
        <ToastClose />
      </Toast>,
    );

    const close = within(getToastRoot()).getByRole('button');
    await user.click(close);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText('Sync finished')).not.toBeInTheDocument();
  });

  it('gives the close button no accessible name, only the toast-close marker', () => {
    renderToast(
      <Toast>
        <ToastTitle>Sync finished</ToastTitle>
        <ToastClose />
      </Toast>,
    );

    // characterizing an a11y gap: the X icon carries no label, so the button is
    // only addressable through the `toast-close` attribute the styles use.
    const close = within(getToastRoot()).getByRole('button');
    expect(close).toHaveAttribute('toast-close', '');
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('keeps a controlled toast out of the document while it is closed', () => {
    renderToast(
      <Toast open={false} onOpenChange={() => {}}>
        <ToastTitle>Sync finished</ToastTitle>
      </Toast>,
    );

    expect(screen.queryByText('Sync finished')).not.toBeInTheDocument();
  });

  it('places every toast inside the viewport list', () => {
    renderToast(
      <>
        <Toast>
          <ToastTitle>First</ToastTitle>
        </Toast>
        <Toast>
          <ToastTitle>Second</ToastTitle>
        </Toast>
      </>,
    );

    const viewport = screen.getByRole('region');
    expect(within(viewport).getByText('First')).toBeInTheDocument();
    expect(within(viewport).getByText('Second')).toBeInTheDocument();
    expect(tokens(getViewportList())).toContain('fixed');
  });

  it('merges a caller className into the viewport classes', () => {
    render(
      <ToastProvider>
        <ToastViewport className="gap-2" />
      </ToastProvider>,
    );

    const applied = tokens(getViewportList());
    expect(applied).toContain('gap-2');
    expect(applied).toContain('z-[100]');
  });
});
