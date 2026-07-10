function extractFromErrorEntry(first) {
  if (typeof first === 'string') return first.slice(0, 500);
  if (first && typeof first === 'object') {
    const m = first.msg || first.message || first.error;
    if (m) return String(m).slice(0, 500);
  }
  return undefined;
}

function extractFromErrorsArray(errors) {
  if (!Array.isArray(errors) || !errors.length) return undefined;
  return extractFromErrorEntry(errors[0]);
}

function extractPrimaryMessage(body) {
  const message = body.message || body.error || body.reason;
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  return extractFromErrorsArray(body.errors);
}

export function extractFailureReason(body) {
  try {
    if (body === null || body === undefined) return undefined;
    if (typeof body === 'string') return body.slice(0, 500);
    if (typeof body !== 'object') return String(body).slice(0, 500);

    const primary = extractPrimaryMessage(body);
    if (primary) return primary;

    return JSON.stringify(body).slice(0, 500);
  } catch {
    return undefined;
  }
}
