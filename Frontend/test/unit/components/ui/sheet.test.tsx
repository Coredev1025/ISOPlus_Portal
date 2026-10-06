import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from '@/components/ui/sheet';

type SheetSide = 'top' | 'bottom' | 'left' | 'right';

function renderSheet(
  props: Record<string, unknown> = {},
  contentProps: { side?: SheetSide; className?: string } = {},
) {
  return render(
    <Sheet {...props}>
      <SheetTrigger>Board filters</SheetTrigger>
      <SheetContent {...contentProps}>
        <SheetHeader>
          <SheetTitle>Filter items</SheetTitle>
          <SheetDescription>Narrow the board down before exporting.</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <SheetClose>Apply</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>,
  );
}

// The overlay has no role and is aria-hidden; Radix portals it onto body as the
// sibling immediately before the content, which is the only handle on it.
function overlayOf(content: HTMLElement) {
  return content.previousElementSibling as HTMLElement;
}

describe('Sheet', () => {
  it('renders only the trigger before it is opened', () => {
    renderSheet();

    expect(screen.getByRole('button', { name: 'Board filters' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on the trigger as a dialog named by its title', async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByRole('button', { name: 'Board filters' }));

    expect(screen.getByRole('dialog', { name: 'Filter items' })).toBeInTheDocument();
  });

  it('describes the sheet with the description', async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByRole('button', { name: 'Board filters' }));

    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Narrow the board down before exporting.',
    );
  });

  it('closes on the built-in close button', async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByRole('button', { name: 'Board filters' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on a SheetClose in the footer', async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByRole('button', { name: 'Board filters' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByRole('button', { name: 'Board filters' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when the overlay behind it is clicked', async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByRole('button', { name: 'Board filters' }));
    const overlay = overlayOf(screen.getByRole('dialog'));
    expect(overlay.className.split(/\s+/)).toContain('bg-black/80');

    await user.click(overlay);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports each open state change', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderSheet({ onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Board filters' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('lets a controlled open prop override the close button', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderSheet({ open: true, onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps a controlled sheet shut when the trigger is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderSheet({ open: false, onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Board filters' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the sheet on open and back to the trigger on close', async () => {
    const user = userEvent.setup();
    renderSheet();
    const trigger = screen.getByRole('button', { name: 'Board filters' });

    await user.click(trigger);
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it('anchors to the right edge by default', async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByRole('button', { name: 'Board filters' }));
    const tokens = screen.getByRole('dialog').className.split(/\s+/);

    expect(tokens).toContain('right-0');
    expect(tokens).toContain('inset-y-0');
  });

  it.each([
    ['left', 'left-0'],
    ['top', 'top-0'],
    ['bottom', 'bottom-0'],
  ] as const)('anchors to the %s edge when asked', async (side, token) => {
    const user = userEvent.setup();
    renderSheet({}, { side });

    await user.click(screen.getByRole('button', { name: 'Board filters' }));

    expect(screen.getByRole('dialog').className.split(/\s+/)).toContain(token);
  });

  it('merges a caller class into the content without dropping its own', async () => {
    const user = userEvent.setup();
    renderSheet({}, { className: 'w-1/2' });

    await user.click(screen.getByRole('button', { name: 'Board filters' }));
    const tokens = screen.getByRole('dialog').className.split(/\s+/);

    expect(tokens).toContain('w-1/2');
    expect(tokens).toContain('bg-background');
  });
});
