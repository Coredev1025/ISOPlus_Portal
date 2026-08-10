import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from '@/components/ui/checkbox';

describe('Checkbox', () => {
  it('renders an unchecked checkbox by default', () => {
    render(<Checkbox aria-label="Select record" />);

    const box = screen.getByRole('checkbox', { name: 'Select record' });
    expect(box).toBeInTheDocument();
    expect(box).not.toBeChecked();
  });

  it('checks on click and reports the new value', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Select record" onCheckedChange={onCheckedChange} />);

    const box = screen.getByRole('checkbox', { name: 'Select record' });
    await user.click(box);

    expect(box).toBeChecked();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('unchecks on a second click', async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Select record" />);

    const box = screen.getByRole('checkbox', { name: 'Select record' });
    await user.click(box);
    await user.click(box);

    expect(box).not.toBeChecked();
  });

  it('shows the indicator only once checked', async () => {
    const user = userEvent.setup();
    const { container } = render(<Checkbox aria-label="Select record" />);

    expect(container.querySelector('svg')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Select record' }));

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('supports the indeterminate state used by select-all headers', () => {
    render(<Checkbox aria-label="Select all" checked="indeterminate" onCheckedChange={() => {}} />);

    expect(screen.getByRole('checkbox', { name: 'Select all' }))
      .toHaveAttribute('data-state', 'indeterminate');
  });

  it('ignores clicks while disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Select record" disabled onCheckedChange={onCheckedChange} />);

    const box = screen.getByRole('checkbox', { name: 'Select record' });
    await user.click(box);

    expect(box).toBeDisabled();
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('toggles from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Select record" />);

    await user.tab();
    await user.keyboard(' ');

    expect(screen.getByRole('checkbox', { name: 'Select record' })).toBeChecked();
  });

  it('keeps a caller class', () => {
    render(<Checkbox aria-label="Select record" className="mr-2" />);

    expect(screen.getByRole('checkbox', { name: 'Select record' }).className.split(/\s+/))
      .toContain('mr-2');
  });
});
