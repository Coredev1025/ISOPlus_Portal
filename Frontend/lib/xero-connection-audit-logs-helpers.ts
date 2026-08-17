import { normalizeAuditDetail } from '@/lib/audit-trail-helpers';

export type XeroAuditLogItem = {
  id: string;
  createdAt: string;
  action: string;
  detail: string;
  user: string;
  success: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return {};
}

export function mapXeroAuditItems(items: unknown): XeroAuditLogItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const row = asRecord(item);
    return {
      id: String(row._id || row.createdAt || index),
      createdAt: row.createdAt ? String(row.createdAt) : '',
      action: String(row.action || ''),
      detail: normalizeAuditDetail({ detail: row.detail as string | undefined }),
      user: String(row.userEmail || ''),
      success: row.success !== false,
    };
  });
}
