import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSeparator,
  MenubarLabel,
  MenubarCheckboxItem,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarShortcut,
} from '@/components/ui/menubar';

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

function renderMenubar(onSelect = vi.fn()) {
  render(
    <Menubar>
      <MenubarMenu>
        <MenubarTrigger>Board</MenubarTrigger>
        <MenubarContent>
          <MenubarLabel>Board actions</MenubarLabel>
          <MenubarItem onSelect={onSelect}>
            Resync
            <MenubarShortcut>⌘R</MenubarShortcut>
          </MenubarItem>
          <MenubarItem disabled onSelect={onSelect}>
            Archive
          </MenubarItem>
          <MenubarSeparator />
          <MenubarCheckboxItem checked>Show archived</MenubarCheckboxItem>
          <MenubarRadioGroup value="ndis">
            <MenubarRadioItem value="ndis">NDIS</MenubarRadioItem>
            <MenubarRadioItem value="agecare">Aged Care</MenubarRadioItem>
          </MenubarRadioGroup>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu>
        <MenubarTrigger>Export</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={onSelect}>Download CSV</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>,
  );
  return onSelect;
}

describe('Menubar', () => {
  it('renders each top-level trigger', () => {
    renderMenubar();

    expect(screen.getByRole('menuitem', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBeInTheDocument();
  });

  it('groups the triggers in a menubar', () => {
    renderMenubar();

    expect(screen.getByRole('menubar')).toBeInTheDocument();
  });

  it('keeps every menu closed initially', () => {
    renderMenubar();

    expect(screen.queryByRole('menuitem', { name: /Resync/ })).not.toBeInTheDocument();
  });

  it('opens a menu when its trigger is clicked', async () => {
    const user = userEvent.setup();
    renderMenubar();

    await user.click(screen.getByRole('menuitem', { name: 'Board' }));

    expect(await screen.findByRole('menuitem', { name: /Resync/ })).toBeInTheDocument();
  });

  it('marks the open trigger as expanded', async () => {
    const user = userEvent.setup();
    renderMenubar();

    await user.click(screen.getByRole('menuitem', { name: 'Board' }));

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Board' }))
        .toHaveAttribute('data-state', 'open');
    });
  });

  it('renders its label and shortcut', async () => {
    const user = userEvent.setup();
    renderMenubar();

    await user.click(screen.getByRole('menuitem', { name: 'Board' }));

    expect(await screen.findByText('Board actions')).toBeInTheDocument();
    expect(screen.getByText('⌘R')).toBeInTheDocument();
  });

  it('fires the item handler when an item is chosen', async () => {
    const user = userEvent.setup();
    const onSelect = renderMenubar();

    await user.click(screen.getByRole('menuitem', { name: 'Board' }));
    await user.click(await screen.findByRole('menuitem', { name: /Resync/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('does not fire a disabled item', async () => {
    const user = userEvent.setup();
    const onSelect = renderMenubar();

    await user.click(screen.getByRole('menuitem', { name: 'Board' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderMenubar();

    await user.click(screen.getByRole('menuitem', { name: 'Board' }));
    await screen.findByRole('menuitem', { name: /Resync/ });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: /Resync/ })).not.toBeInTheDocument();
    });
  });

  it('opens the other menu independently', async () => {
    const user = userEvent.setup();
    renderMenubar();

    await user.click(screen.getByRole('menuitem', { name: 'Export' }));

    expect(await screen.findByRole('menuitem', { name: 'Download CSV' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Resync/ })).not.toBeInTheDocument();
  });

  it('renders a checked checkbox item', async () => {
    const user = userEvent.setup();
    renderMenubar();

    await user.click(screen.getByRole('menuitem', { name: 'Board' }));

    expect(await screen.findByRole('menuitemcheckbox', { name: 'Show archived' }))
      .toHaveAttribute('aria-checked', 'true');
  });

  it('marks the selected radio item and only that one', async () => {
    const user = userEvent.setup();
    renderMenubar();

    await user.click(screen.getByRole('menuitem', { name: 'Board' }));

    expect(await screen.findByRole('menuitemradio', { name: 'NDIS' }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Aged Care' }))
      .toHaveAttribute('aria-checked', 'false');
  });
});
