import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Progress } from '@/components/ui/progress';

/**
 * The indicator is positioned with translateX(-(100 - value)%), so the
 * transform is the only observable record of the value in jsdom. These tests
 * hand-derive it: 0 → -100%, 40 → -60%, 100 → -0%.
 */
function indicatorTransform(container: HTMLElement) {
  const indicator = container.querySelector('[style*="translateX"]') as HTMLElement | null;
  return indicator?.style.transform ?? null;
}

describe('Progress', () => {
  it('exposes the progressbar role', () => {
    render(<Progress value={40} aria-label="Sync progress" />);

    expect(screen.getByRole('progressbar', { name: 'Sync progress' })).toBeInTheDocument();
  });

  it('renders an empty bar at zero', () => {
    const { container } = render(<Progress value={0} />);

    expect(indicatorTransform(container)).toBe('translateX(-100%)');
  });

  it('renders a part-filled bar', () => {
    const { container } = render(<Progress value={40} />);

    expect(indicatorTransform(container)).toBe('translateX(-60%)');
  });

  it('renders a full bar at one hundred', () => {
    const { container } = render(<Progress value={100} />);

    expect(indicatorTransform(container)).toBe('translateX(-0%)');
  });

  it('treats a missing value as empty rather than throwing', () => {
    const { container } = render(<Progress />);

    expect(indicatorTransform(container)).toBe('translateX(-100%)');
  });

  it('does NOT report the value to assistive technology', () => {
    // components/ui/progress.tsx destructures `value` out of props and uses it
    // only for the indicator transform — it is never forwarded to
    // ProgressPrimitive.Root. Radix therefore emits no aria-valuenow, and a
    // screen reader hears an indeterminate bar however full it looks.
    // Documents current behaviour; this is a real accessibility gap.
    render(<Progress value={40} aria-label="Sync progress" />);

    const bar = screen.getByRole('progressbar', { name: 'Sync progress' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('data-state', 'indeterminate');
  });

  it('stays indeterminate to assistive technology even at 100', () => {
    render(<Progress value={100} aria-label="Sync progress" />);

    expect(screen.getByRole('progressbar', { name: 'Sync progress' }))
      .toHaveAttribute('data-state', 'indeterminate');
  });

  it('keeps a caller class', () => {
    render(<Progress value={10} className="h-1" aria-label="Sync progress" />);

    expect(screen.getByRole('progressbar', { name: 'Sync progress' }).className.split(/\s+/))
      .toContain('h-1');
  });
});
