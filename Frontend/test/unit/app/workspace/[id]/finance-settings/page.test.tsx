import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ContextProvider } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
} from '../../../page-test-utils';
import FinanceSettingsPage from '@/app/workspace/[id]/finance-settings/page';

/**
 * Pins the full-page Finance Settings layout: the heading stays on a padded
 * container, and the tab bar stays compact on the left instead of stretching
 * across the row.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/finance-settings';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/workspace-feature-toggles', () => ({
  fetchInvoiceStatementAutomationFlag: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/financial-settings-panel', () => ({
  FinancialSettingsPanel: () => <div>Financial panel</div>,
}));

vi.mock('@/lib/accounting-integrations-panel', () => ({
  AccountingIntegrationsPanel: () => <div>Accounting panel</div>,
}));

function renderPage() {
  return render(
    <ContextProvider>
      <FinanceSettingsPage />
    </ContextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.values(router).forEach((fn) => fn.mockClear());
  seedContextStorage(SUPPORT_ADMIN, [
    { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' },
  ]);
  stubChromeRequests(SUPPORT_ADMIN);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('finance settings page', () => {
  it('insets the page content instead of letting the heading sit flush to the edges', async () => {
    renderPage();

    const heading = await screen.findByRole('heading', {
      name: 'Finance Settings & Automation',
    });
    const pageContainer = heading.closest('.container');

    expect(pageContainer).toHaveClass(
      'mx-auto',
      'px-4',
      'py-8',
      'sm:px-6',
      'lg:px-8',
    );
  });

  it('keeps the finance tabs compact and left-aligned on the full-width page', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Financial panel')).toBeInTheDocument();
    });

    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveClass('w-fit', 'bg-muted');
    expect(tablist).not.toHaveClass('w-full');
    expect(tablist.parentElement).toHaveClass('flex', 'justify-start');
  });
});
