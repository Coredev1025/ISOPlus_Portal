import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

// jsdom ships none of the pointer-capture APIs Radix reaches for.
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}

function classesOf(element: Element) {
  return element.className.split(/\s+/).filter(Boolean);
}

type GroupProps = Record<string, unknown>;

function renderSingle(props: GroupProps = {}) {
  return render(
    <ToggleGroup type="single" aria-label="Text style" {...props}>
      <ToggleGroupItem value="bold">Bold</ToggleGroupItem>
      <ToggleGroupItem value="italic">Italic</ToggleGroupItem>
      <ToggleGroupItem value="strike" disabled>
        Strikethrough
      </ToggleGroupItem>
    </ToggleGroup>,
  );
}

function renderMultiple(props: GroupProps = {}) {
  return render(
    <ToggleGroup type="multiple" aria-label="Text style" {...props}>
      <ToggleGroupItem value="bold">Bold</ToggleGroupItem>
      <ToggleGroupItem value="italic">Italic</ToggleGroupItem>
    </ToggleGroup>,
  );
}

describe('ToggleGroup (single)', () => {
  it('renders every item unpressed by default', () => {
    renderSingle();

    expect(screen.getByRole('group', { name: 'Text style' })).toBeInTheDocument();
    for (const name of ['Bold', 'Italic', 'Strikethrough']) {
      expect(screen.getByRole('radio', { name })).toHaveAttribute('data-state', 'off');
    }
  });

  it('presses the clicked item and reports its value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSingle({ onValueChange });

    await user.click(screen.getByRole('radio', { name: 'Bold' }));

    expect(onValueChange).toHaveBeenCalledWith('bold');
    expect(screen.getByRole('radio', { name: 'Bold' })).toHaveAttribute('data-state', 'on');
  });

  it('replaces the selection rather than adding to it', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSingle({ onValueChange });

    await user.click(screen.getByRole('radio', { name: 'Bold' }));
    await user.click(screen.getByRole('radio', { name: 'Italic' }));

    expect(onValueChange).toHaveBeenLastCalledWith('italic');
    expect(screen.getByRole('radio', { name: 'Bold' })).toHaveAttribute('data-state', 'off');
    expect(screen.getByRole('radio', { name: 'Italic' })).toHaveAttribute('data-state', 'on');
  });

  it('clears the selection when the pressed item is clicked again', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSingle({ onValueChange });

    await user.click(screen.getByRole('radio', { name: 'Bold' }));
    await user.click(screen.getByRole('radio', { name: 'Bold' }));

    expect(onValueChange).toHaveBeenLastCalledWith('');
    expect(screen.getByRole('radio', { name: 'Bold' })).toHaveAttribute('data-state', 'off');
  });

  it('ignores clicks on a disabled item', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSingle({ onValueChange });

    await user.click(screen.getByRole('radio', { name: 'Strikethrough' }));

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Strikethrough' })).toHaveAttribute(
      'data-state',
      'off',
    );
  });

  it('honours a controlled value', () => {
    renderSingle({ value: 'italic', onValueChange: () => {} });

    expect(screen.getByRole('radio', { name: 'Italic' })).toHaveAttribute('data-state', 'on');
    expect(screen.getByRole('radio', { name: 'Bold' })).toHaveAttribute('data-state', 'off');
  });
});

describe('ToggleGroup (multiple)', () => {
  it('exposes its items as toggle buttons', () => {
    renderMultiple();

    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('accumulates selections and reports them as an array', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderMultiple({ onValueChange });

    await user.click(screen.getByRole('button', { name: 'Bold' }));
    await user.click(screen.getByRole('button', { name: 'Italic' }));

    expect(onValueChange).toHaveBeenNthCalledWith(1, ['bold']);
    expect(onValueChange).toHaveBeenNthCalledWith(2, ['bold', 'italic']);
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('removes a value when its item is clicked again', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderMultiple({ onValueChange, defaultValue: ['bold', 'italic'] });

    await user.click(screen.getByRole('button', { name: 'Bold' }));

    expect(onValueChange).toHaveBeenLastCalledWith(['italic']);
  });
});

describe('ToggleGroup styling context', () => {
  it('gives items the default toggle height when the group sets nothing', () => {
    renderSingle();

    expect(classesOf(screen.getByRole('radio', { name: 'Bold' }))).toContain('h-10');
  });

  it('passes the group variant and size down to every item', () => {
    renderSingle({ variant: 'outline', size: 'sm' });

    for (const name of ['Bold', 'Italic']) {
      const classes = classesOf(screen.getByRole('radio', { name }));
      expect(classes).toContain('border-input');
      expect(classes).toContain('h-9');
    }
  });

  it('lets an item choose its own size when the group sets none', () => {
    render(
      <ToggleGroup type="single" aria-label="Text style">
        <ToggleGroupItem value="bold" size="lg">
          Bold
        </ToggleGroupItem>
      </ToggleGroup>,
    );

    expect(classesOf(screen.getByRole('radio', { name: 'Bold' }))).toContain('h-11');
  });

  // Precedence is `context.variant || variant`, so the group wins over the item —
  // the reverse of what the prop on the item suggests. Characterized, not endorsed.
  it('lets the group override a variant set on the item', () => {
    render(
      <ToggleGroup type="single" aria-label="Text style" variant="outline">
        <ToggleGroupItem value="bold" variant="default">
          Bold
        </ToggleGroupItem>
      </ToggleGroup>,
    );

    expect(classesOf(screen.getByRole('radio', { name: 'Bold' }))).toContain('border-input');
  });

  it('keeps a caller className alongside the variant classes', () => {
    render(
      <ToggleGroup type="single" aria-label="Alignment" className="w-full">
        <ToggleGroupItem value="left" className="rounded-none">
          Left
        </ToggleGroupItem>
      </ToggleGroup>,
    );

    const item = screen.getByRole('radio', { name: 'Left' });
    expect(classesOf(item)).toContain('rounded-none');
    expect(classesOf(screen.getByRole('group', { name: 'Alignment' }))).toContain('w-full');
  });
});
