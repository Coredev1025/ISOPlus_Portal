import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
} from '@/components/ui/select';

// jsdom ships none of these, and Radix's Select calls all of them while opening.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}

function renderSelect(
  props: Record<string, unknown> = {},
  contentProps: Record<string, unknown> = {},
) {
  return render(
    <Select {...props}>
      <SelectTrigger aria-label="Invoice status">
        <SelectValue placeholder="Choose a status" />
      </SelectTrigger>
      <SelectContent {...contentProps}>
        <SelectGroup>
          <SelectLabel>Statuses</SelectLabel>
          <SelectSeparator />
          <SelectItem value="draft">Draft</SelectItem>
          <SelectItem value="sent">Sent</SelectItem>
          <SelectItem value="paid" disabled>
            Paid
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>,
  );
}

describe('Select', () => {
  it('shows the placeholder and no listbox before it is opened', () => {
    renderSelect();

    expect(screen.getByRole('combobox', { name: 'Invoice status' })).toHaveTextContent(
      'Choose a status',
    );
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens the listbox of options on the trigger', async () => {
    const user = userEvent.setup();
    renderSelect();

    await user.click(screen.getByRole('combobox'));

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Draft',
      'Sent',
      'Paid',
    ]);
  });

  it('wires the trigger to the listbox it controls', async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole('combobox');

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
  });

  it('shows the chosen option in the trigger, reports it and closes', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ onValueChange });

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Sent' }));

    expect(onValueChange).toHaveBeenCalledWith('sent');
    expect(screen.getByRole('combobox')).toHaveTextContent('Sent');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('marks the chosen option as selected when reopened', async () => {
    const user = userEvent.setup();
    renderSelect({ defaultValue: 'draft' });

    expect(screen.getByRole('combobox')).toHaveTextContent('Draft');
    await user.click(screen.getByRole('combobox'));

    expect(screen.getByRole('option', { name: 'Draft' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: 'Sent' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('will not let a disabled option be chosen', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ onValueChange });

    // While the listbox is open Radix marks everything outside it aria-hidden,
    // so the trigger is no longer reachable by role — grab it beforehand.
    const trigger = screen.getByRole('combobox');
    await user.click(trigger);
    const paid = screen.getByRole('option', { name: 'Paid' });
    expect(paid).toHaveAttribute('data-disabled');

    await user.click(paid);

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(trigger).toHaveTextContent('Choose a status');
  });

  it('lets a controlled value override what the user picks', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ value: 'draft', onValueChange });

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Sent' }));

    expect(onValueChange).toHaveBeenCalledWith('sent');
    expect(screen.getByRole('combobox')).toHaveTextContent('Draft');
  });

  it('closes on Escape without changing the value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ onValueChange });

    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('reports each open state change', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderSelect({ onOpenChange });

    await user.click(screen.getByRole('combobox'));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('does not open a disabled select', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderSelect({ disabled: true, onOpenChange });

    await user.click(screen.getByRole('combobox'));

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('groups options under a label', async () => {
    const user = userEvent.setup();
    renderSelect();

    await user.click(screen.getByRole('combobox'));

    expect(screen.getByRole('group', { name: 'Statuses' })).toBeInTheDocument();
  });

  it('moves focus into the listbox on open', async () => {
    const user = userEvent.setup();
    renderSelect();

    await user.click(screen.getByRole('combobox'));

    expect(screen.getByRole('listbox')).toContainElement(document.activeElement as HTMLElement);
  });

  it('merges a caller class into the content without dropping its own', async () => {
    const user = userEvent.setup();
    renderSelect({}, { className: 'w-40' });

    await user.click(screen.getByRole('combobox'));
    const tokens = screen.getByRole('listbox').className.split(/\s+/);

    expect(tokens).toContain('w-40');
    expect(tokens).toContain('bg-popover');
  });

  it('merges a caller class into the trigger without dropping its own', () => {
    render(
      <Select>
        <SelectTrigger className="h-8" aria-label="Board">
          <SelectValue placeholder="Pick" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );

    const tokens = screen.getByRole('combobox').className.split(/\s+/);

    expect(tokens).toContain('h-8');
    expect(tokens).toContain('border-input');
  });
});
