export function parseXeroValidationErrors(errObj) {
  if (errObj?.Type !== 'ValidationException' || !errObj.Elements?.length) {
    return '';
  }
  const validationMessages = errObj.Elements
    .flatMap((el) => (el.ValidationErrors || []).map((e) => e.Message))
    .filter(Boolean);
  return validationMessages.length ? validationMessages.join('; ') : '';
}

export function buildXeroContactErrorMessage(err) {
  const statusCode = err.response?.statusCode;
  if (statusCode === 403) {
    return 'Error creating or updating contact in Xero: Permission denied. Ensure your app has accounting.contacts scope.';
  }
  if (statusCode === 401) {
    return 'Error creating or updating contact in Xero: Authentication expired. Please re-authenticate.';
  }

  let detail = '';
  let rawBody = null;
  try {
    const body = err.response?.body ?? err.body;
    const errObj = typeof body === 'object'
      ? body
      : (typeof body === 'string'
        ? (() => { try { return JSON.parse(body); } catch { return null; } })()
        : null);
    rawBody = errObj ?? body;
    detail = parseXeroValidationErrors(errObj);
  } catch (_) {
    /* ignore parse errors */
  }

  const statusPart = statusCode != null ? ` [HTTP ${statusCode}]` : '';
  const detailPart = detail || err?.message || '';
  const apiDetailPart = rawBody != null
    ? ` Xero API response: ${typeof rawBody === 'object' ? JSON.stringify(rawBody) : String(rawBody)}`
    : '';
  return `Error creating or updating contact in Xero${statusPart}. ${detailPart}${apiDetailPart}`.trim();
}
