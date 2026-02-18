import AuditTrail from '../models/AuditTrail.js';
import { error as logError, extractContextFromReq } from './logger.js';

function truncate(str, max = 4000) {
  if (typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

function detailToString(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail.trim();
  try {
    return truncate(JSON.stringify(detail));
  } catch {
    return truncate(String(detail));
  }
}

function validateAuditData(data) {
  const {
    workspaceId,
    boardId,
    action,
    detail,
    req,
    // additional optional fields
    success,
    statusCode,
    category,
    entityType,
    entityId,
    before,
    after,
    metadata,
    errorMessage,
    errorStack
  } = data || {};

  if (!workspaceId || typeof workspaceId !== 'string') throw new Error('Invalid or missing workspaceId');
  if (!action || typeof action !== 'string') throw new Error('Invalid or missing action');

  const detailString = detailToString(detail) || action.trim();
  const ctx = req ? extractContextFromReq(req) : {};

  return {
    workspaceId: workspaceId.toString(),
    boardId: boardId?.toString() || ctx.boardId || "",
    action: action.trim(),
    detail: detailString,
    userEmail: ctx.email?.toString() || "",
    userId: ctx.userId?.toString() || "",
    userRole: ctx.userRole?.toString() || "",
    userIp: (ctx.ip || "N/A").toString(),
    requestId: (ctx.requestId || "").toString(),
    method: (ctx.method || "").toString(),
    path: (ctx.url || "").toString(),
    statusCode: typeof statusCode === 'number' ? statusCode : null,
    success: typeof success === 'boolean' ? success : true,
    category: category?.toString() || "",
    entityType: entityType?.toString() || "",
    entityId: entityId?.toString() || "",
    before: before ?? null,
    after: after ?? null,
    errorMessage: truncate(errorMessage?.toString() || ""),
    errorStack: truncate(errorStack?.toString() || "", 8000),
    metadata: metadata ?? null,
    createdAt: new Date()
  };
}

export async function logAuditTrail(params) {
  try {
    const validatedData = validateAuditData(params);
    
    await AuditTrail.create(validatedData);
  } catch (err) {
    logError('AuditLogger', 'Failed to log audit trail', err, params?.req);
  }
}