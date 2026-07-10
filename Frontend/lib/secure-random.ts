function getCrypto(): Crypto {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return globalThis.crypto;
  }
  throw new Error('Cryptographically secure random values are not available');
}

export function secureRandomFloat(): number {
  const array = new Uint32Array(1);
  getCrypto().getRandomValues(array);
  return array[0] / 0x100000000;
}

export function secureRandomInt(max: number): number {
  return Math.floor(secureRandomFloat() * max);
}

export function randomAlphanumeric(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}
