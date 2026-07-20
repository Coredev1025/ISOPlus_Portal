export function sanitizeArrayForStorage(obj, depth, path, sanitizeFn, maxArrayLength) {
  if (obj.length > maxArrayLength) {
    const truncated = obj.slice(0, maxArrayLength);
    return [
      ...truncated.map((item, idx) => sanitizeFn(item, depth + 1, `${path}[${idx}]`)),
      `[${obj.length - maxArrayLength} more items...]`,
    ];
  }
  return obj.map((item, idx) => sanitizeFn(item, depth + 1, `${path}[${idx}]`));
}

export function isNonSerializableValue(value) {
  return (
    typeof value === 'function' ||
    value instanceof Buffer ||
    (value &&
      typeof value === 'object' &&
      value.constructor &&
      (value.constructor.name === 'Stream' || value.constructor.name === 'Socket'))
  );
}

export function sanitizeObjectEntriesForStorage(
  obj,
  depth,
  path,
  { excludedFields, getObjectSize, maxMetadataSize, sanitizeFn, normalizeErrorMeta },
) {
  const sanitized = {};
  let currentSize = 0;

  for (const [key, value] of Object.entries(obj)) {
    if (excludedFields.has(key.toLowerCase())) {
      sanitized[key] = '[Excluded - too large]';
      continue;
    }

    if (isNonSerializableValue(value)) {
      sanitized[key] = `[${value.constructor?.name || 'Non-serializable'}]`;
      continue;
    }

    const sanitizedValue =
      value instanceof Error
        ? sanitizeFn(normalizeErrorMeta(value), depth + 1, `${path}.${key}`)
        : sanitizeFn(value, depth + 1, `${path}.${key}`);

    const fieldSize = getObjectSize({ [key]: sanitizedValue });
    if (currentSize + fieldSize > maxMetadataSize) {
      sanitized._truncated = '[Metadata size limit reached]';
      break;
    }

    sanitized[key] = sanitizedValue;
    currentSize += fieldSize;
  }

  return sanitized;
}

export function filterMetaForLog(meta, { excludedFields, getObjectSize, maxMetadataSize }) {
  const filteredMeta = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (excludedFields.has(key.toLowerCase())) {
      continue;
    }

    if (typeof value === 'object' && value !== null) {
      const size = getObjectSize(value);
      if (size > maxMetadataSize / 2) {
        filteredMeta[key] = Array.isArray(value)
          ? `[Array with ${value.length} items - too large to store]`
          : '[Object too large to store]';
        continue;
      }
    }

    filteredMeta[key] = value;
  }
  return filteredMeta;
}

export function buildRequestContext(ctx, meta, truncateString) {
  if (!ctx.method) return {};
  return {
    method: ctx.method,
    url: truncateString(ctx.url || '', 200),
    workspaceId: ctx.workspaceId || meta.workspaceId,
    boardId: ctx.boardId || meta.boardId,
    requestId: ctx.requestId,
    userAction: ctx.userAction,
  };
}
