import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu';

// jsdom implements none of the pointer-capture APIs Radix's menu reaches for.
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}

type MenuProps = {
  root?: Record<string, unknown>;
  onExport?: () => void;
  onArchive?: () => void;
  contentProps?: Record<string, unknown>;
};

function renderMenu({ root = {}, onExport, onArchive, contentProps = {} }: MenuProps = {}) {
  return render(
    <DropdownMenu {...root}>
      <DropdownMenuTrigger>Board actions</DropdownMenuTrigger>
      <DropdownMenuContent {...contentProps}>
        <DropdownMenuLabel>Board</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onExport}>
          Export CSV
          <DropdownMenuShortcut>⌘E</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onArchive} disabled>
          Archive board
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe('DropdownMenu', () => {
  it('renders only the trigger before it is opened', () => {
    renderMenu();

    expect(screen.getByRole('button', { name: /Board actions/ })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens a menu of items on the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /Board actions/ }));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Export CSV⌘E',
      'Archive board',
    ]);
  });

  it('wires the trigger to the menu it controls', async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByRole('button', { name: /Board actions/ });

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', screen.getByRole('menu').id);
  });

  it('runs an item and closes the menu when one is chosen', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    renderMenu({ onExport });

    await user.click(screen.getByRole('button', { name: /Board actions/ }));
    await user.click(screen.getByRole('menuitem', { name: /Export CSV/ }));

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('will not run a disabled item', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    renderMenu({ onArchive });

    await user.click(screen.getByRole('button', { name: /Board actions/ }));
    const archive = screen.getByRole('menuitem', { name: 'Archive board' });
    expect(archive).toHaveAttribute('aria-disabled', 'true');

    await user.click(archive);

    expect(onArchive).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByRole('button', { name: /Board actions/ });

    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('moves focus into the menu on open', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /Board actions/ }));

    expect(screen.getByRole('menu')).toContainElement(document.activeElement as HTMLElement);
  });

  it('highlights the first enabled item with the arrow keys', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /Board actions/ }));
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('menuitem', { name: /Export CSV/ })).toHaveFocus();
  });

  it('reports each open state change', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderMenu({ root: { onOpenChange } });

    await user.click(screen.getByRole('button', { name: /Board actions/ }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('lets a controlled open prop override Escape', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderMenu({ root: { open: true, onOpenChange } });

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('keeps a controlled menu shut when the trigger is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderMenu({ root: { open: false, onOpenChange } });

    await user.click(screen.getByRole('button', { name: /Board actions/ }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('separates groups with a separator', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /Board actions/ }));

    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('merges a caller class into the content without dropping its own', async () => {
    const user = userEvent.setup();
    renderMenu({ contentProps: { className: 'w-64' } });

    await user.click(screen.getByRole('button', { name: /Board actions/ }));
    const tokens = screen.getByRole('menu').className.split(/\s+/);

    expect(tokens).toContain('w-64');
    expect(tokens).toContain('bg-popover');
  });

  it('toggles a checkbox item and reports the new state', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Columns</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked onCheckedChange={onCheckedChange}>
            Show totals
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const item = screen.getByRole('menuitemcheckbox', { name: 'Show totals' });
    expect(item).toHaveAttribute('aria-checked', 'true');

    await user.click(item);

    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('selects a radio item and reports its value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Sort</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="name" onValueChange={onValueChange}>
            <DropdownMenuRadioItem value="name">By name</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="date">By date</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole('button', { name: 'Sort' }));
    expect(screen.getByRole('menuitemradio', { name: 'By name' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(screen.getByRole('menuitemradio', { name: 'By date' }));

    expect(onValueChange).toHaveBeenCalledWith('date');
  });
});
