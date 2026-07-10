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
