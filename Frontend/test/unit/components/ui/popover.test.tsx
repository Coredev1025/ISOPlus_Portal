import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}

function renderPopover(
  props: Record<string, unknown> = {},
  contentProps: Record<string, unknown> = {},
) {
  return render(
    <div>
      <button type="button">Sync board</button>
      <Popover {...props}>
        <PopoverTrigger>Date range</PopoverTrigger>
        <PopoverContent {...contentProps}>
          <h2>Pick a range</h2>
          <button type="button">This month</button>
        </PopoverContent>
      </Popover>
    </div>,
  );
}

describe('Popover', () => {
  it('renders only the trigger before it is opened', () => {
    renderPopover();

    expect(screen.getByRole('button', { name: 'Date range' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Pick a range')).not.toBeInTheDocument();
  });

  it('opens the content on the trigger', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'Date range' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Pick a range');
  });

  it('wires the trigger to the content it controls', async () => {
    const user = userEvent.setup();
    renderPopover();
    const trigger = screen.getByRole('button', { name: 'Date range' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', screen.getByRole('dialog').id);
  });

  it('closes again when the trigger is clicked a second time', async () => {
    const user = userEvent.setup();
    renderPopover();
    const trigger = screen.getByRole('button', { name: 'Date range' });

    await user.click(trigger);
    await user.click(trigger);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when something outside it is clicked', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    await user.click(screen.getByRole('button', { name: 'Sync board' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays open when its own content is clicked', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    await user.click(screen.getByRole('button', { name: 'This month' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('leaves the rest of the page interactive, unlike a modal dialog', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'Date range' }));

    expect(screen.getByRole('button', { name: 'Sync board' })).toBeVisible();
  });

  it('reports each open state change', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderPopover({ onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('lets a controlled open prop override Escape', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderPopover({ open: true, onOpenChange });

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps a controlled popover shut when the trigger is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderPopover({ open: false, onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Date range' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the content on open and back to the trigger on close', async () => {
    const user = userEvent.setup();
    renderPopover();
    const trigger = screen.getByRole('button', { name: 'Date range' });

    await user.click(trigger);
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it('merges a caller class into the content without dropping its own', async () => {
    const user = userEvent.setup();
    renderPopover({}, { className: 'w-96' });

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    const tokens = screen.getByRole('dialog').className.split(/\s+/);

    expect(tokens).toContain('w-96');
    expect(tokens).toContain('bg-popover');
  });

  it('positions itself on the requested side', async () => {
    const user = userEvent.setup();
    renderPopover({}, { side: 'top', align: 'start' });

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    const content = screen.getByRole('dialog');

    expect(content).toHaveAttribute('data-side', 'top');
    expect(content).toHaveAttribute('data-align', 'start');
  });
});
