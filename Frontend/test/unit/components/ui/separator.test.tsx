import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { Separator } from '@/components/ui/separator';

describe('Separator', () => {
  it('is decorative by default, so it is hidden from the accessibility tree', () => {
    render(<Separator data-testid="sep" />);

    expect(screen.getByTestId('sep')).toHaveAttribute('role', 'none');
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('exposes the separator role when told it is not decorative', () => {
    render(<Separator decorative={false} />);

    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('defaults to a full-width horizontal rule', () => {
    render(<Separator data-testid="sep" />);

    const classes = screen.getByTestId('sep').className.split(/\s+/);
    expect(classes).toContain('h-[1px]');
    expect(classes).toContain('w-full');
  });

  it('switches to a full-height vertical rule', () => {
    render(<Separator orientation="vertical" data-testid="sep" />);

    const classes = screen.getByTestId('sep').className.split(/\s+/);
    expect(classes).toContain('h-full');
    expect(classes).toContain('w-[1px]');
    expect(classes).not.toContain('w-full');
  });

  it('reports its orientation for assistive technology when not decorative', () => {
    render(<Separator orientation="vertical" decorative={false} />);

    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('forwards a ref', () => {
    const ref = createRef<HTMLDivElement>();
    render(<Separator ref={ref} />);

    expect(ref.current).not.toBeNull();
  });

  it('keeps a caller class', () => {
    render(<Separator className="my-6" data-testid="sep" />);

    expect(screen.getByTestId('sep').className.split(/\s+/)).toContain('my-6');
  });
});
