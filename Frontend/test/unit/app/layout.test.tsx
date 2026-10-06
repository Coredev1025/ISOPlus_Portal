import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useTheme } from 'next-themes';
import RootLayout, { metadata } from '@/app/layout';
import { useAppContext } from '@/app/context';
import { installBrowserStubs, seedContextStorage, SUPPORT_ADMIN } from './page-test-utils';

/**
 * The root layout is a server component that renders <html>/<body> and wraps
 * everything in the two client providers. What is testable in jsdom is the
 * part that matters to every page below it: children render, and both
 * providers are genuinely in effect (a child may call useAppContext() and
 * useTheme() without falling back to a default).
 *
 * NOT testable here, deliberately:
 *  - the <html>/<body> elements themselves. React re-parents them under the
 *    RTL container div and warns about invalid DOM nesting; only Next's own
 *    document rendering puts them at the root.
 *  - `metadata` being turned into <title>/<meta> tags. Next does that during
 *    RSC rendering; the export's value is asserted directly instead.
 */

installBrowserStubs();

/** Reads the app context. Throws if ContextProvider is not an ancestor. */
function ContextProbe() {
  const { user } = useAppContext();
  return <div data-testid="ctx-role">{user.role}</div>;
}

/**
 * next-themes' useTheme returns an empty context when no provider is above it,
 * so 'no-theme-provider' is what a missing ThemeProvider would show.
 */
function ThemeProbe() {
  const { theme } = useTheme();
  return <div data-testid="theme">{theme ?? 'no-theme-provider'}</div>;
}

beforeEach(() => {
  localStorage.clear();
  // React warns that <html> cannot be nested in the RTL container <div>.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.className = '';
});

describe('RootLayout', () => {
  it('renders the page it wraps', () => {
    render(
      <RootLayout>
        <p>Dashboard content</p>
      </RootLayout>,
    );

    expect(screen.getByText('Dashboard content')).toBeInTheDocument();
  });

  it('mounts the app ContextProvider, so a child may read the context', () => {
    render(
      <RootLayout>
        <ContextProbe />
      </RootLayout>,
    );

    // The provider's own initial user role, from app/context/index.tsx.
    expect(screen.getByTestId('ctx-role')).toHaveTextContent('isoplus_user');
  });

  it('mounts the real ContextProvider, which hydrates the signed-in user from localStorage', async () => {
    seedContextStorage(SUPPORT_ADMIN, []);

    render(
      <RootLayout>
        <ContextProbe />
      </RootLayout>,
    );

    expect(await screen.findByTestId('ctx-role')).toHaveTextContent('support_admin');
  });

  it('mounts the theme provider with light as the default theme', async () => {
    render(
      <RootLayout>
        <ThemeProbe />
      </RootLayout>,
    );

    expect(await screen.findByTestId('theme')).toHaveTextContent('light');
  });

  it('names the browser tab and describes the product', () => {
    expect(metadata.title).toBe('ISO+ Portal');
    expect(metadata.description).toBe(
      'Portal for ISO+ services and workspace management',
    );
  });
});
