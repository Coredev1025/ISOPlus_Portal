import { describe, it, expect } from 'vitest';
import { extractFailureReason } from '../../../src/middleware/httpFailureReason.js';

describe('extractFailureReason', () => {
  it('returns undefined for null and undefined bodies', () => {
    expect(extractFailureReason(null)).toBeUndefined();
    expect(extractFailureReason(undefined)).toBeUndefined();
  });

  it('returns a string body as-is', () => {
    expect(extractFailureReason('Bad Request')).toBe('Bad Request');
  });

  it('stringifies a primitive body', () => {
    expect(extractFailureReason(500)).toBe('500');
    expect(extractFailureReason(false)).toBe('false');
  });

  it('prefers message over error and reason', () => {
    expect(extractFailureReason({ message: 'm', error: 'e', reason: 'r' })).toBe('m');
  });

  it('falls back to error, then reason', () => {
    expect(extractFailureReason({ error: 'e', reason: 'r' })).toBe('e');
    expect(extractFailureReason({ reason: 'r' })).toBe('r');
  });

  it('trims surrounding whitespace from the primary message', () => {
    expect(extractFailureReason({ message: '  spaced  ' })).toBe('spaced');
  });

  it('ignores a blank primary message and falls through to errors[]', () => {
    expect(extractFailureReason({ message: '   ', errors: ['from array'] })).toBe('from array');
  });

  it('ignores a non-string primary message and falls through to errors[]', () => {
    expect(extractFailureReason({ message: { nested: true }, errors: ['from array'] }))
      .toBe('from array');
  });

  it('reads the first entry of a string errors array', () => {
    expect(extractFailureReason({ errors: ['first', 'second'] })).toBe('first');
  });

  it('reads msg, then message, then error from the first errors entry', () => {
    expect(extractFailureReason({ errors: [{ msg: 'a', message: 'b', error: 'c' }] })).toBe('a');
    expect(extractFailureReason({ errors: [{ message: 'b', error: 'c' }] })).toBe('b');
    expect(extractFailureReason({ errors: [{ error: 'c' }] })).toBe('c');
  });

  it('stringifies a non-string message on the first errors entry', () => {
    expect(extractFailureReason({ errors: [{ msg: 42 }] })).toBe('42');
  });

  it('JSON-encodes the body when the first errors entry carries no message', () => {
    expect(extractFailureReason({ errors: [{ field: 'email' }] }))
      .toBe('{"errors":[{"field":"email"}]}');
  });

  it('JSON-encodes the body when errors is empty or not an array', () => {
    expect(extractFailureReason({ errors: [] })).toBe('{"errors":[]}');
    expect(extractFailureReason({ errors: 'nope' })).toBe('{"errors":"nope"}');
  });

  it('JSON-encodes a body with no recognised field', () => {
    expect(extractFailureReason({ status: 422, field: 'email' }))
      .toBe('{"status":422,"field":"email"}');
  });

  it('caps a long string body at 500 characters', () => {
    const reason = extractFailureReason('x'.repeat(900));
    expect(reason).toHaveLength(500);
    expect(reason).toBe('x'.repeat(500));
  });

  it('caps a long primary message at 500 characters', () => {
    expect(extractFailureReason({ message: 'y'.repeat(900) })).toHaveLength(500);
  });

  it('caps a long errors-array message at 500 characters', () => {
    expect(extractFailureReason({ errors: ['z'.repeat(900)] })).toHaveLength(500);
    expect(extractFailureReason({ errors: [{ msg: 'z'.repeat(900) }] })).toHaveLength(500);
  });

  it('caps a long JSON fallback at 500 characters', () => {
    expect(extractFailureReason({ padding: 'p'.repeat(900) })).toHaveLength(500);
  });

  it('returns undefined rather than throwing when the body cannot be serialised', () => {
    const circular = { status: 500 };
    circular.self = circular;
    expect(extractFailureReason(circular)).toBeUndefined();
  });

  it('returns undefined when a getter on the body throws', () => {
    const exploding = {};
    Object.defineProperty(exploding, 'message', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(extractFailureReason(exploding)).toBeUndefined();
  });
});
