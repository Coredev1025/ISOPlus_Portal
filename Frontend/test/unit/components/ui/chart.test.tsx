import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ChartContainer,
  ChartStyle,
  ChartTooltipContent,
  ChartLegendContent,
} from '@/components/ui/chart';

/**
 * chart.tsx is a thin layer over Recharts. Recharts measures the DOM and jsdom
 * reports every element as zero-sized, so an actual plot never renders — the
 * container's children are legitimately unobservable here, and that is called
 * out below rather than papered over.
 *
 * What IS this file's own contract, and what these tests cover: the CSS
 * custom properties ChartStyle emits per theme, the tooltip and legend content
 * renderers, the label/value/name resolution rules they apply, and the guard
 * that useChart (via ChartTooltipContent) must sit inside a ChartContainer.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

const config = {
  delivered: { label: 'Delivered', color: '#22c55e' },
  planned: { label: 'Planned', color: '#3b82f6' },
} as const;

/** The <style> text ChartStyle produces for a given config. */
function styleText(id: string, cfg: Record<string, unknown>) {
  const { container } = render(<ChartStyle id={id} config={cfg as never} />);
  return container.querySelector('style')?.innerHTML ?? '';
}

describe('ChartStyle', () => {
  it('renders nothing when no series declares a colour', () => {
    const { container } = render(
      <ChartStyle id="c1" config={{ delivered: { label: 'Delivered' } } as never} />,
    );

    expect(container.querySelector('style')).toBeNull();
  });

  it('emits a CSS variable per coloured series', () => {
    const css = styleText('c1', config);

    expect(css).toContain('--color-delivered: #22c55e;');
    expect(css).toContain('--color-planned: #3b82f6;');
  });

  it('scopes the variables to the chart id', () => {
    const css = styleText('my-chart', config);

    expect(css).toContain('[data-chart=my-chart]');
  });

  it('emits a block for both the light and dark themes', () => {
    const css = styleText('c1', config);

    expect(css).toContain('.dark');
    // The light block is unprefixed, so there are two [data-chart=...] blocks.
    expect(css.match(/\[data-chart=c1\]/g)).toHaveLength(2);
  });

  it('prefers a per-theme colour over the flat colour', () => {
    const css = styleText('c1', {
      delivered: { label: 'Delivered', theme: { light: '#111111', dark: '#eeeeee' } },
    });

    expect(css).toContain('#111111');
    expect(css).toContain('#eeeeee');
  });

  it('skips a series that declares neither colour nor theme', () => {
    const css = styleText('c1', {
      delivered: { label: 'Delivered', color: '#22c55e' },
      unstyled: { label: 'Unstyled' },
    });

    expect(css).toContain('--color-delivered');
    expect(css).not.toContain('--color-unstyled');
  });
});

describe('ChartContainer', () => {
  it('stamps the chart id onto the container for the CSS variables to target', () => {
    const { container } = render(
      <ChartContainer id="my-chart" config={config as never}>
        <div />
      </ChartContainer>,
    );

    expect(container.querySelector('[data-chart="chart-my-chart"]')).not.toBeNull();
  });

  it('emits the style block alongside the chart', () => {
    const { container } = render(
      <ChartContainer id="my-chart" config={config as never}>
        <div />
      </ChartContainer>,
    );

    expect(container.querySelector('style')?.innerHTML).toContain('--color-delivered');
  });

  it('keeps a caller class on the container', () => {
    const { container } = render(
      <ChartContainer id="c" config={config as never} className="h-64">
        <div />
      </ChartContainer>,
    );

    const el = container.querySelector('[data-chart]') as HTMLElement;
    expect(el.className.split(/\s+/)).toContain('h-64');
  });
});

describe('ChartTooltipContent', () => {
  function renderTooltip(props: Record<string, unknown>) {
    return render(
      <ChartContainer id="c" config={config as never}>
        <ChartTooltipContent {...(props as never)} />
      </ChartContainer>,
    );
  }

  const payload = [
    { dataKey: 'delivered', name: 'delivered', value: 120.5, color: '#22c55e', payload: {} },
  ];

  it('renders nothing while inactive', () => {
    const { container } = renderTooltip({ active: false, payload });

    expect(container.textContent).not.toContain('120.5');
  });

  it('renders nothing for an empty payload', () => {
    // The container always emits its <style> block, so assert on the absence of
    // tooltip rows rather than on empty text.
    renderTooltip({ active: true, payload: [] });

    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('renders the series label from the config, not the raw key', () => {
    renderTooltip({ active: true, payload });

    // With no explicit tooltip label the config label is used for both the
    // heading row and the item row, so it appears more than once.
    expect(screen.getAllByText('Delivered').length).toBeGreaterThan(0);
    expect(screen.queryByText('delivered')).not.toBeInTheDocument();
  });

  it('renders the value', () => {
    renderTooltip({ active: true, payload });

    expect(screen.getByText('120.5')).toBeInTheDocument();
  });

  it('renders the tooltip label when one is supplied', () => {
    renderTooltip({ active: true, payload, label: 'August' });

    expect(screen.getByText('August')).toBeInTheDocument();
  });

  it('hides the label when told to', () => {
    const { container } = renderTooltip({ active: true, payload, label: 'August', hideLabel: true });

    expect(container.textContent).not.toContain('August');
  });

  it('applies a caller formatter to the value', () => {
    renderTooltip({
      active: true,
      payload,
      formatter: (value: number) => `$${value.toFixed(2)}`,
    });

    expect(screen.getByText('$120.50')).toBeInTheDocument();
  });

  it('renders one row per series', () => {
    renderTooltip({
      active: true,
      payload: [
        ...payload,
        { dataKey: 'planned', name: 'planned', value: 80, color: '#3b82f6', payload: {} },
      ],
    });

    expect(screen.getAllByText('Delivered').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Planned').length).toBeGreaterThan(0);
  });

  it('throws when used outside a ChartContainer', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      render(<ChartTooltipContent active payload={payload as never} />),
    ).toThrow(/useChart must be used within a <ChartContainer \/>/);

    spy.mockRestore();
  });
});

describe('ChartLegendContent', () => {
  const payload = [
    { dataKey: 'delivered', value: 'delivered', color: '#22c55e' },
    { dataKey: 'planned', value: 'planned', color: '#3b82f6' },
  ];

  it('renders nothing for an empty payload', () => {
    render(
      <ChartContainer id="c" config={config as never}>
        <ChartLegendContent payload={[] as never} />
      </ChartContainer>,
    );

    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('renders the configured label for each series', () => {
    render(
      <ChartContainer id="c" config={config as never}>
        <ChartLegendContent payload={payload as never} />
      </ChartContainer>,
    );

    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.getByText('Planned')).toBeInTheDocument();
  });
});
