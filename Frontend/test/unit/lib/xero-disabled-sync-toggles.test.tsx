import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { XeroDisabledSyncToggles } from '@/lib/xero-disabled-sync-toggles';

describe('XeroDisabledSyncToggles', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders coming-soon sync toggles as disabled switches', () => {
    render(<XeroDisabledSyncToggles />);

    expect(screen.getByText('Invoice Sync Status')).toBeInTheDocument();
    expect(screen.getByText('Customer Sync Status')).toBeInTheDocument();
    expect(screen.getByText('Payment Sync Status')).toBeInTheDocument();
    expect(screen.getByText('Contact Sync')).toBeInTheDocument();
    expect(screen.getByText('(optional)')).toBeInTheDocument();

    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(4);
    for (const toggle of switches) {
      expect(toggle).toBeDisabled();
      expect(toggle).not.toBeChecked();
    }
  });
});
