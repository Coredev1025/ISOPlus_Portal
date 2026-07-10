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

export function toQueryString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

export function toRequiredQueryString(value) {
  return toQueryString(value) ?? '';
}

export function toQueryStringArray(values) {
  if (!Array.isArray(values)) {
    const single = toQueryString(values);
    return single ? [single] : [];
  }
  return values.map(toQueryString).filter(Boolean);
}

export function pickAllowedSortField(sortBy, allowedFields, defaultField) {
  const normalized = toQueryString(sortBy) ?? defaultField;
  return allowedFields.includes(normalized) ? normalized : defaultField;
}

export function pickAllowedValue(value, allowedValues, defaultValue = null) {
  const normalized = toQueryString(value);
  return normalized && allowedValues.includes(normalized) ? normalized : defaultValue;
}
