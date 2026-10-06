import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Switch } from '@/components/ui/switch';

describe('Switch', () => {
  it('renders an unchecked switch by default', () => {
    render(<Switch aria-label="Enable sync" />);

    const toggle = screen.getByRole('switch', { name: 'Enable sync' });
    expect(toggle).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });

  it('turns on when clicked and reports the new value', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Enable sync" onCheckedChange={onCheckedChange} />);

    const toggle = screen.getByRole('switch', { name: 'Enable sync' });
    await user.click(toggle);

    expect(toggle).toBeChecked();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('turns back off on a second click', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Enable sync" onCheckedChange={onCheckedChange} />);

    const toggle = screen.getByRole('switch', { name: 'Enable sync' });
    await user.click(toggle);
    await user.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it('honours a controlled checked value', () => {
    render(<Switch aria-label="Enable sync" checked onCheckedChange={() => {}} />);

    expect(screen.getByRole('switch', { name: 'Enable sync' })).toBeChecked();
  });

  it('does not change a controlled switch on its own', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Enable sync" checked={false} onCheckedChange={onCheckedChange} />);

    const toggle = screen.getByRole('switch', { name: 'Enable sync' });
    await user.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('ignores clicks while disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Enable sync" disabled onCheckedChange={onCheckedChange} />);

    const toggle = screen.getByRole('switch', { name: 'Enable sync' });
    await user.click(toggle);

    expect(toggle).toBeDisabled();
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('toggles from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Enable sync" />);

    await user.tab();
    const toggle = screen.getByRole('switch', { name: 'Enable sync' });
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');

    expect(toggle).toBeChecked();
  });

  it('exposes its state as a data attribute for styling', async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Enable sync" />);

    const toggle = screen.getByRole('switch', { name: 'Enable sync' });
    expect(toggle).toHaveAttribute('data-state', 'unchecked');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('data-state', 'checked');
  });
});
