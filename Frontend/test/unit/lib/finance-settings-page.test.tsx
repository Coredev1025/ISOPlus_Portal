import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/financial-settings-panel', () => ({
  FinancialSettingsPanel: () => <div>Financial panel</div>,
}));

vi.mock('@/lib/accounting-integrations-panel', () => ({
  AccountingIntegrationsPanel: () => <div>Accounting panel</div>,
}));

import { FinanceSettingsTabs } from '@/lib/finance-settings-page';

function renderTabs(
  overrides: Partial<{
    activeTab: 'financial' | 'accounting' | 'automation';
    automationEnabled: boolean;
    onTabChange: ReturnType<typeof vi.fn>;
  }> = {}
) {
  const onTabChange = overrides.onTabChange ?? vi.fn();
  return {
    onTabChange,
    ...render(
      <FinanceSettingsTabs
        workspaceId="ws-1"
        activeTab={overrides.activeTab ?? 'financial'}
        automationEnabled={overrides.automationEnabled ?? false}
        onTabChange={onTabChange}
      />
    ),
  };
}

describe('FinanceSettingsTabs', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps the tab bar compact and left-aligned instead of stretching across the page', () => {
    renderTabs();

    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveClass('w-fit', 'bg-muted');
    expect(tablist).not.toHaveClass('w-full');
    expect(tablist.parentElement).toHaveClass('mb-6', 'flex', 'justify-start');
  });

  it('hides the automation tab when the workspace flag is off', () => {
    renderTabs();

    expect(screen.getByRole('tab', { name: /financial settings/i })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /accounting integrations/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /invoice & statement automation/i })
    ).not.toBeInTheDocument();
    expect(screen.getByText('Financial panel')).toBeInTheDocument();
  });

  it('shows the automation placeholder when enabled and selected', async () => {
    const { onTabChange } = renderTabs({
      activeTab: 'automation',
      automationEnabled: true,
    });

    expect(
      screen.getByRole('tab', { name: /invoice & statement automation/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /invoice & statement automation/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/automation schedule and email settings will be built/i)
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('tab', { name: /accounting integrations/i })
    );
    expect(onTabChange).toHaveBeenCalledWith('accounting');
  });
});
