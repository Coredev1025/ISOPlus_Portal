import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import transformCacheDefault, {
  getCachedTransform,
  setCachedTransform,
  getMultipleCachedTransforms,
  setMultipleCachedTransforms,
  invalidateCacheForItem,
  invalidateCacheForBoard,
  invalidateCacheForWorkspace,
  cleanupExpiredEntries,
  getCacheStats,
  clearCache,
  getCachedMSBudget,
  setCachedMSBudget,
  getCachedMSService,
  setCachedMSService,
  invalidateMSCacheForItem,
} from '../../../src/utils/transformCache.js';

/*
 * The cache is module-level state shared by every test in this file, so it is
 * reset through the module's own public API (clearCache) before and after each
 * test rather than by reaching into the Map.
 */
beforeEach(() => clearCache());
afterEach(() => clearCache());

/** Shape actually cached by invoiceGeneratorRouteHelpers.js — a transformed invoice row. */
const transformedRow = (overrides = {}) => ({
  id: 'item-1',
  participant: 'Jane Citizen',
  service: 'Domestic Assistance',
  totalAmount: 120.5,
  govSubsidy: 100,
  participantContribution: 20.5,
  ...overrides,
});

const WS = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const BOARD = 'b1d9c6e2-1111-4562-b3fc-2c963f66afa6';

describe('getCachedTransform / setCachedTransform', () => {
  it('misses before the value is stored and hits afterwards', () => {
    expect(getCachedTransform(WS, BOARD, 'item-1')).toBeNull();

    const data = transformedRow();
    setCachedTransform(WS, BOARD, 'item-1', data);

    expect(getCachedTransform(WS, BOARD, 'item-1')).toEqual(transformedRow());
  });

  it('returns the stored object by reference, not a copy', () => {
    const data = transformedRow();
    setCachedTransform(WS, BOARD, 'item-1', data);

    expect(getCachedTransform(WS, BOARD, 'item-1')).toBe(data);
  });

  it('caches falsy payloads but reports them as a miss to the caller', () => {
    // getCachedTransform returns entry.data, so a stored `null` is indistinguishable
    // from a miss; getMultipleCachedTransforms then drops the item entirely.
    setCachedTransform(WS, BOARD, 'item-1', null);

    expect(getCachedTransform(WS, BOARD, 'item-1')).toBeNull();
    expect(getCacheStats().totalSize).toBe(1);
  });

  it('overwrites an existing entry rather than adding a second one', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow({ totalAmount: 1 }));
    setCachedTransform(WS, BOARD, 'item-1', transformedRow({ totalAmount: 2 }));

    expect(getCachedTransform(WS, BOARD, 'item-1').totalAmount).toBe(2);
    expect(getCacheStats().totalSize).toBe(1);
  });

  it('keys on workspace, board and item independently', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow({ participant: 'A' }));
    setCachedTransform(WS, BOARD, 'item-2', transformedRow({ participant: 'B' }));
    setCachedTransform(WS, 'other-board', 'item-1', transformedRow({ participant: 'C' }));
    setCachedTransform('other-ws', BOARD, 'item-1', transformedRow({ participant: 'D' }));

    expect(getCachedTransform(WS, BOARD, 'item-1').participant).toBe('A');
    expect(getCachedTransform(WS, BOARD, 'item-2').participant).toBe('B');
    expect(getCachedTransform(WS, 'other-board', 'item-1').participant).toBe('C');
    expect(getCachedTransform('other-ws', BOARD, 'item-1').participant).toBe('D');
    expect(getCacheStats().totalSize).toBe(4);
  });

  it('collides when an id itself contains the ":" separator', () => {
    // Documented quirk: the key is built by string concatenation with ":" and the
    // segments are never escaped, so ("a:b","c") and ("a","b:c") produce the same key.
    setCachedTransform('a:b', 'c', 'item-1', transformedRow({ participant: 'first' }));
    setCachedTransform('a', 'b:c', 'item-1', transformedRow({ participant: 'second' }));

    expect(getCacheStats().totalSize).toBe(1);
    expect(getCachedTransform('a:b', 'c', 'item-1').participant).toBe('second');
  });

  it('treats an entry whose TTL has already elapsed as a miss and deletes it', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow(), -1);
    expect(getCacheStats().totalSize).toBe(1);

    expect(getCachedTransform(WS, BOARD, 'item-1')).toBeNull();
    expect(getCacheStats().totalSize).toBe(0);
  });

  it('honours a custom TTL that has not elapsed', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow(), 60_000);

    expect(getCachedTransform(WS, BOARD, 'item-1')).toEqual(transformedRow());
  });

  it('evicts the entry when the item was updated after it was cached', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());
    const future = new Date(Date.now() + 60_000);

    expect(getCachedTransform(WS, BOARD, 'item-1', future)).toBeNull();
    expect(getCacheStats().totalSize).toBe(0);
  });

  it('keeps the entry when the item was updated before it was cached', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());
    const past = new Date(Date.now() - 60_000).toISOString();

    expect(getCachedTransform(WS, BOARD, 'item-1', past)).toEqual(transformedRow());
    expect(getCacheStats().totalSize).toBe(1);
  });

  it('skips the version check for a nullish or empty updatedAt', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());

    expect(getCachedTransform(WS, BOARD, 'item-1', null)).toEqual(transformedRow());
    expect(getCachedTransform(WS, BOARD, 'item-1', undefined)).toEqual(transformedRow());
    expect(getCachedTransform(WS, BOARD, 'item-1', '')).toEqual(transformedRow());
  });

  it('keeps the entry when updatedAt is unparseable', () => {
    // new Date('not-a-date').getTime() is NaN and NaN > cachedAt is false,
    // so a garbage timestamp reads as "not updated" rather than as a miss.
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());

    expect(getCachedTransform(WS, BOARD, 'item-1', 'not-a-date')).toEqual(transformedRow());
    expect(getCacheStats().totalSize).toBe(1);
  });

  it('checks expiry before the version, so an expired entry is a miss even for an old item', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow(), -1);

    expect(getCachedTransform(WS, BOARD, 'item-1', new Date(Date.now() - 60_000))).toBeNull();
  });
});

