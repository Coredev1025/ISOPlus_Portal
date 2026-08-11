import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/toast-utils', () => ({
  showFetchErrorToast: vi.fn(),
  showSaveErrorToast: vi.fn(),
  showSaveSuccessToast: vi.fn(),
}));

vi.mock('@/lib/workspace-feature-toggles', () => ({
  fetchWorkspaceFeatureToggles: vi.fn(),
  saveWorkspaceFeatureToggles: vi.fn(),
}));

import { WorkspaceFeatureTogglesCard } from '@/lib/workspace-feature-toggles-card';
import {
  fetchWorkspaceFeatureToggles,
  saveWorkspaceFeatureToggles,
} from '@/lib/workspace-feature-toggles';
import {
  showFetchErrorToast,
  showSaveErrorToast,
  showSaveSuccessToast,
} from '@/lib/toast-utils';

describe('WorkspaceFeatureTogglesCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('loads the toggle and saves changes', async () => {
    const user = userEvent.setup();
    (fetchWorkspaceFeatureToggles as ReturnType<typeof vi.fn>).mockResolvedValue({
      invoiceStatementAutomation: false,
    });
    (saveWorkspaceFeatureToggles as ReturnType<typeof vi.fn>).mockResolvedValue({
      invoiceStatementAutomation: true,
    });

    render(<WorkspaceFeatureTogglesCard workspaceId="ws-1" />);

    const toggle = await screen.findByRole('switch', {
      name: /enable invoice and statement automation/i,
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(saveWorkspaceFeatureToggles).toHaveBeenCalledWith('ws-1', true);
      expect(showSaveSuccessToast).toHaveBeenCalledWith('Feature toggles');
    });
  });

  it('toasts when load fails', async () => {
    (fetchWorkspaceFeatureToggles as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { data: { message: 'no access' } },
    });

    render(<WorkspaceFeatureTogglesCard workspaceId="ws-1" />);

    await waitFor(() => {
      expect(showFetchErrorToast).toHaveBeenCalledWith('feature toggles', 'no access');
    });
  });

  it('toasts when save fails', async () => {
    const user = userEvent.setup();
    (fetchWorkspaceFeatureToggles as ReturnType<typeof vi.fn>).mockResolvedValue({
      invoiceStatementAutomation: true,
    });
    (saveWorkspaceFeatureToggles as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { data: { message: 'write failed' } },
    });

    render(<WorkspaceFeatureTogglesCard workspaceId="ws-1" />);
    await screen.findByRole('switch', {
      name: /enable invoice and statement automation/i,
    });

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(showSaveErrorToast).toHaveBeenCalledWith('feature toggles', 'write failed');
    });
  });
});
