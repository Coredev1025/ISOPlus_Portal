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

describe('FinanceSettingsTabs', () => {
  afterEach(() => {
    cleanup();
  });

  it('hides the automation tab when the workspace flag is off', () => {
    render(
      <FinanceSettingsTabs
        workspaceId="ws-1"
        activeTab="financial"
        automationEnabled={false}
        onTabChange={vi.fn()}
      />
    );

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
    const onTabChange = vi.fn();
    render(
      <FinanceSettingsTabs
        workspaceId="ws-1"
        activeTab="automation"
        automationEnabled
        onTabChange={onTabChange}
      />
    );

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
