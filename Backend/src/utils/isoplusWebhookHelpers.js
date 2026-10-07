export function valueReferencesId(value, referencedIdStr) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string' && value === referencedIdStr) {
    return true;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item === referencedIdStr) {
        return true;
      }
      if (typeof item === 'object' && item !== null && item.id === referencedIdStr) {
        return true;
      }
    }
    return false;
  }

  return typeof value === 'object' && value !== null && value.id === referencedIdStr;
}

export function itemDataReferencesId(itemData, referencedIdStr) {
  if (!itemData || typeof itemData !== 'object') {
    return false;
  }

  for (const value of Object.values(itemData)) {
    if (valueReferencesId(value, referencedIdStr)) {
      return true;
    }
  }

  return false;
}

export function resolveWebhookTransformedValue(payload, isDeleted, transformValue, warn) {
  if (isDeleted) return null;

  const attributeType = payload.attribute?.type;
  if (attributeType === 'label' && !payload.attribute?.settings?.labels) {
    warn('Webhook-Handler', 'Incomplete label metadata in webhook payload, storing raw data', {
      itemId: payload.item_id,
      attributeName: payload.attribute?.name,
      attributeType,
    });
    return payload.data;
  }

  return transformValue(payload);
}

/** What a hook payload carries, for the log: key names and id presence only, never values. */
export function describeHookPayloadShape(payload) {
  return {
    payloadKeys: Object.keys(payload ?? {}),
    hasBoardId: Boolean(payload?.board_id),
    hasWorkspaceId: Boolean(payload?.workspace_id),
    hasItemId: Boolean(payload?.item_id ?? payload?.id),
  };
}
