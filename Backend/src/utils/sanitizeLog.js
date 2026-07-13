/**
 * Strip newline characters from user-controlled values before logging (SonarQube S5145).
 */
export function sanitizeLogValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return value.replace(/[\r\n]+/g, ' ').trim();
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeLogValue);
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, sanitizeLogValue(val)])
    );
  }

  return value;
}
