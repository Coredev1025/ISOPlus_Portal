function resolveStringLabelIds(data, labels) {
  return data.map(labelId => {
    const label = labels.find(l => l.id === labelId);
    return label ? { id: label.id, name: label.name, color: label.color } : labelId;
  });
}

function transformLabelArrayValue(data, labels) {
  if (data.length === 0) {
    return data;
  }
  const firstItem = data[0];
  if (typeof firstItem === 'string') {
    const resolvedLabels = resolveStringLabelIds(data, labels);
    return resolvedLabels.length === 1 ? resolvedLabels[0] : resolvedLabels;
  }
  if (typeof firstItem === 'object' && firstItem.id) {
    return data.length === 1 ? data[0] : data;
  }
  return data;
}

export function transformLabelValue(data, attribute) {
  if (Array.isArray(data)) {
    const labels = attribute?.settings?.labels || [];
    return transformLabelArrayValue(data, labels);
  }

  if (typeof data === 'object' && data.id) {
    return { id: data.id, name: data.name, color: data.color };
  }

  return data;
}

export function resolveAttributeKey(valueObj) {
  const rawName = valueObj.attribute?.name;
  const attributeId = valueObj.attribute?.id;
  if (typeof rawName === 'string' && rawName.trim()) {
    return rawName.trim();
  }
  if (attributeId != null && String(attributeId).trim() !== '') {
    return `__attr_${attributeId}`;
  }
  return null;
}

export function markTimeTrackingByAttributeType(transformedData, valueObj, attributeKey) {
  const attrType = valueObj.attribute?.type;
  if (typeof attrType !== 'string' || !/time.?track/i.test(attrType)) {
    return false;
  }
  transformedData._hasTimeTracking = true;
  transformedData._timeTrackingKey = attributeKey;
  transformedData._timeTrackingAttributeId = valueObj.attribute?.id ?? null;
  return true;
}

export function markTimeTrackingFromTransformedValue(transformedData, valueObj, attributeKey, transformedValue) {
  if (transformedData._hasTimeTracking) return false;
  const hasTimeTrackingShape =
    Array.isArray(transformedValue) &&
    transformedValue.length > 0 &&
    typeof transformedValue[0] === 'object' &&
    transformedValue[0] !== null &&
    'started_at' in transformedValue[0];
  if (!hasTimeTrackingShape) return false;
  transformedData._hasTimeTracking = true;
  transformedData._timeTrackingKey = attributeKey;
  transformedData._timeTrackingAttributeId = valueObj.attribute?.id ?? null;
  return true;
}

export function applyTransformedItemValue(transformedData, valueObj, attributeKey, transformedValue) {
  if (transformedValue === null || transformedValue === undefined) {
    return null;
  }

  transformedData[attributeKey] = transformedValue;

  let primaryAttributeValue = null;
  if (valueObj.attribute?.primary === true && typeof transformedValue === 'string' && transformedValue.trim()) {
    primaryAttributeValue = transformedValue.trim();
  }

  markTimeTrackingFromTransformedValue(transformedData, valueObj, attributeKey, transformedValue);
  return primaryAttributeValue;
}

export function processItemValueObject(transformedData, valueObj, transformValue) {
  if (valueObj.deleted) {
    return null;
  }

  const attributeKey = resolveAttributeKey(valueObj);
  if (!attributeKey) {
    return null;
  }

  if (!transformedData._hasTimeTracking) {
    markTimeTrackingByAttributeType(transformedData, valueObj, attributeKey);
  }

  const transformedValue = transformValue(valueObj);
  return applyTransformedItemValue(transformedData, valueObj, attributeKey, transformedValue);
}

export function resolveDisplayName(isoPlusItem, primaryAttributeValue) {
  const topLevelName = typeof isoPlusItem.name === 'string' && isoPlusItem.name.trim()
    ? isoPlusItem.name.trim()
    : null;
  return topLevelName || primaryAttributeValue || null;
}

export function applyItemValueTransform(transformedData, valueObj, transformValueFn) {
  const attributeKey = resolveAttributeKey(valueObj);
  if (!attributeKey) {
    return null;
  }

  if (!transformedData._hasTimeTracking) {
    markTimeTrackingByAttributeType(transformedData, valueObj, attributeKey);
  }

  const transformedValue = transformValueFn(valueObj);
  if (transformedValue === null || transformedValue === undefined) {
    return null;
  }

  transformedData[attributeKey] = transformedValue;

  let primaryValue = null;
  if (valueObj.attribute?.primary === true && typeof transformedValue === 'string' && transformedValue.trim()) {
    primaryValue = transformedValue.trim();
  }

  markTimeTrackingFromTransformedValue(transformedData, valueObj, attributeKey, transformedValue);
  return primaryValue;
}
