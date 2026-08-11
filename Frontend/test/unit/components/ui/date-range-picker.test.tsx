import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DateRangePicker,
  DATE_PICKER_FROM_YEAR,
  DATE_PICKER_TO_YEAR,
} from '@/components/ui/date-range-picker';

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

const FROM = new Date(2026, 7, 3);
const TO = new Date(2026, 7, 17);

function renderPicker(props: Record<string, unknown> = {}) {
  const onChange = (props.onChange as () => void) ?? vi.fn();
  render(<DateRangePicker label="Service date" onChange={onChange} {...props} />);
  return onChange;
}

describe('DateRangePicker trigger label', () => {
  it('falls back to the label when no range is selected', () => {
    renderPicker();

    expect(screen.getByRole('button', { name: /Service date/ })).toBeInTheDocument();
  });

  it('shows just the start date when only the start is chosen', () => {
    renderPicker({ value: { from: FROM } });

    expect(screen.getByRole('button', { name: /03\/08\/2026/ })).toBeInTheDocument();
  });

  it('shows both ends once the range is complete', () => {
    renderPicker({ value: { from: FROM, to: TO } });

    expect(
      screen.getByRole('button', { name: /03\/08\/2026 - 17\/08\/2026/ }),
    ).toBeInTheDocument();
  });

  it('treats a range object with no from as unselected', () => {
    renderPicker({ value: { from: undefined } as never });

    expect(screen.getByRole('button', { name: /Service date/ })).toBeInTheDocument();
  });
});

describe('DateRangePicker inline clear button', () => {
  it('is absent while nothing is selected', () => {
    renderPicker();

    expect(screen.queryByRole('button', { name: 'Clear Service date' }))
      .not.toBeInTheDocument();
  });

  it('appears once a start date is selected', () => {
    renderPicker({ value: { from: FROM } });

    expect(screen.getByRole('button', { name: 'Clear Service date' })).toBeInTheDocument();
  });

  it('names itself after the field it clears', () => {
    renderPicker({ label: 'Invoice date', value: { from: FROM } });

    expect(screen.getByRole('button', { name: 'Clear Invoice date' })).toBeInTheDocument();
  });

  it('clears the range when pressed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ value: { from: FROM, to: TO }, onChange });

    await user.click(screen.getByRole('button', { name: 'Clear Service date' }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});

describe('DateRangePicker popover', () => {
  it('keeps the calendar closed until the trigger is pressed', () => {
    renderPicker();

    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('opens the calendar on the trigger', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: /Service date/ }));

    // numberOfMonths={2}, so the popover renders two month grids.
    expect(await screen.findAllByRole('grid')).not.toHaveLength(0);
  });

  it('shows the two-month view', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: /Service date/ }));

    expect(await screen.findAllByRole('grid')).toHaveLength(2);
  });

  it('prompts for an end date when only the start is chosen', async () => {
    const user = userEvent.setup();
    renderPicker({ value: { from: FROM } });

    await user.click(screen.getByRole('button', { name: /03\/08\/2026/ }));

    expect(await screen.findByText('Select an end date to complete the range.'))
      .toBeInTheDocument();
  });

  it('shows the generic hint when nothing is selected', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: /Service date/ }));

    expect(
      await screen.findByText(
        'Use the month and year menus to jump quickly, then pick start and end dates.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the generic hint again once the range is complete', async () => {
    const user = userEvent.setup();
    renderPicker({ value: { from: FROM, to: TO } });

    await user.click(screen.getByRole('button', { name: /03\/08\/2026 - 17\/08\/2026/ }));

    expect(
      await screen.findByText(
        'Use the month and year menus to jump quickly, then pick start and end dates.',
      ),
    ).toBeInTheDocument();
  });
});

describe('DateRangePicker in-popover Clear', () => {
  it('is disabled while nothing is selected', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: /Service date/ }));

    expect(await screen.findByRole('button', { name: 'Clear' })).toBeDisabled();
  });

  it('is enabled once a start date exists', async () => {
    const user = userEvent.setup();
    renderPicker({ value: { from: FROM } });

    await user.click(screen.getByRole('button', { name: /03\/08\/2026/ }));

    expect(await screen.findByRole('button', { name: 'Clear' })).toBeEnabled();
  });

  it('clears the range when pressed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ value: { from: FROM, to: TO }, onChange });

    await user.click(screen.getByRole('button', { name: /03\/08\/2026 - 17\/08\/2026/ }));
    await user.click(await screen.findByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});

describe('DateRangePicker year bounds', () => {
  it('spans fifteen years back and two forward from the current year', () => {
    const currentYear = new Date().getFullYear();

    expect(DATE_PICKER_FROM_YEAR).toBe(currentYear - 15);
    expect(DATE_PICKER_TO_YEAR).toBe(currentYear + 2);
  });

  it('offers every year in that range in the dropdown', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: /Service date/ }));
    await screen.findAllByRole('grid');

    const years = screen.getAllByRole('option')
      .map((option) => Number(option.textContent))
      .filter((year) => Number.isFinite(year) && year > 1900);

    expect(Math.min(...years)).toBe(DATE_PICKER_FROM_YEAR);
    expect(Math.max(...years)).toBe(DATE_PICKER_TO_YEAR);
  });
});
