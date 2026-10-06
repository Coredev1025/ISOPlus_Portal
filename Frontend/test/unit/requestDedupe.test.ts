import { describe, it, expect, vi } from 'vitest';
import { dedupeByKey } from '@/app/utils/requestDedupe';

describe('dedupeByKey', () => {
  it('reuses the in-flight promise for the same key', async () => {
    let calls = 0;
    const factory = () => {
      calls += 1;
      return new Promise<number>((resolve) => setTimeout(() => resolve(calls), 20));
    };
    const p1 = dedupeByKey('k1', factory);
    const p2 = dedupeByKey('k1', factory);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it('allows a new call after the previous settles', async () => {
    const factory = vi.fn(async () => 'ok');
    await dedupeByKey('k2', factory);
    await dedupeByKey('k2', factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
