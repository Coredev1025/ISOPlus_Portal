import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Skeleton } from '@/components/ui/skeleton';

describe('Skeleton', () => {
  it('renders a pulsing placeholder', () => {
    render(<Skeleton data-testid="ph" />);

    expect(screen.getByTestId('ph').className).toContain('animate-pulse');
  });

  it('keeps a caller class for sizing', () => {
    render(<Skeleton className="h-8 w-40" data-testid="ph" />);

    const classes = screen.getByTestId('ph').className.split(/\s+/);
    expect(classes).toContain('h-8');
    expect(classes).toContain('w-40');
    expect(classes).toContain('animate-pulse');
  });

  it('lets a caller override the conflicting background', () => {
    render(<Skeleton className="bg-slate-200" data-testid="ph" />);

    const classes = screen.getByTestId('ph').className.split(/\s+/);
    expect(classes).toContain('bg-slate-200');
    expect(classes).not.toContain('bg-muted');
  });

  it('passes native attributes through', () => {
    render(<Skeleton role="status" aria-label="Loading invoices" />);

    expect(screen.getByRole('status', { name: 'Loading invoices' })).toBeInTheDocument();
  });

  it('renders any children it is given', () => {
    render(<Skeleton data-testid="ph">placeholder text</Skeleton>);

    expect(screen.getByTestId('ph')).toHaveTextContent('placeholder text');
  });
});
