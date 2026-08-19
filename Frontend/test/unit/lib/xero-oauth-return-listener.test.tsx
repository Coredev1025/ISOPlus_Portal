import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const searchParams = new URLSearchParams('xero=error&reason=oauth_failed');

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/dashboard',
  useSearchParams: () => searchParams,
}));

vi.mock('@/lib/toast-utils', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

import { XeroOAuthReturnBoundary } from '@/lib/xero-oauth-return-listener';
import { showErrorToast } from '@/lib/toast-utils';

describe('XeroOAuthReturnBoundary', () => {
  it('toasts a Xero OAuth error on the dashboard when workspace id is missing', () => {
    render(<XeroOAuthReturnBoundary />);
    expect(showErrorToast).toHaveBeenCalledWith(
      'Failed to connect to Xero',
      expect.objectContaining({
        description: expect.stringMatching(/could not complete the xero authentication/i),
      })
    );
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });
});
