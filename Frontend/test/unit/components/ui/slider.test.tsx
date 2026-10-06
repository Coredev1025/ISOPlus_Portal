import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Slider } from '@/components/ui/slider';

// Environment setup: Radix Slider observes its track and uses pointer capture,
// neither of which jsdom implements.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
});

function renderSlider(props: Record<string, unknown> = {}) {
  return render(
    <Slider
      aria-label="Invoice tolerance"
      defaultValue={[40]}
      min={0}
      max={100}
      step={5}
      {...props}
    />,
  );
}

describe('Slider', () => {
  it('exposes a slider with its bounds and current value', () => {
    renderSlider();

    const slider = screen.getByRole('slider');

    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '100');
    expect(slider).toHaveAttribute('aria-valuenow', '40');
  });

  it('puts a caller aria-label on the root wrapper, leaving the thumb unnamed', () => {
    // Characterizes a real accessibility gap: extra props land on
    // SliderPrimitive.Root, but the element carrying role="slider" is the
    // hard-coded Thumb, so the label never reaches the control a screen reader
    // announces.
    const { container } = renderSlider();

    expect(container.firstElementChild).toHaveAttribute(
      'aria-label',
      'Invoice tolerance',
    );
    expect(screen.getByRole('slider')).not.toHaveAttribute('aria-label');
    expect(screen.queryByRole('slider', { name: 'Invoice tolerance' })).toBeNull();
  });

  it('increases the value by one step on ArrowRight', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSlider({ onValueChange });

    const slider = screen.getByRole('slider');
    await user.tab();
    expect(slider).toHaveFocus();
    await user.keyboard('{ArrowRight}');

    expect(slider).toHaveAttribute('aria-valuenow', '45');
    expect(onValueChange).toHaveBeenCalledWith([45]);
  });

  it('decreases the value by one step on ArrowLeft', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSlider({ onValueChange });

    await user.tab();
    await user.keyboard('{ArrowLeft}');

    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '35');
    expect(onValueChange).toHaveBeenCalledWith([35]);
  });

  it('jumps to the bounds on Home and End', async () => {
    const user = userEvent.setup();
    renderSlider();

    const slider = screen.getByRole('slider');
    await user.tab();
    await user.keyboard('{End}');
    expect(slider).toHaveAttribute('aria-valuenow', '100');

    await user.keyboard('{Home}');
    expect(slider).toHaveAttribute('aria-valuenow', '0');
  });

  it('does not move past its maximum', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSlider({ defaultValue: [100], onValueChange });

    await user.tab();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '100');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('does not move when disabled', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSlider({ disabled: true, onValueChange });

    const slider = screen.getByRole('slider');
    await user.tab();
    slider.focus();
    await user.keyboard('{ArrowRight}');

    expect(slider).not.toHaveFocus();
    expect(slider).toHaveAttribute('aria-valuenow', '40');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('honours a controlled value and does not move on its own', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Slider aria-label="Tolerance" value={[25]} onValueChange={onValueChange} max={100} />,
    );

    const slider = screen.getByRole('slider');
    await user.tab();
    await user.keyboard('{ArrowRight}');

    expect(onValueChange).toHaveBeenCalledWith([26]);
    expect(slider).toHaveAttribute('aria-valuenow', '25');
  });

  it('renders only one thumb even when given two values', () => {
    // Characterizes the vendored component: it hard-codes a single
    // SliderPrimitive.Thumb, so a two-value range renders one thumb and the
    // second value is unreachable by keyboard.
    renderSlider({ defaultValue: [20, 80] });

    const sliders = screen.getAllByRole('slider');

    expect(sliders).toHaveLength(1);
    expect(sliders[0]).toHaveAttribute('aria-valuenow', '20');
  });

  it('keeps a caller class on the root', () => {
    const { container } = renderSlider({ className: 'w-64' });

    const root = container.firstElementChild as HTMLElement;

    expect(root.className.split(/\s+/)).toContain('w-64');
    expect(root.className.split(/\s+/)).toContain('select-none');
  });

  it('reflects a vertical orientation', () => {
    const { container } = renderSlider({ orientation: 'vertical' });

    expect(container.firstElementChild).toHaveAttribute('data-orientation', 'vertical');
    expect(screen.getByRole('slider')).toHaveAttribute('aria-orientation', 'vertical');
  });
});
