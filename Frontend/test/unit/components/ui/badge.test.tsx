import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge, badgeVariants } from '@/components/ui/badge';

/** Exact class-token membership; substring checks would also match `hover:bg-primary/80`. */
const tokens = (className: string) => className.split(/\s+/).filter(Boolean);

describe('Badge', () => {
  it('renders its children', () => {
    render(<Badge>Delivered</Badge>);

    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });

  it('passes native attributes through', () => {
    render(<Badge data-state="active" title="Sync state" />);

    expect(screen.getByTitle('Sync state')).toHaveAttribute('data-state', 'active');
  });

  it('keeps a caller class alongside the variant styling', () => {
    render(<Badge className="ml-2">Draft</Badge>);

    const className = screen.getByText('Draft').className;
    expect(className).toContain('ml-2');
    expect(className).toContain('bg-primary');
  });

  it('lets a caller class override the conflicting variant background', () => {
    render(<Badge className="bg-emerald-500">Paid</Badge>);

    const classes = tokens(screen.getByText('Paid').className);
    expect(classes).toContain('bg-emerald-500');
    // tailwind-merge drops the conflicting base background…
    expect(classes).not.toContain('bg-primary');
    // …but leaves the hover variant, which does not conflict with it.
    expect(classes).toContain('hover:bg-primary/80');
  });
});

describe('badgeVariants', () => {
  it('defaults to the primary variant', () => {
    expect(badgeVariants()).toContain('bg-primary');
  });

  it.each([
    ['secondary', 'bg-secondary'],
    ['destructive', 'bg-destructive'],
  ] as const)('gives the %s variant its own background', (variant, token) => {
    expect(badgeVariants({ variant })).toContain(token);
  });

  it('gives the outline variant no background at all', () => {
    const classes = badgeVariants({ variant: 'outline' });

    expect(classes).toContain('text-foreground');
    expect(classes).not.toContain('bg-primary');
    expect(classes).not.toContain('bg-secondary');
  });

  it('always applies the shared pill shape', () => {
    for (const variant of ['default', 'secondary', 'destructive', 'outline'] as const) {
      expect(badgeVariants({ variant })).toContain('rounded-full');
    }
  });
});
