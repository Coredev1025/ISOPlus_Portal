import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { ThemeProvider } from '@/components/theme-provider';

// jsdom ships no matchMedia; next-themes reads it on mount.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
}

function renderToggle(providerProps: Record<string, unknown> = {}) {
  return render(
    <ThemeProvider attribute="class" enableSystem={false} {...providerProps}>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

function rootClasses() {
  return document.documentElement.className.split(/\s+/).filter(Boolean);
}

afterEach(() => {
  document.documentElement.className = '';
  window.localStorage.clear();
});

describe('ThemeToggle', () => {
  it('renders a labelled toggle button once mounted', () => {
    renderToggle();

    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument();
  });

  it('omits the label on the server render, so hydration cannot mismatch', () => {
    const markup = renderToStaticMarkup(<ThemeToggle />);

    expect(markup).not.toContain('Toggle theme');
    expect(markup).toContain('<button');
  });

  it('switches the document to dark when toggled from light', async () => {
    const user = userEvent.setup();
    renderToggle({ defaultTheme: 'light' });

    expect(rootClasses()).toContain('light');

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));

    expect(rootClasses()).toContain('dark');
    expect(rootClasses()).not.toContain('light');
  });

  it('switches back to light when toggled from dark', async () => {
    const user = userEvent.setup();
    renderToggle({ defaultTheme: 'dark' });

    expect(rootClasses()).toContain('dark');

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));

    expect(rootClasses()).toContain('light');
    expect(rootClasses()).not.toContain('dark');
  });

  it('alternates on repeated clicks rather than sticking on one theme', async () => {
    const user = userEvent.setup();
    renderToggle({ defaultTheme: 'light' });
    const button = screen.getByRole('button', { name: 'Toggle theme' });

    await user.click(button);
    await user.click(button);

    expect(rootClasses()).toContain('light');
  });

  it('persists the chosen theme for the next visit', async () => {
    const user = userEvent.setup();
    renderToggle({ defaultTheme: 'light', storageKey: 'theme' });

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));

    expect(window.localStorage.getItem('theme')).toBe('dark');
  });

  it('treats a non-light starting theme as "go to light"', async () => {
    const user = userEvent.setup();
    renderToggle({ defaultTheme: 'system', enableSystem: true });

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));

    expect(rootClasses()).toContain('light');
  });

  it('renders both the sun and the moon glyph so CSS can cross-fade them', () => {
    const { container } = renderToggle();

    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });
});
