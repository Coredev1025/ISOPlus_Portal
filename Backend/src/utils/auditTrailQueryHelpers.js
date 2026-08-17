import { getSafeString, toRequiredQueryString } from './securityHelpers.js';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildAuditListFilter(query) {
  const workspaceId = toRequiredQueryString(query?.workspaceId);
  if (!workspaceId) return { error: 'Invalid workspaceId' };

  const filter = { workspaceId };
  const category = getSafeString(toRequiredQueryString(query?.category));
  if (category) {
    filter.category = { $regex: `^${escapeRegExp(category)}$`, $options: 'i' };
  }
  return { filter };
}
