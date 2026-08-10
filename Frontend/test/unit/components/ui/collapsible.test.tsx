import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';

function renderCollapsible(props: Record<string, unknown> = {}) {
  return render(
    <Collapsible {...props}>
      <CollapsibleTrigger>Show advanced filters</CollapsibleTrigger>
      <CollapsibleContent>Filter by funding source</CollapsibleContent>
    </Collapsible>,
  );
}

describe('Collapsible', () => {
  it('hides its content by default', () => {
    renderCollapsible();

    expect(screen.queryByText('Filter by funding source')).not.toBeInTheDocument();
  });

  it('reveals the content when the trigger is clicked', async () => {
    const user = userEvent.setup();
    renderCollapsible();

    await user.click(screen.getByRole('button', { name: 'Show advanced filters' }));

    expect(screen.getByText('Filter by funding source')).toBeInTheDocument();
  });

  it('hides the content again on a second click', async () => {
    const user = userEvent.setup();
    renderCollapsible();

    const trigger = screen.getByRole('button', { name: 'Show advanced filters' });
    await user.click(trigger);
    await user.click(trigger);

    expect(screen.queryByText('Filter by funding source')).not.toBeInTheDocument();
  });

  it('starts open when defaultOpen is set', () => {
    renderCollapsible({ defaultOpen: true });

    expect(screen.getByText('Filter by funding source')).toBeInTheDocument();
  });

  it('reports each open change', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderCollapsible({ onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Show advanced filters' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('honours a controlled open prop', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderCollapsible({ open: false, onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Show advanced filters' }));

    expect(screen.queryByText('Filter by funding source')).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('reflects its state on the trigger for assistive technology', async () => {
    const user = userEvent.setup();
    renderCollapsible();

    const trigger = screen.getByRole('button', { name: 'Show advanced filters' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not open while disabled', async () => {
    const user = userEvent.setup();
    renderCollapsible({ disabled: true });

    await user.click(screen.getByRole('button', { name: 'Show advanced filters' }));

    expect(screen.queryByText('Filter by funding source')).not.toBeInTheDocument();
  });
});
