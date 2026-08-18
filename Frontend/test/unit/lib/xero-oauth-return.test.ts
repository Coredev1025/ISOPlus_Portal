import { describe, expect, it, vi } from 'vitest';
import {
  applyXeroOAuthReturn,
  parseXeroOAuthReturn,
  stripXeroOAuthSearchParams,
} from '@/lib/xero-oauth-return';

describe('xero-oauth-return', () => {
  it('parses a successful redirect return from Xero', () => {
    expect(parseXeroOAuthReturn(new URLSearchParams('tab=accounting&xero=success'))).toEqual({
      kind: 'success',
      title: 'Successfully connected to Xero!',
    });
  });

  it('parses a failed redirect return with a generic description for unknown reasons', () => {
    expect(
      parseXeroOAuthReturn(
        new URLSearchParams('tab=accounting&xero=error&reason=The+request+timed+out')
      )
    ).toEqual({
      kind: 'error',
      title: 'Failed to connect to Xero',
      description: 'Could not complete the Xero authentication. Please try again.',
    });
  });

  it('ignores unrelated search params', () => {
    expect(parseXeroOAuthReturn(new URLSearchParams('tab=accounting'))).toBeNull();
  });

  it('strips xero return params while keeping the accounting tab', () => {
    expect(
      stripXeroOAuthSearchParams(
        new URLSearchParams('tab=accounting&xero=success&reason=unused')
      )
    ).toBe('?tab=accounting');
  });

  it('maps allow-listed OAuth error reasons instead of echoing raw query text', () => {
    expect(
      parseXeroOAuthReturn(
        new URLSearchParams('tab=accounting&xero=error&reason=authentication_required')
      )
    ).toEqual({
      kind: 'error',
      title: 'Failed to connect to Xero',
      description: 'The Xero connection could not be verified. Click Connect Xero again while you are signed in. If this keeps happening, allow cookies for this site or try another browser.',
    });
    expect(
      parseXeroOAuthReturn(
        new URLSearchParams('tab=accounting&xero=error&reason=<script>alert(1)</script>')
      )
    ).toEqual({
      kind: 'error',
      title: 'Failed to connect to Xero',
      description: 'Could not complete the Xero authentication. Please try again.',
    });
  });

  it('applyXeroOAuthReturn toasts a failed return and replaces the URL', () => {
    const showErrorToast = vi.fn();
    const replace = vi.fn();
    expect(
      applyXeroOAuthReturn(
        new URLSearchParams('tab=accounting&xero=error&reason=no_organisation'),
        {
          showSuccessToast: vi.fn(),
          showErrorToast,
          replace,
          pathname: '/workspace/ws-1/finance-settings',
        }
      )
    ).toBe(true);
    expect(showErrorToast).toHaveBeenCalledWith('Failed to connect to Xero', {
      description: 'No Xero organisation was selected. Please try again and choose an organisation.',
    });
    expect(replace).toHaveBeenCalledWith(
      '/workspace/ws-1/finance-settings?tab=accounting'
    );
  });

  it('applyXeroOAuthReturn toasts a successful return and replaces the URL', () => {
    const showSuccessToast = vi.fn();
    const replace = vi.fn();
    expect(
      applyXeroOAuthReturn(new URLSearchParams('tab=accounting&xero=success'), {
        showSuccessToast,
        showErrorToast: vi.fn(),
        replace,
        pathname: '/workspace/ws-1/finance-settings',
      })
    ).toBe(true);
    expect(showSuccessToast).toHaveBeenCalledWith('Successfully connected to Xero!');
    expect(replace).toHaveBeenCalledWith(
      '/workspace/ws-1/finance-settings?tab=accounting'
    );
  });
});
