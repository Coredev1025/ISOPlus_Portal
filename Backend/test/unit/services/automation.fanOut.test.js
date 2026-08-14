import { describe, it, expect } from 'vitest';
import { KIND_INVOICE, KIND_STATEMENT } from '../../../src/constants/automation.js';
import { buildFanOutSpecs } from '../../../src/services/automation/fanOut.js';

const TZ = 'Australia/Sydney';
const slot = new Date('2026-08-11T23:00:00Z'); // 09:00 on the 12th, Sydney
const boards = [{ boardId: 'b1' }, { boardId: 'b2' }];

describe('buildFanOutSpecs', () => {
  it('produces one spec per board', () => {
    const specs = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    expect(specs).toHaveLength(2);
    expect(specs[0].data).toMatchObject({ workspaceId: 'ws-1', boardId: 'b1' });
  });

  it('keys each job on board and period', () => {
    const [first] = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    expect(first.opts.jobId).toBe('inv:b1:20260812-0900');
  });

  it('is stable — the same slot yields the same jobIds', () => {
    const a = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    const b = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot: new Date(slot), timezone: TZ });
    expect(b.map((s) => s.opts.jobId)).toEqual(a.map((s) => s.opts.jobId));
  });

  it('does not collide invoice with statement on the same slot and board', () => {
    const [inv] = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    const [stmt] = buildFanOutSpecs({ kind: KIND_STATEMENT, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    expect(inv.opts.jobId).not.toBe(stmt.opts.jobId);
    expect(stmt.opts.jobId).toBe('stmt:b1:20260812-0900');
  });

  it('returns an empty array when the workspace has no boards', () => {
    expect(buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards: [], slot, timezone: TZ })).toEqual([]);
  });
});
