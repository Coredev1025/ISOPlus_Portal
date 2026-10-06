import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AspectRatio } from '@/components/ui/aspect-ratio';

describe('AspectRatio', () => {
  it('renders its children', () => {
    render(
      <AspectRatio ratio={16 / 9}>
        <span>Board preview</span>
      </AspectRatio>,
    );

    expect(screen.getByText('Board preview')).toBeInTheDocument();
  });

  it('reserves space using padding-bottom derived from the ratio', () => {
    const { container } = render(
      <AspectRatio ratio={16 / 9} data-testid="ar">
        <span>preview</span>
      </AspectRatio>,
    );

    // 9/16 = 56.25%
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.paddingBottom).toBe('56.25%');
  });

  it('reserves half the width for a 2:1 ratio', () => {
    const { container } = render(
      <AspectRatio ratio={2}>
        <span>preview</span>
      </AspectRatio>,
    );

    expect((container.firstElementChild as HTMLElement).style.paddingBottom).toBe('50%');
  });

  it('reserves a square for a 1:1 ratio', () => {
    const { container } = render(
      <AspectRatio ratio={1}>
        <span>preview</span>
      </AspectRatio>,
    );

    expect((container.firstElementChild as HTMLElement).style.paddingBottom).toBe('100%');
  });

  it('passes attributes through to the inner element', () => {
    render(
      <AspectRatio ratio={1} aria-label="Board preview">
        <span>preview</span>
      </AspectRatio>,
    );

    expect(screen.getByLabelText('Board preview')).toBeInTheDocument();
  });
});
