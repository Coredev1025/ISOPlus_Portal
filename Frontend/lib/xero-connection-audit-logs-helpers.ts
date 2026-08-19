import {
  AUDIT_CATEGORY_XERO,
  AUDIT_SORT_BY_CREATED_AT,
  AUDIT_SORT_ORDER_DESC,
  XERO_AUDIT_PAGE_SIZE,
} from '@/constants/audit';
import { normalizeAuditDetail } from '@/lib/audit-trail-helpers';

export type XeroAuditLogItem = {
  id: string;
  createdAt: string;
  action: string;
  detail: string;
  user: string;
  success: boolean;
};

export type XeroAuditListParams = {
  workspaceId: string;
  category: string;
  sortBy: string;
  sortOrder: string;
  page: number;
  limit: number;
};

export type XeroAuditListResult = {
  items: XeroAuditLogItem[];
  page: number;
  totalPages: number;
  total: number;
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

export function buildXeroAuditListParams({
  workspaceId,
  page,
}: {
  workspaceId: string;
  page: number;
}): XeroAuditListParams {
  return {
    workspaceId,
    category: AUDIT_CATEGORY_XERO,
    sortBy: AUDIT_SORT_BY_CREATED_AT,
    sortOrder: AUDIT_SORT_ORDER_DESC,
    page: Math.max(1, Math.floor(Number(page) || 1)),
    limit: XERO_AUDIT_PAGE_SIZE,
  };
}

export function parseXeroAuditListResponse(data: unknown): XeroAuditListResult {
  const row = asRecord(data);
  const items = mapXeroAuditItems(row.items);
  const page = Number(row.page) || 1;
  const total = Number(row.total) || items.length;
  const totalPages =
    Number(row.totalPages) || Math.ceil(total / XERO_AUDIT_PAGE_SIZE) || 1;
  return { items, page, totalPages, total };
}
