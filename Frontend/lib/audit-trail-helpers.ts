export function normalizeAuditDetailFromJson(detail: string): string {
  try {
    const parsed = JSON.parse(detail);
    const statusCode = typeof parsed?.statusCode === 'number' ? parsed.statusCode : undefined;
    const durationMs = typeof parsed?.durationMs === 'number' ? parsed.durationMs : undefined;
    const ok = typeof statusCode === 'number' ? statusCode < 400 : undefined;

    const parts: string[] = [];
    if (ok !== undefined) parts.push(ok ? 'OK' : 'FAILED');
    if (statusCode !== undefined) parts.push(`status=${statusCode}`);
    if (durationMs !== undefined) parts.push(`durationMs=${Math.round(durationMs * 100) / 100}`);
    return parts.length ? parts.join(' ') : detail;
  } catch {
    return detail;
  }
}

export function normalizeAuditDetail(item: { detail?: string }): string {
  const detail = String(item?.detail || '');
  if (!detail) return '';

  const looksJson = detail.startsWith('{') && detail.endsWith('}');
  if (looksJson) {
    return normalizeAuditDetailFromJson(detail);
  }

  return detail;
}
