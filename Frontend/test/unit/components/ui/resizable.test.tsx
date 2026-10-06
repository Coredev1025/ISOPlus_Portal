import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';

// react-resizable-panels measures the DOM on mount; jsdom has no layout engine.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

function renderGroup(props: Record<string, unknown> = {}, handleProps: Record<string, unknown> = {}) {
  return render(
    <ResizablePanelGroup direction="horizontal" {...props}>
      <ResizablePanel defaultSize={50}>Left pane</ResizablePanel>
      <ResizableHandle {...handleProps} />
      <ResizablePanel defaultSize={50}>Right pane</ResizablePanel>
    </ResizablePanelGroup>,
  );
}

describe('ResizablePanelGroup', () => {
  it('renders the content of every panel', () => {
    renderGroup();

    expect(screen.getByText('Left pane')).toBeInTheDocument();
    expect(screen.getByText('Right pane')).toBeInTheDocument();
  });

  it('records the direction it was given, which drives the layout classes', () => {
    const { container } = renderGroup();

    expect(container.querySelector('[data-panel-group-direction="horizontal"]'))
      .not.toBeNull();
  });

  it('switches to the vertical direction when asked', () => {
    const { container } = renderGroup({ direction: 'vertical' });

    expect(container.querySelector('[data-panel-group-direction="vertical"]'))
      .not.toBeNull();
  });

  it('always applies the flex layout the vertical modifier keys off', () => {
    const { container } = renderGroup();

    const group = container.querySelector('[data-panel-group]') as HTMLElement;
    expect(group.className.split(/\s+/)).toContain('flex');
  });

  it('keeps a caller class on the group', () => {
    const { container } = renderGroup({ className: 'rounded-lg' });

    const group = container.querySelector('[data-panel-group]') as HTMLElement;
    expect(group.className.split(/\s+/)).toContain('rounded-lg');
  });
});

describe('ResizableHandle', () => {
  it('exposes a separator so the divider is reachable by assistive technology', () => {
    renderGroup();

    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('is keyboard focusable, so the panes can be resized without a mouse', () => {
    renderGroup();

    expect(screen.getByRole('separator')).toHaveAttribute('tabindex', '0');
  });

  it('renders no grip by default', () => {
    const { container } = renderGroup();

    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a grip when withHandle is set', () => {
    const { container } = renderGroup({}, { withHandle: true });

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('keeps a caller class on the handle', () => {
    renderGroup({}, { className: 'bg-primary' });

    expect(screen.getByRole('separator').className.split(/\s+/)).toContain('bg-primary');
  });

  it('does not forward withHandle to the DOM as an attribute', () => {
    renderGroup({}, { withHandle: true });

    expect(screen.getByRole('separator')).not.toHaveAttribute('withhandle');
  });
});
