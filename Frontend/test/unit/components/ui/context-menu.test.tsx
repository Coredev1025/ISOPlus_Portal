import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

function renderMenu(onSelect = vi.fn()) {
  render(
    <ContextMenu>
      <ContextMenuTrigger>Board row</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>Board actions</ContextMenuLabel>
        <ContextMenuItem onSelect={onSelect}>
          Resync
          <ContextMenuShortcut>⌘R</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled onSelect={onSelect}>
          Archive
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked>Show archived</ContextMenuCheckboxItem>
        <ContextMenuRadioGroup value="ndis">
          <ContextMenuRadioItem value="ndis">NDIS</ContextMenuRadioItem>
          <ContextMenuRadioItem value="agecare">Aged Care</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuContent>
    </ContextMenu>,
  );
  return onSelect;
}

/** Right-click is the only way to open a context menu. */
function openMenu() {
  fireEvent.contextMenu(screen.getByText('Board row'));
}

describe('ContextMenu', () => {
  it('renders the trigger but no menu until right-clicked', () => {
    renderMenu();

    expect(screen.getByText('Board row')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Resync/ })).not.toBeInTheDocument();
  });

  it('opens on right-click', async () => {
    renderMenu();

    openMenu();

    expect(await screen.findByRole('menuitem', { name: /Resync/ })).toBeInTheDocument();
  });

  it('does not open on a normal left click', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByText('Board row'));

    expect(screen.queryByRole('menuitem', { name: /Resync/ })).not.toBeInTheDocument();
  });

  it('renders its label and shortcut', async () => {
    renderMenu();

    openMenu();

    expect(await screen.findByText('Board actions')).toBeInTheDocument();
    expect(screen.getByText('⌘R')).toBeInTheDocument();
  });

  it('fires the item handler when an item is chosen', async () => {
    const user = userEvent.setup();
    const onSelect = renderMenu();

    openMenu();
    await user.click(await screen.findByRole('menuitem', { name: /Resync/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('does not fire a disabled item', async () => {
    const user = userEvent.setup();
    const onSelect = renderMenu();

    openMenu();
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks the disabled item for assistive technology', async () => {
    renderMenu();

    openMenu();

    expect(await screen.findByRole('menuitem', { name: 'Archive' }))
      .toHaveAttribute('data-disabled');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderMenu();

    openMenu();
    await screen.findByRole('menuitem', { name: /Resync/ });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: /Resync/ })).not.toBeInTheDocument();
    });
  });

  it('closes after an item is chosen', async () => {
    const user = userEvent.setup();
    renderMenu();

    openMenu();
    await user.click(await screen.findByRole('menuitem', { name: /Resync/ }));

    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: /Resync/ })).not.toBeInTheDocument();
    });
  });

  it('renders a checked checkbox item', async () => {
    renderMenu();

    openMenu();

    expect(await screen.findByRole('menuitemcheckbox', { name: 'Show archived' }))
      .toHaveAttribute('aria-checked', 'true');
  });

  it('marks the selected radio item and only that one', async () => {
    renderMenu();

    openMenu();

    expect(await screen.findByRole('menuitemradio', { name: 'NDIS' }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Aged Care' }))
      .toHaveAttribute('aria-checked', 'false');
  });

  it('separates the groups with a separator', async () => {
    renderMenu();

    openMenu();
    await screen.findByRole('menuitem', { name: /Resync/ });

    expect(screen.getByRole('separator')).toBeInTheDocument();
  });
});
