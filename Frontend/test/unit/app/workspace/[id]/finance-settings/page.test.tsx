import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextProvider } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
} from '../../../page-test-utils';
import FinanceSettingsPage from '@/app/workspace/[id]/finance-settings/page';

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/finance-settings';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/workspace-feature-toggles', () => ({
  // Tri-state since the tab gate had to tell "the workspace does not have the
  // feature" apart from "the profile call did not answer".
  fetchInvoiceStatementAutomationFlag: vi.fn().mockResolvedValue('off'),
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
  it('renders the Finance Settings & Automation heading and financial tab', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', {
        name: 'Finance Settings & Automation',
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('tab', { name: 'Financial Settings' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Financial panel')).toBeInTheDocument();
  });
});
