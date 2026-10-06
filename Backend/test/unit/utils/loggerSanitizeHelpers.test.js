import { describe, it, expect } from 'vitest';
import { Stream, Readable } from 'node:stream';
import { Socket } from 'node:net';
import {
  sanitizeArrayForStorage,
  isNonSerializableValue,
  sanitizeObjectEntriesForStorage,
  filterMetaForLog,
  buildRequestContext,
} from '../../../src/utils/loggerSanitizeHelpers.js';

// The real collaborators src/utils/logger.js injects. Kept identical so these
// tests characterise the helpers as they actually behave in production.
const EXCLUDED_FIELDS = new Set([
  'data',
  'result',
  'response',
  'request',
  'body',
  'payload',
  'items',
  'files',
  'buffer',
  'stream',
  'socket',
  'req',
  'res',
]);

function getObjectSize(obj) {
  try {
    return JSON.stringify(obj).length;
  } catch {
    return 0;
  }
}

function truncateString(str, maxLength) {
  if (typeof str !== 'string') return str;
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

function normalizeErrorMeta(err) {
  if (!err) return undefined;
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message, stack: err.stack };
  }
  return { errorMessage: String(err) };
}

// Records exactly what the helper handed down, so depth/path propagation is
// observable rather than inferred.
const tagged = (value, depth, path) => `${String(value)}|d${depth}|${path}`;
const captured = (value, depth, path) => ({ value, depth, path });
const identity = (value) => value;

// Mirrors logger.js's sanitizeMetadataForStorage wiring, used only to drive the
// two helpers recursively (deep nesting, circular graphs).
function makeRecursiveSanitizer({ maxDepth = 3, maxArrayLength = 10, maxMetadataSize = 50000 } = {}) {
  const fn = (obj, depth = 0, path = '') => {
    if (depth > maxDepth) return '[Max depth reached]';
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return sanitizeArrayForStorage(obj, depth, path, fn, maxArrayLength);
    return sanitizeObjectEntriesForStorage(obj, depth, path, {
      excludedFields: EXCLUDED_FIELDS,
      getObjectSize,
      maxMetadataSize,
      sanitizeFn: fn,
      normalizeErrorMeta,
    });
  };
  return fn;
}

