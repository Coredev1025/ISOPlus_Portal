import AuditTrail from '../models/AuditTrail.js';
import { error as logError } from './logger.js';

function validateAuditData(data) {
  const { workspaceId, action, detail, req } = data;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new Error('Invalid or missing workspaceId');
  }

  if (!action || typeof action !== 'string') {
    throw new Error('Invalid or missing action');
  }

  if (!detail || typeof detail !== 'string') {
    throw new Error('Invalid or missing detail');
  }

  if (!req || typeof req !== 'object') {
    throw new Error('Invalid or missing request object');
  }

  return {
    workspaceId: workspaceId.toString(),
    action: action.trim(),
    detail: detail.trim(),
    userEmail: req.user?.email?.toString() || "",
    userIp: (req.ip?.split(':').pop() || "N/A").toString(),
    createdAt: new Date()
  };
}

export async function logAuditTrail(params) {
  try {
    const validatedData = validateAuditData(params);
    
    await AuditTrail.create(validatedData);
  } catch (err) {
    logError('AuditLogger', 'Failed to log audit trail:', err);
  }
}