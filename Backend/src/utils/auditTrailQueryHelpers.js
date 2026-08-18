import { getSafeString, toRequiredQueryString } from './securityHelpers.js';

export function buildAuditListFilter(query) {
  const workspaceId = toRequiredQueryString(query?.workspaceId);
  if (!workspaceId) return { error: 'Invalid workspaceId' };

  const filter = { workspaceId };
  const category = getSafeString(toRequiredQueryString(query?.category));
  if (category) {
    filter.category = category;
  }
  return { filter };
}
