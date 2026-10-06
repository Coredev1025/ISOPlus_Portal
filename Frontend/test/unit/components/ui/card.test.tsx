import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';

describe('Card composition', () => {
  it('renders every slot in order inside one card', () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Monthly statement</CardTitle>
          <CardDescription>August 2026</CardDescription>
        </CardHeader>
        <CardContent>12 services delivered</CardContent>
        <CardFooter>Generated 10 Aug</CardFooter>
      </Card>,
    );

    const card = screen.getByTestId('card');
    expect(card).toHaveTextContent('Monthly statement');
    expect(card).toHaveTextContent('August 2026');
    expect(card).toHaveTextContent('12 services delivered');
    expect(card).toHaveTextContent('Generated 10 Aug');
  });

  it('renders the title as a heading so the card is navigable', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Monthly statement</CardTitle>
        </CardHeader>
      </Card>,
    );

    expect(screen.getByRole('heading', { name: 'Monthly statement' })).toBeInTheDocument();
  });

  it('renders the description as a paragraph, not a heading', () => {
    render(<CardDescription>August 2026</CardDescription>);

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('August 2026').tagName).toBe('P');
  });
});

describe('Card slots', () => {
  it.each([
    ['Card', Card],
    ['CardHeader', CardHeader],
    ['CardContent', CardContent],
    ['CardFooter', CardFooter],
    ['CardTitle', CardTitle],
    ['CardDescription', CardDescription],
  ] as const)('%s forwards a ref', (_name, Component) => {
    const ref = createRef<HTMLElement>();
    render(<Component ref={ref as never}>content</Component>);

    expect(ref.current).not.toBeNull();
  });

  it.each([
    ['Card', Card],
    ['CardHeader', CardHeader],
    ['CardContent', CardContent],
    ['CardFooter', CardFooter],
  ] as const)('%s keeps a caller class', (_name, Component) => {
    render(<Component className="custom-slot" data-testid="slot" />);

    expect(screen.getByTestId('slot').className.split(/\s+/)).toContain('custom-slot');
  });

  it('lets a caller override the card padding on the content slot', () => {
    render(<CardContent className="p-0" data-testid="content" />);

    const classes = screen.getByTestId('content').className.split(/\s+/);
    expect(classes).toContain('p-0');
    expect(classes).not.toContain('p-6');
  });
});