describe('cache size bound', () => {
  it('drops the 1000 oldest entries once 10000 are cached', () => {
    for (let i = 0; i < 10_000; i++) {
      setCachedTransform(WS, BOARD, `item-${i}`, transformedRow({ id: `item-${i}` }));
    }
    expect(getCacheStats().totalSize).toBe(10_000);

    setCachedTransform(WS, BOARD, 'item-10000', transformedRow({ id: 'item-10000' }));

    // 10000 - 10% of 10000, plus the entry that triggered the cleanup.
    expect(getCacheStats().totalSize).toBe(9001);
    expect(getCachedTransform(WS, BOARD, 'item-0')).toBeNull();
    expect(getCachedTransform(WS, BOARD, 'item-999')).toBeNull();
    expect(getCachedTransform(WS, BOARD, 'item-1000')).toEqual(transformedRow({ id: 'item-1000' }));
    expect(getCachedTransform(WS, BOARD, 'item-10000')).toEqual(transformedRow({ id: 'item-10000' }));
  });
});

describe('getMultipleCachedTransforms', () => {
  it('returns only the items present in the cache, keyed by itemId', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow({ id: 'item-1' }));
    setCachedTransform(WS, BOARD, 'item-3', transformedRow({ id: 'item-3' }));

    const result = getMultipleCachedTransforms(WS, BOARD, [
      { itemId: 'item-1' },
      { itemId: 'item-2' },
      { itemId: 'item-3' },
    ]);

    expect(result).toBeInstanceOf(Map);
    expect([...result.keys()]).toEqual(['item-1', 'item-3']);
    expect(result.get('item-1')).toEqual(transformedRow({ id: 'item-1' }));
  });

  it('omits an item whose updatedAt is newer than its cache entry', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow({ id: 'item-1' }));
    setCachedTransform(WS, BOARD, 'item-2', transformedRow({ id: 'item-2' }));

    const result = getMultipleCachedTransforms(WS, BOARD, [
      { itemId: 'item-1', updatedAt: new Date(Date.now() + 60_000) },
      { itemId: 'item-2', updatedAt: new Date(Date.now() - 60_000) },
    ]);

    expect([...result.keys()]).toEqual(['item-2']);
    // The stale entry is evicted as a side effect of the lookup.
    expect(getCacheStats().totalSize).toBe(1);
  });

  it('returns an empty map for an empty item list', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());

    expect(getMultipleCachedTransforms(WS, BOARD, []).size).toBe(0);
  });

  it('does not read entries cached under a different board', () => {
    setCachedTransform(WS, 'other-board', 'item-1', transformedRow());

    expect(getMultipleCachedTransforms(WS, BOARD, [{ itemId: 'item-1' }]).size).toBe(0);
  });
});

