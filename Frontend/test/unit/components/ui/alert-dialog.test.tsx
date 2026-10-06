import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

type Handlers = {
  onAction?: () => void;
  onCancel?: () => void;
  root?: Record<string, unknown>;
};

function renderAlertDialog({ onAction, onCancel, root = {} }: Handlers = {}) {
  return render(
    <AlertDialog {...root}>
      <AlertDialogTrigger>Push to Xero</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Push 14 invoices to Xero?</AlertDialogTitle>
          <AlertDialogDescription>
            They cannot be recalled once Xero has accepted them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Not yet</AlertDialogCancel>
          <AlertDialogAction onClick={onAction}>Push them</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  );
}

// The overlay carries no role and is aria-hidden, so it can only be reached
// structurally: Radix portals it onto body immediately before the content.
function overlayOf(content: HTMLElement) {
  return content.previousElementSibling as HTMLElement;
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Push to Xero' }));
  return screen.getByRole('alertdialog');
}

describe('AlertDialog', () => {
  it('renders only the trigger before it is opened', () => {
    renderAlertDialog();

    expect(screen.getByRole('button', { name: 'Push to Xero' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('opens with the alertdialog role named by its title', async () => {
    const user = userEvent.setup();
    renderAlertDialog();

    await user.click(screen.getByRole('button', { name: 'Push to Xero' }));

    expect(
      screen.getByRole('alertdialog', { name: 'Push 14 invoices to Xero?' }),
    ).toBeInTheDocument();
    // It must not be announced as an ordinary dialog.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('describes the alert with the description', async () => {
    const user = userEvent.setup();
    renderAlertDialog();

    const dialog = await open(user);

    expect(dialog).toHaveAccessibleDescription(
      'They cannot be recalled once Xero has accepted them.',
    );
  });

  it('offers the action and the cancel as two distinct buttons', async () => {
    const user = userEvent.setup();
    renderAlertDialog();

    await open(user);

    const action = screen.getByRole('button', { name: 'Push them' });
    const cancel = screen.getByRole('button', { name: 'Not yet' });
    expect(action).not.toBe(cancel);
    // There is no built-in X close button on an alert dialog.
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('closes on cancel without running the action', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onCancel = vi.fn();
    renderAlertDialog({ onAction, onCancel });

    await open(user);
    await user.click(screen.getByRole('button', { name: 'Not yet' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('runs the action and closes when the action is confirmed', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderAlertDialog({ onAction });

    await open(user);
    await user.click(screen.getByRole('button', { name: 'Push them' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('closes on Escape without running the action', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderAlertDialog({ onAction });

    await open(user);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('stays open when the overlay is clicked, unlike a plain dialog', async () => {
    const user = userEvent.setup();
    renderAlertDialog();

    const dialog = await open(user);
    const overlay = overlayOf(dialog);
    expect(overlay.className.split(/\s+/)).toContain('bg-black/80');

    await user.click(overlay);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('reports each open state change', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderAlertDialog({ root: { onOpenChange } });

    await open(user);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('lets a controlled open prop override cancel', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderAlertDialog({ root: { open: true, onOpenChange } });

    await user.click(screen.getByRole('button', { name: 'Not yet' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('keeps a controlled alert shut when the trigger is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderAlertDialog({ root: { open: false, onOpenChange } });

    await user.click(screen.getByRole('button', { name: 'Push to Xero' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('focuses the cancel button on open and restores the trigger on close', async () => {
    const user = userEvent.setup();
    renderAlertDialog();
    const trigger = screen.getByRole('button', { name: 'Push to Xero' });

    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Not yet' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it('styles the action as a solid button and the cancel as an outline one', async () => {
    const user = userEvent.setup();
    renderAlertDialog();

    await open(user);

    expect(
      screen.getByRole('button', { name: 'Push them' }).className.split(/\s+/),
    ).toContain('bg-primary');
    expect(
      screen.getByRole('button', { name: 'Not yet' }).className.split(/\s+/),
    ).toContain('border-input');
  });

  it('merges a caller class into the content without dropping its own', async () => {
    const user = userEvent.setup();
    render(
      <AlertDialog>
        <AlertDialogTrigger>Open</AlertDialogTrigger>
        <AlertDialogContent className="max-w-3xl">
          <AlertDialogTitle>Discard draft?</AlertDialogTitle>
          <AlertDialogDescription>Nothing is saved.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );

    await user.click(screen.getByRole('button', { name: 'Open' }));
    const tokens = screen.getByRole('alertdialog').className.split(/\s+/);

    expect(tokens).toContain('max-w-3xl');
    expect(tokens).toContain('bg-background');
  });
});
