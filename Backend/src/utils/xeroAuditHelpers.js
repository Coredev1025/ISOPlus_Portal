import { AUDIT_CATEGORY_XERO } from '../constants/audit.js';
import { logAuditTrail } from './auditLogger.js';

export function logXeroAudit(params) {
  return logAuditTrail({
    ...params,
    category: AUDIT_CATEGORY_XERO,
  });
}
