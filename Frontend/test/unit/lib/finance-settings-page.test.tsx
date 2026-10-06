import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/financial-settings-panel', () => ({
  FinancialSettingsPanel: () => <div>Financial panel</div>,
}));

vi.mock('@/lib/accounting-integrations-panel', () => ({
  AccountingIntegrationsPanel: () => <div>Accounting panel</div>,
}));

// The automation panel loads its settings on mount. Left unmocked it would hit
// axios in jsdom, so this file stays about tab gating and nothing else.
vi.mock('@/lib/automation-settings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/automation-settings')>(
    '@/lib/automation-settings'
  );
  return {
    ...actual,
    fetchAutomationSettings: vi.fn(async () => ({
      invoice: structuredClone(actual.DEFAULT_BLOCK),
      statement: structuredClone(actual.DEFAULT_BLOCK),
    })),
    saveAutomationSettings: vi.fn(),
  };
});

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

  it('shows the automation panel when enabled and selected', async () => {
    const { onTabChange } = renderTabs({
      activeTab: 'automation',
      automationEnabled: true,
    });

    expect(
      screen.getByRole('tab', { name: /invoice & statement automation/i })
    ).toBeInTheDocument();
    // The placeholder heading and its copy were deleted with the placeholder;
    // the real panel renders an invoice section and a statement section.
    expect(
      await screen.findByRole('heading', { name: 'Invoice Automation' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Statement Automation' })
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('tab', { name: /accounting integrations/i })
    );
    expect(onTabChange).toHaveBeenCalledWith('accounting');
  });
});
