import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

// Environment setup: Radix ScrollArea observes its viewport and content, and
// jsdom ships no ResizeObserver.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function renderScrollArea(props: Record<string, unknown> = {}) {
  return render(
    <ScrollArea className="h-72 rounded-md border" {...props}>
      <ul>
        <li>Dana Reid</li>
        <li>Sam Okafor</li>
        <li>Priya Nair</li>
      </ul>
    </ScrollArea>,
  );
}

const viewportOf = (container: HTMLElement) =>
  container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;

describe('ScrollArea', () => {
  it('renders its children', () => {
    renderScrollArea();

    expect(screen.getByText('Dana Reid')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('puts the children inside the scrollable viewport', () => {
    const { container } = renderScrollArea();

    const viewport = viewportOf(container);

    expect(viewport).not.toBeNull();
    expect(within(viewport).getByText('Sam Okafor')).toBeInTheDocument();
  });

  it('keeps a caller class on the root alongside the clipping class', () => {
    const { container } = renderScrollArea();

    // The caller className lands on the Root, not the viewport: the viewport's
    // classes are hard-coded by the component.
    const root = container.firstElementChild as HTMLElement;
    const tokens = root.className.split(/\s+/);

    expect(tokens).toContain('h-72');
    expect(tokens).toContain('overflow-hidden');
    expect(viewportOf(container).className.split(/\s+/)).not.toContain('h-72');
  });

  it('renders the viewport inside the root it clips', () => {
    const { container } = renderScrollArea();

    const root = container.firstElementChild as HTMLElement;

    expect(root.contains(viewportOf(container))).toBe(true);
  });

  it('renders a vertical scrollbar when the caller asks for a permanent one', () => {
    const { container } = renderScrollArea({ type: 'always' });

    const scrollbar = container.querySelector('[data-orientation]') as HTMLElement;

    expect(scrollbar).not.toBeNull();
    expect(scrollbar).toHaveAttribute('data-orientation', 'vertical');
  });

  it('renders no scrollbar in the default hover mode when nothing overflows', () => {
    const { container } = renderScrollArea();

    expect(container.querySelector('[data-orientation]')).toBeNull();
  });

  it('ScrollBar keeps a caller class', () => {
    const { container } = render(
      <ScrollArea type="always">
        <p>Anything</p>
        <ScrollBar orientation="horizontal" className="custom-bar" />
      </ScrollArea>,
    );

    const bars = Array.from(
      container.querySelectorAll('[data-orientation]'),
    ) as HTMLElement[];
    const horizontal = bars.find((bar) => bar.dataset.orientation === 'horizontal');

    expect(horizontal).toBeDefined();
    expect((horizontal as HTMLElement).className.split(/\s+/)).toContain('custom-bar');
  });
});
