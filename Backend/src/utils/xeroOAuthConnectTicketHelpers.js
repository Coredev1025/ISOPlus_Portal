import XeroConnectTicket from '../models/XeroConnectTicket.js';
import { normalizePortalUserId } from './xeroOAuthSessionHelpers.js';

export async function createXeroConnectTicket({ userId, workspaceId, origin = '' }) {
  const normalizedUserId = normalizePortalUserId(userId);
  const normalizedWorkspaceId = String(workspaceId || '').trim();
  if (!normalizedUserId || !normalizedWorkspaceId) {
    throw new Error('Invalid Xero connect ticket input');
  }
  const doc = await XeroConnectTicket.create({
    userId: normalizedUserId,
    workspaceId: normalizedWorkspaceId,
    origin: typeof origin === 'string' ? origin.trim() : '',
  });
  return doc.ticket;
}

export async function claimXeroConnectTicket(ticket, payload) {
  const ticketId = String(ticket || '').trim();
  const userId = normalizePortalUserId(payload?.userId);
  const workspaceId = String(payload?.workspaceId || '').trim();
  if (!ticketId || !userId || !workspaceId) return false;

  const claimed = await XeroConnectTicket.findOneAndUpdate(
    {
      ticket: ticketId,
      userId,
      workspaceId,
      claimedAt: null,
    },
    { $set: { claimedAt: new Date() } },
    { new: true }
  ).lean();

  return Boolean(claimed);
}
