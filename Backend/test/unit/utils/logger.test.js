import { describe, it, expect } from 'vitest';
import { extractContextFromReq, info, warn, error, debug } from '../../../src/utils/logger.js';

describe('extractContextFromReq', () => {
  it('extracts request metadata safely', () => {
    const ctx = extractContextFromReq({
      requestId: 'r1',
      method: 'GET',
      originalUrl: '/api/x',
      ip: '127.0.0.1',
      user: { userId: 'u1', email: 'a@b.com', role: 'owner' },
      params: { workspaceId: 'ws', boardId: 'b' },
    });
    expect(ctx.requestId).toBe('r1');
    expect(ctx.method).toBe('GET');
    expect(ctx.userId).toBe('u1');
  });

  it('handles null req', () => {
    expect(extractContextFromReq(null)).toEqual({});
  });
});

describe('logger helpers', () => {
  it('invoke without throwing', () => {
    expect(() => info('T', 'msg', {})).not.toThrow();
    expect(() => warn('T', 'msg', {})).not.toThrow();
    expect(() => error('T', 'msg', {})).not.toThrow();
    expect(() => debug('T', 'msg', {})).not.toThrow();
  });
});
