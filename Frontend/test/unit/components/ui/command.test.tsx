import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from '@/components/ui/command';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

function renderPalette(onSelect = vi.fn()) {
  render(
    <Command>
      <CommandInput placeholder="Search boards" />
      <CommandList>
        <CommandEmpty>No boards found.</CommandEmpty>
        <CommandGroup heading="Boards">
          <CommandItem value="ndis-services" onSelect={onSelect}>
            NDIS Services
          </CommandItem>
          <CommandItem value="aged-care" onSelect={onSelect}>
            Aged Care
          </CommandItem>
          <CommandItem value="archived" disabled onSelect={onSelect}>
            Archived
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>,
  );
  return onSelect;
}

describe('Command palette', () => {
  it('lists every item before any query is typed', () => {
    renderPalette();

    expect(screen.getByRole('option', { name: 'NDIS Services' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Aged Care' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Archived' })).toBeInTheDocument();
  });

  it('renders the group heading', () => {
    renderPalette();

    expect(screen.getByText('Boards')).toBeInTheDocument();
  });

  it('hides the empty state while items match', () => {
    renderPalette();

    expect(screen.queryByText('No boards found.')).not.toBeInTheDocument();
  });

  it('filters the list down as the user types', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByPlaceholderText('Search boards'), 'aged');

    expect(screen.getByRole('option', { name: 'Aged Care' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'NDIS Services' })).not.toBeInTheDocument();
  });

  it('matches case-insensitively', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByPlaceholderText('Search boards'), 'NDIS');

    expect(screen.getByRole('option', { name: 'NDIS Services' })).toBeInTheDocument();
  });

  it('shows the empty state when nothing matches', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByPlaceholderText('Search boards'), 'zzzz');

    expect(await screen.findByText('No boards found.')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('restores the full list when the query is cleared', async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = screen.getByPlaceholderText('Search boards');

    await user.type(input, 'aged');
    await user.clear(input);

    expect(screen.getByRole('option', { name: 'NDIS Services' })).toBeInTheDocument();
  });

  it('reports the selected value when an item is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = renderPalette();

    await user.click(screen.getByRole('option', { name: 'Aged Care' }));

    expect(onSelect).toHaveBeenCalledWith('aged-care');
  });

  it('does not select a disabled item', async () => {
    const user = userEvent.setup();
    const onSelect = renderPalette();

    await user.click(screen.getByRole('option', { name: 'Archived' }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks a disabled item for assistive technology', () => {
    renderPalette();

    expect(screen.getByRole('option', { name: 'Archived' }))
      .toHaveAttribute('aria-disabled', 'true');
  });

  it('selects the highlighted item on Enter', async () => {
    const user = userEvent.setup();
    const onSelect = renderPalette();

    await user.type(screen.getByPlaceholderText('Search boards'), 'aged{Enter}');

    expect(onSelect).toHaveBeenCalledWith('aged-care');
  });

  it('exposes the list as a listbox', () => {
    renderPalette();

    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

describe('CommandShortcut and CommandSeparator', () => {
  it('renders a shortcut hint next to its item', () => {
    render(
      <Command>
        <CommandList>
          <CommandItem value="new">
            New board
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
        </CommandList>
      </Command>,
    );

    expect(screen.getByText('⌘N')).toBeInTheDocument();
  });

  it('renders a separator between groups', () => {
    const { container } = render(
      <Command>
        <CommandList>
          <CommandGroup heading="A">
            <CommandItem value="a">A item</CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="B">
            <CommandItem value="b">B item</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );

    expect(container.querySelector('[cmdk-separator]')).not.toBeNull();
  });
});

describe('CommandDialog', () => {
  it('renders nothing while closed', () => {
    render(
      <CommandDialog open={false}>
        <CommandList>
          <CommandItem value="a">A item</CommandItem>
        </CommandList>
      </CommandDialog>,
    );

    expect(screen.queryByText('A item')).not.toBeInTheDocument();
  });

  it('renders the palette inside a dialog when open', () => {
    render(
      <CommandDialog open>
        <CommandList>
          <CommandItem value="a">A item</CommandItem>
        </CommandList>
      </CommandDialog>,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('A item')).toBeInTheDocument();
  });
});
