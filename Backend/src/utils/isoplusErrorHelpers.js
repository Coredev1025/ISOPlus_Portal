export function extractAxiosErrorMessage(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (typeof data !== 'object' || data === null) {
    return String(data);
  }
  if (data.message) return String(data.message);
  if (data.error) return String(data.error);
  if (data.errors && Array.isArray(data.errors)) {
    return data.errors.map((e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e))).join(', ');
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function resolveNetworkErrorMessage(err) {
  if (err.code === 'ECONNABORTED') return 'Request timeout';
  if (err.code === 'ENOTFOUND') return 'DNS lookup failed';
  if (err.code === 'ECONNREFUSED') return 'Connection refused';
  if (err.code === 'ETIMEDOUT') return 'Connection timed out';
  return null;
}

export function getErrorMessageFromUnknown(err) {
  if (!err) return 'Unknown error';
  if (err.response?.data) {
    return extractAxiosErrorMessage(err.response.data);
  }
  const networkMsg = resolveNetworkErrorMessage(err);
  if (networkMsg) return networkMsg;
  if (err.message) return err.message;
  try {
    return String(err);
  } catch {
    return 'Unknown error occurred';
  }
}