describe('setMultipleCachedTransforms', () => {
  it('stores every item under its own key', () => {
    setMultipleCachedTransforms(WS, BOARD, [
      { itemId: 'item-1', data: transformedRow({ id: 'item-1' }) },
      { itemId: 'item-2', data: transformedRow({ id: 'item-2' }) },
    ]);

    expect(getCachedTransform(WS, BOARD, 'item-1')).toEqual(transformedRow({ id: 'item-1' }));
    expect(getCachedTransform(WS, BOARD, 'item-2')).toEqual(transformedRow({ id: 'item-2' }));
    expect(getCacheStats().totalSize).toBe(2);
  });

  it('applies the supplied TTL to every item', () => {
    setMultipleCachedTransforms(WS, BOARD, [
      { itemId: 'item-1', data: transformedRow({ id: 'item-1' }) },
      { itemId: 'item-2', data: transformedRow({ id: 'item-2' }) },
    ], -1);

    expect(getCachedTransform(WS, BOARD, 'item-1')).toBeNull();
    expect(getCachedTransform(WS, BOARD, 'item-2')).toBeNull();
  });

  it('stores nothing for an empty list', () => {
    setMultipleCachedTransforms(WS, BOARD, []);

    expect(getCacheStats().totalSize).toBe(0);
  });
});

describe('invalidateCacheForItem', () => {
  it('removes only the named item', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());
    setCachedTransform(WS, BOARD, 'item-2', transformedRow());

    invalidateCacheForItem(WS, BOARD, 'item-1');

    expect(getCachedTransform(WS, BOARD, 'item-1')).toBeNull();
    expect(getCachedTransform(WS, BOARD, 'item-2')).toEqual(transformedRow());
  });

  it('leaves the monthly-statement entries for the same item alone', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 1 });
    setCachedMSService(WS, BOARD, 'item-1', { service: 1 });

    invalidateCacheForItem(WS, BOARD, 'item-1');

    expect(getCachedTransform(WS, BOARD, 'item-1')).toBeNull();
    expect(getCachedMSBudget(WS, BOARD, 'item-1')).toEqual({ budget: 1 });
    expect(getCachedMSService(WS, BOARD, 'item-1')).toEqual({ service: 1 });
  });

  it('is a no-op for an item that was never cached', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());

    invalidateCacheForItem(WS, BOARD, 'item-missing');

    expect(getCacheStats().totalSize).toBe(1);
  });
});

describe('invalidateCacheForBoard', () => {
  it('removes every invoice entry for that board only', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());
    setCachedTransform(WS, BOARD, 'item-2', transformedRow());
    setCachedTransform(WS, 'other-board', 'item-3', transformedRow());
    setCachedTransform('other-ws', BOARD, 'item-4', transformedRow());

    invalidateCacheForBoard(WS, BOARD);

    expect(getCachedTransform(WS, BOARD, 'item-1')).toBeNull();
    expect(getCachedTransform(WS, BOARD, 'item-2')).toBeNull();
    expect(getCachedTransform(WS, 'other-board', 'item-3')).toEqual(transformedRow());
    expect(getCachedTransform('other-ws', BOARD, 'item-4')).toEqual(transformedRow());
  });

  it('does NOT clear monthly-statement entries for the board', () => {
    // The prefix is hard-coded to "transform:", so the ms-budget / ms-service
    // namespaces survive a board invalidation. syncWorker.js calls this after a
    // sync, which means monthly-statement data can stay stale.
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 1 });
    setCachedMSService(WS, BOARD, 'item-1', { service: 1 });

    invalidateCacheForBoard(WS, BOARD);

    expect(getCachedTransform(WS, BOARD, 'item-1')).toBeNull();
    expect(getCachedMSBudget(WS, BOARD, 'item-1')).toEqual({ budget: 1 });
    expect(getCachedMSService(WS, BOARD, 'item-1')).toEqual({ service: 1 });
  });

  it('matches on the full board segment, not a prefix of it', () => {
    setCachedTransform(WS, 'board-1', 'item-1', transformedRow());
    setCachedTransform(WS, 'board-10', 'item-1', transformedRow());

    invalidateCacheForBoard(WS, 'board-1');

    expect(getCachedTransform(WS, 'board-1', 'item-1')).toBeNull();
    expect(getCachedTransform(WS, 'board-10', 'item-1')).toEqual(transformedRow());
  });
});

