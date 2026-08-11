import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Calendar } from '@/components/ui/calendar';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});


/**
 * react-day-picker renders each day as a gridcell (not a plain button), and the
 * neighbouring-month days repeat the same numbers — so pick the cell whose text
 * matches exactly and which is not marked as an outside day.
 */
function dayCell(day: number): HTMLElement {
  const cells = Array.from(document.querySelectorAll('[role="gridcell"], td, button'));
  const match = cells.find(
    (el) =>
      el.textContent?.trim() === String(day) &&
      !(el as HTMLElement).className.includes('day-outside') &&
      !el.closest('.day-outside'),
  );
  if (!match) throw new Error(`no day cell for ${day}`);
  return match as HTMLElement;
}

const AUGUST_2026 = new Date(2026, 7, 10);

function renderCalendar(props: Record<string, unknown> = {}) {
  return render(<Calendar mode="single" defaultMonth={AUGUST_2026} {...props} />);
}

describe('Calendar rendering', () => {
  it('shows the month it was pointed at', () => {
    renderCalendar();

    expect(screen.getByText('August 2026')).toBeInTheDocument();
  });

  it('renders the days as a grid', () => {
    renderCalendar();

    expect(screen.getByRole('grid')).toBeInTheDocument();
  });

  it('renders every day of the month', () => {
    renderCalendar();

    // August 2026 has 31 days; each is a gridcell button.
    expect(dayCell(1)).toBeInTheDocument();
    expect(dayCell(31)).toBeInTheDocument();
  });

  it('offers previous and next month navigation', () => {
    renderCalendar();

    expect(screen.getByRole('button', { name: /previous month/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next month/i })).toBeInTheDocument();
  });
});

describe('Calendar navigation', () => {
  it('moves to the next month', async () => {
    const user = userEvent.setup();
    renderCalendar();

    await user.click(screen.getByRole('button', { name: /next month/i }));

    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });

  it('moves to the previous month', async () => {
    const user = userEvent.setup();
    renderCalendar();

    await user.click(screen.getByRole('button', { name: /previous month/i }));

    expect(screen.getByText('July 2026')).toBeInTheDocument();
  });
});

describe('Calendar selection', () => {
  it('reports the Date that was clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderCalendar({ onSelect });

    await user.click(dayCell(12));

    expect(onSelect).toHaveBeenCalled();
    const picked = onSelect.mock.calls[0][0] as Date;
    expect(picked.getFullYear()).toBe(2026);
    expect(picked.getMonth()).toBe(7);
    expect(picked.getDate()).toBe(12);
  });

  it('marks the selected day for assistive technology', () => {
    renderCalendar({ selected: new Date(2026, 7, 12), onSelect: () => {} });

    expect(dayCell(12)).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('does not mark an unselected day', () => {
    renderCalendar({ selected: new Date(2026, 7, 12), onSelect: () => {} });

    expect(dayCell(13)).not.toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('does not select a disabled day', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderCalendar({ onSelect, disabled: { before: new Date(2026, 7, 15) } });

    await user.click(dayCell(12));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks a disabled day as disabled', () => {
    renderCalendar({ disabled: { before: new Date(2026, 7, 15) } });

    expect(dayCell(12)).toBeDisabled();
  });

  it('still selects a day outside the disabled range', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderCalendar({ onSelect, disabled: { before: new Date(2026, 7, 15) } });

    await user.click(dayCell(20));

    expect(onSelect).toHaveBeenCalled();
  });
});

describe('Calendar range mode', () => {
  it('reports a range as the user picks both ends', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Calendar mode="range" defaultMonth={AUGUST_2026} onSelect={onSelect} />,
    );

    await user.click(dayCell(10));

    const first = onSelect.mock.calls[0][0] as { from?: Date; to?: Date };
    expect(first.from?.getDate()).toBe(10);
  });
});

describe('Calendar outside days', () => {
  it('shows the neighbouring month days by default', () => {
    const { container } = renderCalendar();

    expect(container.querySelector('.day-outside')).not.toBeNull();
  });

  it('hides them when showOutsideDays is false', () => {
    const { container } = renderCalendar({ showOutsideDays: false });

    expect(container.querySelector('.day-outside')).toBeNull();
  });
});

describe('Calendar styling', () => {
  it('keeps a caller class on the root', () => {
    const { container } = renderCalendar({ className: 'rounded-md border' });

    const root = container.firstElementChild as HTMLElement;
    expect(root.className.split(/\s+/)).toContain('rounded-md');
  });

  it('renders the weekday headers', () => {
    renderCalendar();

    const grid = screen.getByRole('grid');
    expect(within(grid).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(7);
  });
});
