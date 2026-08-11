import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';

function renderHoverCard(props: Record<string, unknown> = {}) {
  return render(
    <HoverCard openDelay={0} closeDelay={0} {...props}>
      <HoverCardTrigger>Dana Reid</HoverCardTrigger>
      <HoverCardContent>My Aged Care ID 12345</HoverCardContent>
    </HoverCard>,
  );
}

describe('HoverCard', () => {
  it('renders the trigger but not the card', () => {
    renderHoverCard();

    expect(screen.getByText('Dana Reid')).toBeInTheDocument();
    expect(screen.queryByText('My Aged Care ID 12345')).not.toBeInTheDocument();
  });

  it('shows the card when opened programmatically', () => {
    renderHoverCard({ open: true });

    expect(screen.getByText('My Aged Care ID 12345')).toBeInTheDocument();
  });

  it('hides the card when explicitly closed', () => {
    renderHoverCard({ open: false });

    expect(screen.queryByText('My Aged Care ID 12345')).not.toBeInTheDocument();
  });

  it('keeps a caller class on the content', () => {
    render(
      <HoverCard open>
        <HoverCardTrigger>Dana Reid</HoverCardTrigger>
        <HoverCardContent className="w-96">Details</HoverCardContent>
      </HoverCard>,
    );

    expect(screen.getByText('Details').className.split(/\s+/)).toContain('w-96');
  });

  it('lets a caller override the default width', () => {
    render(
      <HoverCard open>
        <HoverCardTrigger>Dana Reid</HoverCardTrigger>
        <HoverCardContent className="w-96">Details</HoverCardContent>
      </HoverCard>,
    );

    const classes = screen.getByText('Details').className.split(/\s+/);
    expect(classes).toContain('w-96');
    expect(classes).not.toContain('w-64');
  });
});
