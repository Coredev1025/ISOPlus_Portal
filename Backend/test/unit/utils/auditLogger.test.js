import { describe, it, expect } from 'vitest';
import { logAuditTrail } from '../../../src/utils/auditLogger.js';
import AuditTrail from '../../../src/models/AuditTrail.js';

describe('logAuditTrail', () => {
  it('persists a valid audit trail document', async () => {
    await logAuditTrail({
      workspaceId: 'ws-1',
      boardId: 'b-1',
      action: 'Updated board',
      detail: 'changed label',
      success: true,
      statusCode: 200,
    });
    const rows = await AuditTrail.find({ workspaceId: 'ws-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('Updated board');
    expect(rows[0].detail).toBe('changed label');
  });

  it('does not throw when workspaceId is missing', async () => {
    await expect(logAuditTrail({ action: 'x' })).resolves.toBeUndefined();
    const count = await AuditTrail.countDocuments();
    expect(count).toBe(0);
  });
});