describe('invalidateCacheForWorkspace', () => {
  it('removes every invoice entry for the workspace across boards', () => {
    setCachedTransform(WS, 'board-a', 'item-1', transformedRow());
    setCachedTransform(WS, 'board-b', 'item-2', transformedRow());
    setCachedTransform('other-ws', 'board-a', 'item-3', transformedRow());

    invalidateCacheForWorkspace(WS);

    expect(getCachedTransform(WS, 'board-a', 'item-1')).toBeNull();
    expect(getCachedTransform(WS, 'board-b', 'item-2')).toBeNull();
    expect(getCachedTransform('other-ws', 'board-a', 'item-3')).toEqual(transformedRow());
  });

  it('matches on the full workspace segment, not a prefix of it', () => {
    setCachedTransform('ws-1', BOARD, 'item-1', transformedRow());
    setCachedTransform('ws-10', BOARD, 'item-1', transformedRow());

    invalidateCacheForWorkspace('ws-1');

    expect(getCachedTransform('ws-1', BOARD, 'item-1')).toBeNull();
    expect(getCachedTransform('ws-10', BOARD, 'item-1')).toEqual(transformedRow());
  });

  it('leaves monthly-statement entries for the workspace in place', () => {
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 1 });

    invalidateCacheForWorkspace(WS);

    expect(getCachedMSBudget(WS, BOARD, 'item-1')).toEqual({ budget: 1 });
  });
});

describe('cleanupExpiredEntries', () => {
  it('removes expired entries and keeps live ones, across all namespaces', () => {
    setCachedTransform(WS, BOARD, 'live', transformedRow(), 60_000);
    setCachedTransform(WS, BOARD, 'dead', transformedRow(), -1);
    setCachedMSBudget(WS, BOARD, 'dead-budget', { budget: 1 }, -1);
    setCachedMSService(WS, BOARD, 'live-service', { service: 1 }, 60_000);

    expect(getCacheStats()).toMatchObject({ totalSize: 4, validEntries: 2, expiredEntries: 2 });

    cleanupExpiredEntries();

    expect(getCacheStats()).toMatchObject({ totalSize: 2, validEntries: 2, expiredEntries: 0 });
    expect(getCachedTransform(WS, BOARD, 'live')).toEqual(transformedRow());
    expect(getCachedMSService(WS, BOARD, 'live-service')).toEqual({ service: 1 });
  });

  it('is a no-op on an empty cache', () => {
    cleanupExpiredEntries();

    expect(getCacheStats().totalSize).toBe(0);
  });
});

describe('getCacheStats', () => {
  it('reports the configured bounds', () => {
    expect(getCacheStats()).toEqual({
      totalSize: 0,
      validEntries: 0,
      expiredEntries: 0,
      maxSize: 10_000,
      ttlMs: 1_800_000,
    });
  });

  it('counts expired entries without deleting them', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow(), -1);

    expect(getCacheStats()).toEqual({
      totalSize: 1,
      validEntries: 0,
      expiredEntries: 1,
      maxSize: 10_000,
      ttlMs: 1_800_000,
    });
    expect(getCacheStats().totalSize).toBe(1);
  });
});

describe('clearCache', () => {
  it('empties every namespace', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 1 });
    setCachedMSService(WS, BOARD, 'item-1', { service: 1 });

    clearCache();

    expect(getCacheStats().totalSize).toBe(0);
    expect(getCachedTransform(WS, BOARD, 'item-1')).toBeNull();
    expect(getCachedMSBudget(WS, BOARD, 'item-1')).toBeNull();
    expect(getCachedMSService(WS, BOARD, 'item-1')).toBeNull();
  });
});

