import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from '@/components/ui/carousel';

/**
 * embla measures the DOM to decide how far it can scroll, and jsdom reports
 * every element as zero-sized, so it always believes there is nowhere to go:
 * both arrows stay disabled and slides never advance. These tests therefore
 * pin what IS observable — the roles, accessible names, slide rendering and
 * orientation wiring — and characterize the disabled state rather than
 * pretending to drive a carousel jsdom cannot lay out.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  // embla tracks slides-in-view with IntersectionObserver, which jsdom lacks.
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as never;
  // embla resolves its breakpoint options through matchMedia, which jsdom
  // does not implement.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
});

function renderCarousel(props: Record<string, unknown> = {}) {
  return render(
    <Carousel {...props}>
      <CarouselContent>
        <CarouselItem>Slide one</CarouselItem>
        <CarouselItem>Slide two</CarouselItem>
        <CarouselItem>Slide three</CarouselItem>
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>,
  );
}

describe('Carousel structure', () => {
  it('renders every slide', () => {
    renderCarousel();

    expect(screen.getByText('Slide one')).toBeInTheDocument();
    expect(screen.getByText('Slide two')).toBeInTheDocument();
    expect(screen.getByText('Slide three')).toBeInTheDocument();
  });

  it('exposes the carousel as a region described as a carousel', () => {
    // aria-roledescription is a role *description*, not an accessible name —
    // the region itself is unnamed, so it cannot be queried by name.
    renderCarousel();

    const region = screen.getByRole('region');
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(region).toHaveAccessibleName('');
  });

  it('marks each slide as a group described as a slide', () => {
    renderCarousel();

    const slides = screen.getAllByRole('group');
    expect(slides).toHaveLength(3);
    for (const slide of slides) {
      expect(slide).toHaveAttribute('aria-roledescription', 'slide');
    }
  });

  it('gives the arrows accessible names from their sr-only labels', () => {
    renderCarousel();

    expect(screen.getByRole('button', { name: 'Previous slide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next slide' })).toBeInTheDocument();
  });
});

describe('Carousel orientation', () => {
  it('defaults to horizontal', () => {
    const { container } = renderCarousel();

    const track = container.querySelector('.flex') as HTMLElement;
    expect(track.className.split(/\s+/)).toContain('-ml-4');
  });

  it('lays the slides out in a column when vertical', () => {
    const { container } = renderCarousel({ orientation: 'vertical' });

    const track = container.querySelector('.flex') as HTMLElement;
    expect(track.className.split(/\s+/)).toContain('-mt-4');
  });

  it('lays the slides out in a row when horizontal', () => {
    const { container } = renderCarousel({ orientation: 'horizontal' });

    const track = container.querySelector('.flex') as HTMLElement;
    expect(track.className.split(/\s+/)).toContain('-ml-4');
  });
});

describe('Carousel navigation state in jsdom', () => {
  it('disables both arrows, because embla sees a zero-width viewport', () => {
    // Documents the jsdom-only outcome: with no layout there is no scrollable
    // range, so canScrollPrev/canScrollNext are both false. A real browser
    // would enable "Next slide" here.
    renderCarousel();

    expect(screen.getByRole('button', { name: 'Previous slide' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next slide' })).toBeDisabled();
  });

  it('keeps a caller class on the arrows', () => {
    render(
      <Carousel>
        <CarouselContent>
          <CarouselItem>Slide one</CarouselItem>
        </CarouselContent>
        <CarouselPrevious className="left-2" />
        <CarouselNext className="right-2" />
      </Carousel>,
    );

    expect(screen.getByRole('button', { name: 'Previous slide' }).className.split(/\s+/))
      .toContain('left-2');
    expect(screen.getByRole('button', { name: 'Next slide' }).className.split(/\s+/))
      .toContain('right-2');
  });

  it('renders a carousel with a single slide without arrows enabled', () => {
    render(
      <Carousel>
        <CarouselContent>
          <CarouselItem>Only slide</CarouselItem>
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>,
    );

    expect(screen.getByText('Only slide')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next slide' })).toBeDisabled();
  });
});