describe('sanitizeArrayForStorage', () => {
  it('sanitizes each element one level deeper with an indexed path', () => {
    expect(sanitizeArrayForStorage(['a', 'b'], 0, 'meta.tags', tagged, 10)).toEqual([
      'a|d1|meta.tags[0]',
      'b|d1|meta.tags[1]',
    ]);
  });

  it('keeps counting depth from the depth it was given', () => {
    expect(sanitizeArrayForStorage(['a'], 2, 'meta.a.b', tagged, 10)).toEqual(['a|d3|meta.a.b[0]']);
  });

  it('truncates past the limit and appends the remaining-count marker', () => {
    const result = sanitizeArrayForStorage(['a', 'b', 'c', 'd', 'e'], 0, 'meta.items', tagged, 2);

    expect(result).toEqual(['a|d1|meta.items[0]', 'b|d1|meta.items[1]', '[3 more items...]']);
  });

  it('does not truncate an array exactly at the limit', () => {
    const result = sanitizeArrayForStorage(['a', 'b', 'c'], 0, 'meta', identity, 3);

    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('returns only the marker when the limit is zero', () => {
    expect(sanitizeArrayForStorage(['a', 'b'], 0, 'meta', identity, 0)).toEqual(['[2 more items...]']);
  });

  it('returns an empty array unchanged', () => {
    expect(sanitizeArrayForStorage([], 0, 'meta', identity, 10)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c'];
    sanitizeArrayForStorage(input, 0, 'meta', tagged, 1);

    expect(input).toEqual(['a', 'b', 'c']);
  });
});

describe('isNonSerializableValue', () => {
  it('flags functions', () => {
    expect(isNonSerializableValue(function namedFn() {})).toBe(true);
    expect(isNonSerializableValue(() => {})).toBe(true);
  });

  it('flags Buffers', () => {
    expect(isNonSerializableValue(Buffer.from('report.pdf contents'))).toBe(true);
  });

  it('flags objects whose constructor is named Stream or Socket', () => {
    expect(isNonSerializableValue(new Stream())).toBe(true);
    expect(isNonSerializableValue(new Socket())).toBe(true);
  });

  it('does not flag ordinary metadata values', () => {
    expect(isNonSerializableValue({ workspaceId: 'ws-1', boardId: 'b-1' })).toBe(false);
    expect(isNonSerializableValue([1, 2, 3])).toBe(false);
    expect(isNonSerializableValue('a string')).toBe(false);
    expect(isNonSerializableValue(42)).toBe(false);
    expect(isNonSerializableValue(true)).toBe(false);
    expect(isNonSerializableValue(new Date('2026-03-01T00:00:00.000Z'))).toBe(false);
  });

  it('returns the nullish value itself rather than false for null/undefined', () => {
    expect(isNonSerializableValue(null)).toBeNull();
    expect(isNonSerializableValue(undefined)).toBeUndefined();
  });

  it('does not flag a stream subclass such as Readable — only the exact names match', () => {
    expect(isNonSerializableValue(new Readable({ read() {} }))).toBe(false);
  });

  it('tolerates a prototype-less object', () => {
    expect(isNonSerializableValue(Object.create(null))).toBeFalsy();
  });
});

describe('sanitizeObjectEntriesForStorage', () => {
  const baseOpts = {
    excludedFields: EXCLUDED_FIELDS,
    getObjectSize,
    maxMetadataSize: 50000,
    sanitizeFn: identity,
    normalizeErrorMeta,
  };

  it('sanitizes each value one level deeper with a dotted path', () => {
    const result = sanitizeObjectEntriesForStorage(
      { workspaceId: 'ws-1', boardId: 'b-9' },
      0,
      'meta',
      { ...baseOpts, sanitizeFn: tagged },
    );

    expect(result).toEqual({
      workspaceId: 'ws-1|d1|meta.workspaceId',
      boardId: 'b-9|d1|meta.boardId',
    });
  });

  it('replaces every excluded field with the exclusion marker and drops its value', () => {
    const secretish = 'SECRET-PAYLOAD-VALUE';
    const input = {
      data: secretish,
      result: secretish,
      response: secretish,
      request: secretish,
      body: secretish,
      payload: secretish,
      items: secretish,
      files: secretish,
      buffer: secretish,
      stream: secretish,
      socket: secretish,
      req: secretish,
      res: secretish,
      keptField: 'visible',
    };

    const result = sanitizeObjectEntriesForStorage(input, 0, 'meta', baseOpts);

    for (const key of EXCLUDED_FIELDS) {
      expect(result[key]).toBe('[Excluded - too large]');
    }
    expect(result.keptField).toBe('visible');
    expect(JSON.stringify(result)).not.toContain(secretish);
  });

  it('matches excluded field names case-insensitively', () => {
    const result = sanitizeObjectEntriesForStorage(
      { Body: 'x-www-form payload', RESPONSE: 'big', ReQ: 'the request' },
      0,
      'meta',
      baseOpts,
    );

    expect(result).toEqual({
      Body: '[Excluded - too large]',
      RESPONSE: '[Excluded - too large]',
      ReQ: '[Excluded - too large]',
    });
  });

  it('replaces non-serializable values with a constructor-name marker', () => {
    const result = sanitizeObjectEntriesForStorage(
      {
        callback: () => {},
        pdfBytes: Buffer.from('%PDF-1.4'),
        upstream: new Stream(),
      },
      0,
      'meta',
      baseOpts,
    );

    expect(result).toEqual({
      callback: '[Function]',
      pdfBytes: '[Buffer]',
      upstream: '[Stream]',
    });
  });

  it('falls back to [Non-serializable] when the value has no constructor', () => {
    const orphan = () => {};
    Object.setPrototypeOf(orphan, null);

    const result = sanitizeObjectEntriesForStorage({ orphan }, 0, 'meta', baseOpts);

    expect(result).toEqual({ orphan: '[Non-serializable]' });
  });

  it('normalizes an Error value before sanitizing it', () => {
    const err = new TypeError('board 42 is not an object');
    const result = sanitizeObjectEntriesForStorage({ err }, 0, 'meta', {
      ...baseOpts,
      sanitizeFn: captured,
    });

    expect(result.err.depth).toBe(1);
    expect(result.err.path).toBe('meta.err');
    expect(result.err.value.errorName).toBe('TypeError');
    expect(result.err.value.errorMessage).toBe('board 42 is not an object');
    expect(result.err.value).not.toBeInstanceOf(Error);
  });

  it('stops at the metadata size limit and records the truncation marker', () => {
    // getObjectSize({ a: '1234567890' }) === '{"a":"1234567890"}'.length === 18
    // getObjectSize({ b: 'x' })          === '{"b":"x"}'.length          ===  9
    const result = sanitizeObjectEntriesForStorage(
      { a: '1234567890', b: 'x', c: 'y' },
      0,
      'meta',
      { ...baseOpts, maxMetadataSize: 20 },
    );

    expect(result).toEqual({ a: '1234567890', _truncated: '[Metadata size limit reached]' });
    expect('b' in result).toBe(false);
    expect('c' in result).toBe(false);
  });

  it('keeps a field whose size lands exactly on the limit', () => {
    const result = sanitizeObjectEntriesForStorage({ a: '1234567890' }, 0, 'meta', {
      ...baseOpts,
      maxMetadataSize: 18,
    });

    expect(result).toEqual({ a: '1234567890' });
  });

  it('truncates immediately when even the first field is over the limit', () => {
    const result = sanitizeObjectEntriesForStorage({ a: '1234567890' }, 0, 'meta', {
      ...baseOpts,
      maxMetadataSize: 17,
    });

    expect(result).toEqual({ _truncated: '[Metadata size limit reached]' });
  });

  it('abandons the remaining fields once the limit is hit, even ones that would still fit', () => {
    // getObjectSize({ a: '1234567890' })  === 18  -> kept, running total 18
    // getObjectSize({ big: 'x'.repeat(30) }) === 40  -> 18 + 40 > 30, stop here
    // getObjectSize({ c: 'y' })           ===  9  -> would still fit, but is never reached
    const result = sanitizeObjectEntriesForStorage(
      { a: '1234567890', big: 'x'.repeat(30), c: 'y' },
      0,
      'meta',
      { ...baseOpts, maxMetadataSize: 30 },
    );

    expect(result).toEqual({ a: '1234567890', _truncated: '[Metadata size limit reached]' });
    expect('c' in result).toBe(false);
  });

  it('does not charge excluded fields against the size budget', () => {
    const result = sanitizeObjectEntriesForStorage(
      { body: 'x'.repeat(5000), a: '1234567890', b: 'x' },
      0,
      'meta',
      { ...baseOpts, maxMetadataSize: 20 },
    );

    expect(result).toEqual({
      body: '[Excluded - too large]',
      a: '1234567890',
      _truncated: '[Metadata size limit reached]',
    });
  });

  it('returns an empty object for an empty input', () => {
    expect(sanitizeObjectEntriesForStorage({}, 0, 'meta', baseOpts)).toEqual({});
  });

  it('does not mutate the input object', () => {
    const input = { body: 'big', workspaceId: 'ws-1' };
    sanitizeObjectEntriesForStorage(input, 0, 'meta', baseOpts);

    expect(input).toEqual({ body: 'big', workspaceId: 'ws-1' });
  });
});

describe('sanitizeObjectEntriesForStorage + sanitizeArrayForStorage recursion', () => {
  it('walks deeply nested objects and arrays, cutting off past the depth limit', () => {
    const sanitize = makeRecursiveSanitizer();

    const result = sanitize(
      {
        workspaceId: 'ws-1',
        level1: {
          level2: {
            level3: {
              level4: 'too deep',
            },
          },
        },
        rows: [{ id: 'r1' }, { id: 'r2' }],
      },
      0,
      'meta',
    );

    expect(result.workspaceId).toBe('ws-1');
    expect(result.level1.level2.level3.level4).toBe('[Max depth reached]');
    expect(result.rows).toEqual([{ id: 'r1' }, { id: 'r2' }]);
  });

  it('truncates a long nested array through the array helper', () => {
    const sanitize = makeRecursiveSanitizer({ maxArrayLength: 3 });

    const result = sanitize({ itemIds: ['a', 'b', 'c', 'd', 'e', 'f'] }, 0, 'meta');

    expect(result.itemIds).toEqual(['a', 'b', 'c', '[3 more items...]']);
  });

  it('survives a circular reference by bottoming out at the depth limit', () => {
    const sanitize = makeRecursiveSanitizer();
    const node = { name: 'root' };
    node.self = node;

    const result = sanitize(node, 0, 'meta');

    expect(result).toEqual({
      name: 'root',
      self: {
        name: 'root',
        self: {
          name: 'root',
          self: { name: '[Max depth reached]', self: '[Max depth reached]' },
        },
      },
    });
  });

  it('survives a circular reference reached through an array', () => {
    const sanitize = makeRecursiveSanitizer();
    const board = { boardId: 'b-1' };
    board.children = [board];

    const result = sanitize(board, 0, 'meta');

    expect(result).toEqual({
      boardId: 'b-1',
      children: [{ boardId: 'b-1', children: ['[Max depth reached]'] }],
    });
  });

  it('excludes a nested field named like an excluded key at any depth', () => {
    const sanitize = makeRecursiveSanitizer();
    const secretish = 'PATIENT-RECORD-BLOB';

    const result = sanitize({ outer: { inner: { body: secretish } } }, 0, 'meta');

    expect(result.outer.inner.body).toBe('[Excluded - too large]');
    expect(JSON.stringify(result)).not.toContain(secretish);
  });
});

describe('filterMetaForLog', () => {
  const opts = { excludedFields: EXCLUDED_FIELDS, getObjectSize, maxMetadataSize: 20 };

  it('drops excluded keys entirely instead of marking them', () => {
    const secretish = 'RAW-REQUEST-BODY';
    const result = filterMetaForLog(
      { body: secretish, response: secretish, workspaceId: 'ws-1', boardId: 'b-1' },
      opts,
    );

    expect(result).toEqual({ workspaceId: 'ws-1', boardId: 'b-1' });
    expect('body' in result).toBe(false);
    expect('response' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secretish);
  });

  it('drops excluded keys case-insensitively', () => {
    expect(filterMetaForLog({ Payload: 'x', FILES: 'y', ok: 1 }, opts)).toEqual({ ok: 1 });
  });

  it('replaces an oversized object with a placeholder', () => {
    // getObjectSize({ x: '123456789' }) === 17, threshold is 20 / 2 === 10
    const result = filterMetaForLog({ detail: { x: '123456789' } }, opts);

    expect(result).toEqual({ detail: '[Object too large to store]' });
  });

  it('replaces an oversized array with a counted placeholder', () => {
    // getObjectSize([1,2,3,4,5]) === '[1,2,3,4,5]'.length === 11 > 10
    const result = filterMetaForLog({ ids: [1, 2, 3, 4, 5] }, opts);

    expect(result).toEqual({ ids: '[Array with 5 items - too large to store]' });
  });

  it('keeps an object whose size lands exactly on half the limit', () => {
    // getObjectSize({ x: 1 }) === '{"x":1}'.length === 7, threshold 14 / 2 === 7
    const result = filterMetaForLog(
      { small: { x: 1 } },
      { ...opts, maxMetadataSize: 14 },
    );

    expect(result).toEqual({ small: { x: 1 } });
  });

  it('passes null through as a value rather than treating it as an object', () => {
    expect(filterMetaForLog({ notes: null }, opts)).toEqual({ notes: null });
    // getObjectSize(null) === 'null'.length === 4, which is over this threshold
    // of 6 / 2 === 3 — null survives only because of the explicit null guard.
    expect(filterMetaForLog({ notes: null }, { ...opts, maxMetadataSize: 6 })).toEqual({
      notes: null,
    });
  });

  it('passes primitives through untouched, however long', () => {
    const longString = 'y'.repeat(400);
    const result = filterMetaForLog({ msg: longString, count: 7, ok: false }, opts);

    expect(result).toEqual({ msg: longString, count: 7, ok: false });
  });

  it('returns an empty object for null or undefined meta', () => {
    expect(filterMetaForLog(null, opts)).toEqual({});
    expect(filterMetaForLog(undefined, opts)).toEqual({});
    expect(filterMetaForLog({}, opts)).toEqual({});
  });

  it('passes a circular object straight through, because its measured size is zero', () => {
    const node = { boardId: 'b-1' };
    node.self = node;

    const result = filterMetaForLog({ node }, opts);

    expect(result.node).toBe(node);
  });

  it('does not mutate the input meta', () => {
    const meta = { body: 'big', ids: [1, 2, 3, 4, 5] };
    filterMetaForLog(meta, opts);

    expect(meta).toEqual({ body: 'big', ids: [1, 2, 3, 4, 5] });
  });
});

describe('buildRequestContext', () => {
  it('returns an empty object when the context has no HTTP method', () => {
    expect(
      buildRequestContext(
        { url: '/api/workspaces/ws-1/boards', workspaceId: 'ws-1', requestId: 'r-1' },
        { workspaceId: 'ws-2' },
        truncateString,
      ),
    ).toEqual({});
    expect(buildRequestContext({}, {}, truncateString)).toEqual({});
  });

  it('builds the full request context from the request-scoped values', () => {
    const result = buildRequestContext(
      {
        method: 'POST',
        url: '/api/workspaces/ws-1/boards/b-9/invoice',
        workspaceId: 'ws-1',
        boardId: 'b-9',
        requestId: 'req_1750000000_abcdefghi',
        userAction: 'generate-invoice',
        ip: '203.0.113.4',
        email: 'carer@example.com',
      },
      { workspaceId: 'ws-ignored', boardId: 'b-ignored' },
      truncateString,
    );

    expect(result).toEqual({
      method: 'POST',
      url: '/api/workspaces/ws-1/boards/b-9/invoice',
      workspaceId: 'ws-1',
      boardId: 'b-9',
      requestId: 'req_1750000000_abcdefghi',
      userAction: 'generate-invoice',
    });
  });

  it('falls back to the metadata workspace and board ids', () => {
    const result = buildRequestContext(
      { method: 'GET', url: '/api/items' },
      { workspaceId: 'ws-from-meta', boardId: 'b-from-meta' },
      truncateString,
    );

    expect(result.workspaceId).toBe('ws-from-meta');
    expect(result.boardId).toBe('b-from-meta');
  });

  it('truncates the url at 200 characters', () => {
    const longUrl = `/api/x?q=${'y'.repeat(300)}`;
    const result = buildRequestContext({ method: 'GET', url: longUrl }, {}, truncateString);

    expect(result.url).toHaveLength(200);
    expect(result.url).toBe(`/api/x?q=${'y'.repeat(188)}...`);
  });

  it('substitutes an empty string for a missing url', () => {
    expect(buildRequestContext({ method: 'GET' }, {}, truncateString).url).toBe('');
  });

  it('always emits the same six keys', () => {
    const result = buildRequestContext({ method: 'DELETE' }, {}, truncateString);

    expect(Object.keys(result)).toEqual([
      'method',
      'url',
      'workspaceId',
      'boardId',
      'requestId',
      'userAction',
    ]);
    expect(result.requestId).toBeUndefined();
    expect(result.userAction).toBeUndefined();
  });
});
