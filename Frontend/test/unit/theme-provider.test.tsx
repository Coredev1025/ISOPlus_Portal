import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@/components/theme-provider';

vi.mock('next-themes', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="next-themes">{children}</div>
  ),
}));

describe('ThemeProvider', () => {
  it('renders children and mounts next-themes provider', async () => {
    render(
      <ThemeProvider attribute="class">
        <span>child</span>
      </ThemeProvider>
    );
    expect(screen.getByText('child')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('next-themes')).toBeInTheDocument();
    });
  });
});
