import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  installBrowserStubs,
  makeRouter,
} from '../../../page-test-utils';
import XeroIntegrationRedirectPage from '@/app/workspace/[id]/xero-integration/page';

/**
 * Epic 1 (KAN-6): the old Xero Integration route is a redirect shell into
 * Finance Settings → Accounting Integrations. Connect / Disconnect coverage
 * lives with the accounting panel, not this page.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/xero-integration';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

describe('Xero integration page (Epic 1 redirect)', () => {
  beforeEach(() => {
    router.replace.mockClear();
    router.push.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows a redirecting status while navigating away', () => {
    render(<XeroIntegrationRedirectPage />);

    expect(screen.getByText(/Redirecting to Finance Settings/i)).toBeInTheDocument();
  });

  it('replaces the route with finance-settings accounting tab for this workspace', async () => {
    render(<XeroIntegrationRedirectPage />);

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        '/workspace/ws-1/finance-settings?tab=accounting',
      );
    });
  });
});
