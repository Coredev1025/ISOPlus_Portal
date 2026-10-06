import { describe, it, expect } from 'vitest';
import {
  extractAxiosErrorMessage,
  resolveNetworkErrorMessage,
  getErrorMessageFromUnknown,
} from '../../../src/utils/isoplusErrorHelpers.js';

describe('extractAxiosErrorMessage', () => {
  it('returns a string body unchanged', () => {
    expect(extractAxiosErrorMessage('boom')).toBe('boom');
  });

  it('stringifies non-object, non-string bodies', () => {
    expect(extractAxiosErrorMessage(404)).toBe('404');
    expect(extractAxiosErrorMessage(null)).toBe('null');
    expect(extractAxiosErrorMessage(undefined)).toBe('undefined');
  });

  it('prefers message over error', () => {
    expect(extractAxiosErrorMessage({ message: 'm', error: 'e' })).toBe('m');
  });

  it('falls back to error', () => {
    expect(extractAxiosErrorMessage({ error: 'unauthorized' })).toBe('unauthorized');
  });

  it('joins an errors array of strings', () => {
    expect(extractAxiosErrorMessage({ errors: ['a', 'b'] })).toBe('a, b');
  });

  it('joins an errors array of objects by message, JSON-encoding those without one', () => {
    expect(extractAxiosErrorMessage({ errors: [{ message: 'bad' }, { code: 7 }] }))
      .toBe('bad, {"code":7}');
  });

  it('JSON-encodes an object with no known field', () => {
    expect(extractAxiosErrorMessage({ status: 500 })).toBe('{"status":500}');
  });

  it('falls back to String() when JSON encoding throws', () => {
    const circular = {};
    circular.self = circular;
    expect(extractAxiosErrorMessage(circular)).toBe('[object Object]');
  });
});

describe('resolveNetworkErrorMessage', () => {
  it.each([
    ['ECONNABORTED', 'Request timeout'],
    ['ENOTFOUND', 'DNS lookup failed'],
    ['ECONNREFUSED', 'Connection refused'],
    ['ETIMEDOUT', 'Connection timed out'],
  ])('maps %s', (code, expected) => {
    expect(resolveNetworkErrorMessage({ code })).toBe(expected);
  });

  it('returns null for an unknown code', () => {
    expect(resolveNetworkErrorMessage({ code: 'EOTHER' })).toBeNull();
    expect(resolveNetworkErrorMessage({})).toBeNull();
  });
});

describe('getErrorMessageFromUnknown', () => {
  it('returns "Unknown error" for falsy input', () => {
    expect(getErrorMessageFromUnknown(null)).toBe('Unknown error');
    expect(getErrorMessageFromUnknown(undefined)).toBe('Unknown error');
  });

  it('prefers the axios response body', () => {
    const err = { response: { data: { message: 'nope' } }, message: 'ignored', code: 'ETIMEDOUT' };
    expect(getErrorMessageFromUnknown(err)).toBe('nope');
  });

  it('falls through to the network code when there is no response body', () => {
    expect(getErrorMessageFromUnknown({ code: 'ECONNREFUSED', message: 'ignored' }))
      .toBe('Connection refused');
  });

  it('falls back to the error message', () => {
    expect(getErrorMessageFromUnknown(new Error('plain'))).toBe('plain');
  });

  it('stringifies an error with no message', () => {
    expect(getErrorMessageFromUnknown({ toString: () => 'weird' })).toBe('weird');
  });
});
