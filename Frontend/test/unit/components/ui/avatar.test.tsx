import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

/**
 * Radix only swaps the image in once it has loaded, and jsdom never loads one,
 * so the fallback is what renders here. That is exactly the behaviour worth
 * pinning: a user whose avatar fails to load must still see their initials.
 */

describe('Avatar', () => {
  it('shows the fallback while the image has not loaded', () => {
    render(
      <Avatar>
        <AvatarImage src="https://cdn.example.com/dana.png" alt="Dana Reid" />
        <AvatarFallback>DR</AvatarFallback>
      </Avatar>,
    );

    expect(screen.getByText('DR')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Dana Reid' })).not.toBeInTheDocument();
  });

  it('shows the fallback when there is no image at all', () => {
    render(
      <Avatar>
        <AvatarFallback>DR</AvatarFallback>
      </Avatar>,
    );

    expect(screen.getByText('DR')).toBeInTheDocument();
  });

  it('renders nothing visible when there is neither image nor fallback', () => {
    render(<Avatar data-testid="avatar" />);

    expect(screen.getByTestId('avatar')).toBeEmptyDOMElement();
  });

  it('keeps a caller class on the root', () => {
    render(
      <Avatar className="h-16 w-16" data-testid="avatar">
        <AvatarFallback>DR</AvatarFallback>
      </Avatar>,
    );

    const classes = screen.getByTestId('avatar').className.split(/\s+/);
    expect(classes).toContain('h-16');
    expect(classes).toContain('w-16');
  });

  it('lets a caller override the conflicting default size', () => {
    render(
      <Avatar className="h-16" data-testid="avatar">
        <AvatarFallback>DR</AvatarFallback>
      </Avatar>,
    );

    const classes = screen.getByTestId('avatar').className.split(/\s+/);
    expect(classes).toContain('h-16');
    expect(classes).not.toContain('h-10');
  });

  it('keeps a caller class on the fallback', () => {
    render(
      <Avatar>
        <AvatarFallback className="text-xs">DR</AvatarFallback>
      </Avatar>,
    );

    expect(screen.getByText('DR').className.split(/\s+/)).toContain('text-xs');
  });
});
