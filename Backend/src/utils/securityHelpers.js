import crypto from 'crypto';

export function randomBytesHex(byteLength = 16) {
  return crypto.randomBytes(byteLength).toString('hex');
}

export function randomAlphanumeric(length = 9) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

export function secureRandomFloat() {
  return crypto.randomBytes(4).readUInt32BE(0) / 0x100000000;
}

function isPlainMongoValue(value) {
  if (value === undefined || value === null) return false;
  const valueType = typeof value;
  return (
    valueType === 'string'
    || valueType === 'number'
    || valueType === 'boolean'
    || valueType === 'bigint'
  );
}

/**
 * Coerce user-controlled input to a plain MongoDB query scalar.
 * Rejects objects and arrays to prevent NoSQL injection (e.g. { $ne: "" }).
 */
export function toMongoQueryValue(value) {
  if (!isPlainMongoValue(value)) return null;
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Accept only a non-empty plain string from user-controlled input.
 */
export function getSafeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function toQueryString(value) {
  return toMongoQueryValue(value);
}

export function toRequiredQueryString(value) {
  return toMongoQueryValue(value) ?? '';
}

export function toQueryStringArray(values) {
  if (!Array.isArray(values)) {
    const single = toMongoQueryValue(values);
    return single ? [single] : [];
  }
  return values.map(toMongoQueryValue).filter(Boolean);
}

export function pickAllowedSortField(sortBy, allowedFields, defaultField) {
  const normalized = toMongoQueryValue(sortBy) ?? defaultField;
  return allowedFields.includes(normalized) ? normalized : defaultField;
}

export function pickAllowedValue(value, allowedValues, defaultValue = null) {
  const normalized = toMongoQueryValue(value);
  return normalized && allowedValues.includes(normalized) ? normalized : defaultValue;
}

export function mongoEq(value) {
  const normalized = toMongoQueryValue(value);
  if (normalized === null) {
    throw new Error('Invalid query value: expected a plain string, number, boolean, or bigint.');
  }
  return normalized;
}

export function sanitizeApiPathSegment(value, label = 'id') {
  const normalized = getSafeString(value);
  if (!normalized) {
    throw new Error(`Invalid ${label}: expected a non-empty string.`);
  }
  if (normalized.includes('..') || /[./\\%]/.test(normalized)) {
    throw new Error(`Invalid ${label}: path traversal sequences are not allowed.`);
  }
  return normalized;
}

const ISO_PLUS_API_V2_BASE = 'https://app.isoplus.online/api/v2';
const ISO_PLUS_API_BASE = 'https://app.isoplus.online/api';

/**
 * Validate a path segment (reject empty / traversal), then encode for URL path use.
 * encodeURIComponent must appear at the URL construction site for SonarQube S7044.
 */
export function validatedPathSegment(value, label = 'id') {
  return sanitizeApiPathSegment(value, label);
}

export function buildIsoPlusV2WorkspaceBoardsUrl(workspaceId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards`;
}

export function buildIsoPlusV2WorkspaceMembersUrl(workspaceId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/members`;
}

export function buildIsoPlusV2BoardFoldersUrl(workspaceId, boardId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/folders/`;
}

export function buildIsoPlusV2BoardViewsUrl(workspaceId, boardId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/views`;
}

export function buildIsoPlusV2BoardViewUrl(workspaceId, boardId, viewId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  const safeViewId = encodeURIComponent(validatedPathSegment(viewId, 'viewId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/views/${safeViewId}`;
}

export function buildIsoPlusV2BoardItemsUrl(workspaceId, boardId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/items/`;
}

export function buildIsoPlusV2ItemUrl(workspaceId, boardId, itemId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  const safeItemId = encodeURIComponent(validatedPathSegment(itemId, 'itemId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/items/${safeItemId}`;
}

export function buildIsoPlusV2BoardReferencesUrl(workspaceId, boardId, itemId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  const safeItemId = encodeURIComponent(validatedPathSegment(itemId, 'itemId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/references?from_item_id=${safeItemId}`;
}

export function buildIsoPlusV2BoardAttributesUrl(workspaceId, boardId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/attributes`;
}

export function buildIsoPlusV2BoardAttributeUrl(workspaceId, boardId, attributeId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  const safeAttributeId = encodeURIComponent(validatedPathSegment(attributeId, 'attributeId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/attributes/${safeAttributeId}`;
}

export function buildIsoPlusV2BoardHooksUrl(workspaceId, boardId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/hooks`;
}

export function buildIsoPlusV2BoardHookUrl(workspaceId, boardId, hookId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(validatedPathSegment(boardId, 'boardId'));
  const safeHookId = encodeURIComponent(validatedPathSegment(hookId, 'hookId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/hooks/${safeHookId}`;
}

export function buildIsoPlusAutomationUrl(workspaceId, automationId) {
  const safeWorkspaceId = encodeURIComponent(validatedPathSegment(workspaceId, 'workspaceId'));
  const safeAutomationId = encodeURIComponent(validatedPathSegment(automationId, 'automationId'));
  return `${ISO_PLUS_API_BASE}/${safeWorkspaceId}/automations/${safeAutomationId}`;
}
