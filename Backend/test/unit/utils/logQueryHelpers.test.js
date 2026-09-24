import { describe, it, expect } from 'vitest';
import { buildLogQuery } from '../../../src/utils/logQueryHelpers.js';

/**
 * KAN-267. Extracted from routes/log.js when the added filters pushed the
 * handler past the cognitive-complexity gate — which is the point of the
 * gate, and the filter is worth testing on its own anyway.
 */
describe('buildLogQuery', () => {
  it('asks for everything when nothing is supplied', () => {
    expect(buildLogQuery()).toEqual({});
    expect(buildLogQuery({ level: '', source: '', search: '' })).toEqual({});
  });

  // "all" is what the UI sends for an unset dropdown; it must not become a
  // literal filter for a source named "all".
  it('treats "all" as no filter', () => {
    expect(buildLogQuery({ level: 'all', source: 'all', workspaceId: 'all' })).toEqual({});
  });

  it('matches a level whole, not as a substring', () => {
    const q = buildLogQuery({ level: 'info' });
    expect(q.level.$regex.source).toBe('^info$');
    expect(q.level.$regex.flags).toContain('i');
  });

  /**
   * An id is a whole value. A regex here would make a search for workspace
   * '55515' also return '155515' — quietly mixing two clients' runs into one
   * diagnostic view, which is worse than finding nothing.
   */
  it('matches a workspace and board exactly, never as a regex', () => {
    const q = buildLogQuery({ workspaceId: '55515', boardId: 'oiGa5qGq1N6' });
    expect(q['metadata.workspaceId']).toBe('55515');
    expect(q['metadata.boardId']).toBe('oiGa5qGq1N6');
  });

  it('searches the fields that identify a run, not just the message', () => {
    const q = buildLogQuery({ search: '55515' });
    const fields = q.$or.map((clause) => Object.keys(clause)[0]);
    expect(fields).toEqual([
      'message',
      'metadata.source',
      'metadata.workspaceId',
      'metadata.boardId',
      'metadata.periodKey',
    ]);
  });

  // A period key contains no regex metacharacters, but a search box takes
  // anything — and an unescaped '(' is a crash, not a miss.
  it('escapes regex metacharacters in a search term', () => {
    const q = buildLogQuery({ search: 'a(b' });
    expect(() => new RegExp(q.$or[0].message)).not.toThrow();
    expect(q.$or[0].message.source).toBe('a\\(b');
  });

  it('combines a scope with a search rather than replacing it', () => {
    const q = buildLogQuery({ workspaceId: '55515', source: 'Automation', search: 'billable' });
    expect(q['metadata.workspaceId']).toBe('55515');
    expect(q['metadata.source']).toBeDefined();
    expect(q.$or).toHaveLength(5);
  });
});
