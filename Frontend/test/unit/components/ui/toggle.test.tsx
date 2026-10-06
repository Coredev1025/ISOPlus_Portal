import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toggle, toggleVariants } from '@/components/ui/toggle';

describe('Toggle', () => {
  it('renders an unpressed toggle button', () => {
    render(<Toggle aria-label="Bold" />);

    const toggle = screen.getByRole('button', { name: 'Bold' });
    expect(toggle).toHaveAttribute('data-state', 'off');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('presses on click and reports the new state', async () => {
    const user = userEvent.setup();
    const onPressedChange = vi.fn();
    render(<Toggle aria-label="Bold" onPressedChange={onPressedChange} />);

    await user.click(screen.getByRole('button', { name: 'Bold' }));

    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    expect(onPressedChange).toHaveBeenCalledWith(true);
  });

  it('releases on a second click', async () => {
    const user = userEvent.setup();
    const onPressedChange = vi.fn();
    render(<Toggle aria-label="Bold" onPressedChange={onPressedChange} />);

    const toggle = screen.getByRole('button', { name: 'Bold' });
    await user.click(toggle);
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(onPressedChange).toHaveBeenLastCalledWith(false);
  });

  it('honours a controlled pressed value', () => {
    render(<Toggle aria-label="Bold" pressed onPressedChange={() => {}} />);

    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores clicks while disabled', async () => {
    const user = userEvent.setup();
    const onPressedChange = vi.fn();
    render(<Toggle aria-label="Bold" disabled onPressedChange={onPressedChange} />);

    await user.click(screen.getByRole('button', { name: 'Bold' }));

    expect(onPressedChange).not.toHaveBeenCalled();
  });

  it('renders its children', () => {
    render(<Toggle>Bold</Toggle>);

    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
  });
});

describe('toggleVariants', () => {
  it('defaults to no border', () => {
    expect(toggleVariants()).not.toContain('border-input');
  });

  it('adds a border for the outline variant', () => {
    expect(toggleVariants({ variant: 'outline' })).toContain('border-input');
  });

  it.each([
    ['sm', 'h-9'],
    ['lg', 'h-11'],
  ] as const)('gives the %s size its own height', (size, token) => {
    expect(toggleVariants({ size })).toContain(token);
  });

  it('always applies the pressed-state styling hook', () => {
    expect(toggleVariants()).toContain('data-[state=on]:');
  });
});
