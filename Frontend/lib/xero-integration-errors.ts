const XERO_LOAD_TIMEOUT_MESSAGE = 'The request timed out. Please try again.';

type AxiosishError = {
  name?: string;
  code?: string;
  message?: string;
  response?: {
    status?: number;
    data?: { message?: string };
  };
};

function asError(error: unknown): AxiosishError {
  return error && typeof error === 'object' ? (error as AxiosishError) : {};
}

function responseMessage(error: unknown): string {
  const err = asError(error);
  return String(err.response?.data?.message || err.message || '');
}

export function isCanceledError(error: unknown): boolean {
  const name = asError(error).name;
  return name === 'CanceledError' || name === 'AbortError';
}

export function isXeroLoadTimeoutError(error: unknown): boolean {
  const err = asError(error);
  const status = err.response?.status;
  if (status === 408 || status === 504) return true;
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return true;
  return /timed?\s*out/i.test(responseMessage(error));
}

export function isExpectedMissingIntegrationData(error: unknown): boolean {
  if (isXeroLoadTimeoutError(error)) return false;
  const err = asError(error);
  const status = err.response?.status;
  if (status === 404) return true;
  if (status != null && status >= 400 && status < 500 && /not found/i.test(responseMessage(error))) {
    return true;
  }
  return false;
}

export function describeXeroLoadError(
  error: unknown,
  fallback = 'Please try again later'
): string {
  if (isXeroLoadTimeoutError(error)) return XERO_LOAD_TIMEOUT_MESSAGE;
  return responseMessage(error) || fallback;
}

export function xeroOptionsLoadDescription(error: unknown): string {
  return describeXeroLoadError(
    error,
    'Disconnect and Connect Xero again, then select an organisation.'
  );
}