describe('monthly statement cache', () => {
  it('keeps budget, service and invoice data for the same item apart', () => {
    setCachedTransform(WS, BOARD, 'item-1', { kind: 'invoice' });
    setCachedMSBudget(WS, BOARD, 'item-1', { kind: 'budget' });
    setCachedMSService(WS, BOARD, 'item-1', { kind: 'service' });

    expect(getCachedTransform(WS, BOARD, 'item-1')).toEqual({ kind: 'invoice' });
    expect(getCachedMSBudget(WS, BOARD, 'item-1')).toEqual({ kind: 'budget' });
    expect(getCachedMSService(WS, BOARD, 'item-1')).toEqual({ kind: 'service' });
    expect(getCacheStats().totalSize).toBe(3);
  });

  it('misses before the budget value is stored', () => {
    expect(getCachedMSBudget(WS, BOARD, 'item-1')).toBeNull();
  });

  it('misses before the service value is stored', () => {
    expect(getCachedMSService(WS, BOARD, 'item-1')).toBeNull();
  });

  it('expires budget entries on TTL and deletes them', () => {
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 1 }, -1);

    expect(getCachedMSBudget(WS, BOARD, 'item-1')).toBeNull();
    expect(getCacheStats().totalSize).toBe(0);
  });

  it('expires service entries on TTL and deletes them', () => {
    setCachedMSService(WS, BOARD, 'item-1', { service: 1 }, -1);

    expect(getCachedMSService(WS, BOARD, 'item-1')).toBeNull();
    expect(getCacheStats().totalSize).toBe(0);
  });

  it('evicts a budget entry whose item was updated after caching', () => {
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 1 });

    expect(getCachedMSBudget(WS, BOARD, 'item-1', new Date(Date.now() + 60_000))).toBeNull();
    expect(getCacheStats().totalSize).toBe(0);
  });

  it('evicts a service entry whose item was updated after caching', () => {
    setCachedMSService(WS, BOARD, 'item-1', { service: 1 });

    expect(getCachedMSService(WS, BOARD, 'item-1', new Date(Date.now() + 60_000))).toBeNull();
    expect(getCacheStats().totalSize).toBe(0);
  });

  it('keeps a budget entry whose item was updated before caching', () => {
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 1 });

    expect(getCachedMSBudget(WS, BOARD, 'item-1', new Date(Date.now() - 60_000))).toEqual({ budget: 1 });
  });

  it('keys monthly statement entries on workspace, board and item', () => {
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 'a' });
    setCachedMSBudget(WS, 'other-board', 'item-1', { budget: 'b' });

    expect(getCachedMSBudget(WS, BOARD, 'item-1')).toEqual({ budget: 'a' });
    expect(getCachedMSBudget(WS, 'other-board', 'item-1')).toEqual({ budget: 'b' });
  });
});

describe('invalidateMSCacheForItem', () => {
  it('removes both the budget and the service entry for the item', () => {
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 1 });
    setCachedMSService(WS, BOARD, 'item-1', { service: 1 });

    invalidateMSCacheForItem(WS, BOARD, 'item-1');

    expect(getCachedMSBudget(WS, BOARD, 'item-1')).toBeNull();
    expect(getCachedMSService(WS, BOARD, 'item-1')).toBeNull();
  });

  it('leaves the invoice entry and other items alone', () => {
    setCachedTransform(WS, BOARD, 'item-1', transformedRow());
    setCachedMSBudget(WS, BOARD, 'item-1', { budget: 1 });
    setCachedMSBudget(WS, BOARD, 'item-2', { budget: 2 });

    invalidateMSCacheForItem(WS, BOARD, 'item-1');

    expect(getCachedTransform(WS, BOARD, 'item-1')).toEqual(transformedRow());
    expect(getCachedMSBudget(WS, BOARD, 'item-2')).toEqual({ budget: 2 });
  });
});

describe('default export', () => {
  it('exposes the same functions as the named exports', () => {
    expect(transformCacheDefault.getCachedTransform).toBe(getCachedTransform);
    expect(transformCacheDefault.setCachedTransform).toBe(setCachedTransform);
    expect(transformCacheDefault.invalidateCacheForBoard).toBe(invalidateCacheForBoard);
    expect(transformCacheDefault.invalidateMSCacheForItem).toBe(invalidateMSCacheForItem);
    expect(Object.keys(transformCacheDefault)).toEqual([
      'getCachedTransform',
      'setCachedTransform',
      'getMultipleCachedTransforms',
      'setMultipleCachedTransforms',
      'invalidateCacheForItem',
      'invalidateCacheForBoard',
      'invalidateCacheForWorkspace',
      'cleanupExpiredEntries',
      'getCacheStats',
      'clearCache',
      'getCachedMSBudget',
      'setCachedMSBudget',
      'getCachedMSService',
      'setCachedMSService',
      'invalidateMSCacheForItem',
    ]);
  });
});
