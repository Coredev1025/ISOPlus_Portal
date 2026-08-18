import {
  XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
  XERO_OAUTH_REASON_INVALID_STATE,
  XERO_OAUTH_REASON_MISSING_CODE,
  XERO_OAUTH_REASON_NO_ORGANISATION,
  XERO_OAUTH_REASON_OAUTH_FAILED,
  XERO_OAUTH_REASON_SAVE_FAILED,
} from '@/constants/xeroOAuth';

export type XeroOAuthReturn =
  | { kind: 'success'; title: string }
  | { kind: 'error'; title: string; description: string };

const DEFAULT_ERROR_DESCRIPTION =
  'Could not complete the Xero authentication. Please try again.';

const OAUTH_REASON_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED]:
    'The Xero connection could not be verified. Click Connect Xero again while you are signed in. If this keeps happening, allow cookies for this site or try another browser.',
  [XERO_OAUTH_REASON_INVALID_STATE]: DEFAULT_ERROR_DESCRIPTION,
  [XERO_OAUTH_REASON_MISSING_CODE]: DEFAULT_ERROR_DESCRIPTION,
  [XERO_OAUTH_REASON_OAUTH_FAILED]: DEFAULT_ERROR_DESCRIPTION,
  [XERO_OAUTH_REASON_NO_ORGANISATION]:
    'No Xero organisation was selected. Please try again and choose an organisation.',
  [XERO_OAUTH_REASON_SAVE_FAILED]: DEFAULT_ERROR_DESCRIPTION,
};

function descriptionForOAuthReason(reason: string | null): string {
  if (!reason) return DEFAULT_ERROR_DESCRIPTION;
  return OAUTH_REASON_DESCRIPTIONS[reason] || DEFAULT_ERROR_DESCRIPTION;
}

export function parseXeroOAuthReturn(
  searchParams: URLSearchParams
): XeroOAuthReturn | null {
  const xero = searchParams.get('xero');
  if (xero === 'success' || xero === 'connected' || xero === 'duplicate') {
    return { kind: 'success', title: 'Successfully connected to Xero!' };
  }
  if (xero === 'error') {
    return {
      kind: 'error',
      title: 'Failed to connect to Xero',
      description: descriptionForOAuthReason(searchParams.get('reason')),
    };
  }
  return null;
}

export function stripXeroOAuthSearchParams(searchParams: URLSearchParams): string {
  const next = new URLSearchParams(searchParams);
  next.delete('xero');
  next.delete('reason');
  const query = next.toString();
  return query ? `?${query}` : '';
}

type ApplyXeroOAuthReturnOptions = Readonly<{
  showSuccessToast: (title: string) => void;
  showErrorToast: (title: string, options?: { description?: string }) => void;
  replace: (href: string) => void;
  pathname: string;
}>;

export function applyXeroOAuthReturn(
  searchParams: URLSearchParams,
  options: ApplyXeroOAuthReturnOptions
): boolean {
  const parsed = parseXeroOAuthReturn(searchParams);
  if (!parsed) return false;
  if (parsed.kind === 'success') {
    options.showSuccessToast(parsed.title);
  } else {
    options.showErrorToast(parsed.title, { description: parsed.description });
  }
  options.replace(`${options.pathname}${stripXeroOAuthSearchParams(searchParams)}`);
  return true;
}
