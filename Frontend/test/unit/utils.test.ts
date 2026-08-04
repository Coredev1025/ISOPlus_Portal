import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('joins single string classes', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('filters out falsy values', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });

  it('merges conflicting Tailwind classes', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('supports conditional objects', () => {
    expect(cn({ a: true, b: false }, 'c')).toBe('a c');
  });

  it('supports arrays of classnames', () => {
    expect(cn(['a', 'b'], 'c')).toBe('a b c');
  });

  it('returns empty string for no classes', () => {
    expect(cn()).toBe('');
  });
});
