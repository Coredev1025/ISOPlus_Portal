import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

describe('Alert', () => {
  it('exposes the alert role so screen readers announce it', () => {
    render(<Alert>Sync failed</Alert>);

    expect(screen.getByRole('alert')).toHaveTextContent('Sync failed');
  });

  it('forwards a ref to the alert element', () => {
    const ref = createRef<HTMLDivElement>();
    render(<Alert ref={ref}>Sync failed</Alert>);

    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it('styles the destructive variant differently from the default', () => {
    const { rerender } = render(<Alert>Notice</Alert>);
    const defaultClass = screen.getByRole('alert').className;

    rerender(<Alert variant="destructive">Notice</Alert>);
    const destructiveClass = screen.getByRole('alert').className;

    expect(defaultClass).toContain('text-foreground');
    expect(destructiveClass).toContain('text-destructive');
    expect(destructiveClass).not.toBe(defaultClass);
  });

  it('keeps a caller class alongside the variant styling', () => {
    render(<Alert className="mt-4">Notice</Alert>);

    expect(screen.getByRole('alert').className).toContain('mt-4');
  });
});

describe('AlertTitle', () => {
  it('renders as a heading so the alert has a title in the accessibility tree', () => {
    render(
      <Alert>
        <AlertTitle>Xero rejected the invoice</AlertTitle>
      </Alert>,
    );

    expect(screen.getByRole('heading', { name: 'Xero rejected the invoice' }))
      .toBeInTheDocument();
  });

  it('forwards a ref', () => {
    const ref = createRef<HTMLParagraphElement>();
    render(<AlertTitle ref={ref}>Title</AlertTitle>);

    expect(ref.current).not.toBeNull();
  });
});

describe('AlertDescription', () => {
  it('renders its children inside the alert', () => {
    render(
      <Alert>
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>Contact is missing an account code.</AlertDescription>
      </Alert>,
    );

    expect(screen.getByRole('alert'))
      .toHaveTextContent('Contact is missing an account code.');
  });

  it('is not itself a heading, so the alert has exactly one title', () => {
    render(
      <Alert>
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>Details</AlertDescription>
      </Alert>,
    );

    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });
});
