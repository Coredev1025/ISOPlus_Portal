import { describe, it, expect } from 'vitest';
import AuditTrail from '../../../src/models/AuditTrail.js';

describe('AuditTrail model', () => {
  it('requires workspaceId, action and detail', async () => {
    await expect(AuditTrail.create({})).rejects.toThrow();
  });

  it('creates with defaults', async () => {
    const row = await AuditTrail.create({
      workspaceId: 'ws',
      action: 'Login',
      detail: 'ok',
    });
    expect(row.success).toBe(true);
    expect(row.userIp).toBe('127.0.0.1');
  });
});
