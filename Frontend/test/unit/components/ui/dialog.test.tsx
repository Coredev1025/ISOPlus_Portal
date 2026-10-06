import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';

function renderDialog(props: Record<string, unknown> = {}) {
  return render(
    <Dialog {...props}>
      <DialogTrigger>Delete board</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this board?</DialogTitle>
          <DialogDescription>
            Every invoice generated from it stays, but the board is gone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose>Keep board</DialogClose>
          <button type="button">Delete</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );
}

// The overlay is deliberately non-semantic — aria-hidden, no role — so there is
// nothing to query it by. Radix portals it directly onto body as the sibling
// immediately before the content, which is what this walks to.
function overlayOf(content: HTMLElement) {
  return content.previousElementSibling as HTMLElement;
}

describe('Dialog', () => {
  it('renders only the trigger before it is opened', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Delete board' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on the trigger and names the dialog from its title', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Delete board' }));

    expect(screen.getByRole('dialog', { name: 'Delete this board?' })).toBeInTheDocument();
  });

  it('describes the dialog with the description', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Delete board' }));

    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Every invoice generated from it stays, but the board is gone.',
    );
  });

  it('marks the trigger as expanded while open', async () => {
    const user = userEvent.setup();
    renderDialog();
    const trigger = screen.getByRole('button', { name: 'Delete board' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes on the built-in close button', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Delete board' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on a DialogClose in the footer', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Delete board' }));
    await user.click(screen.getByRole('button', { name: 'Keep board' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Delete board' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when the overlay behind it is clicked', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Delete board' }));
    const overlay = overlayOf(screen.getByRole('dialog'));
    expect(overlay.className.split(/\s+/)).toContain('bg-black/80');

    await user.click(overlay);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports each open state change', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Delete board' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('lets a controlled open prop override the close button', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ open: true, onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps a controlled dialog shut when the trigger is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ open: false, onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Delete board' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus inside the dialog on open and back to the trigger on close', async () => {
    const user = userEvent.setup();
    renderDialog();
    const trigger = screen.getByRole('button', { name: 'Delete board' });

    await user.click(trigger);
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it('hides the rest of the page from assistive technology while open', async () => {
    const user = userEvent.setup();
    renderDialog();
    const trigger = screen.getByRole('button', { name: 'Delete board' });

    await user.click(trigger);

    expect(trigger.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('merges a caller class into the content without dropping its own', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent className="max-w-3xl">
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>Choose a format.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    await user.click(screen.getByRole('button', { name: 'Open' }));
    const tokens = screen.getByRole('dialog').className.split(/\s+/);

    expect(tokens).toContain('max-w-3xl');
    expect(tokens).toContain('bg-background');
  });
});
