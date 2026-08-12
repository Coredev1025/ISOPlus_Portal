import { describe, it, expect } from 'vitest';
import AutomationSettings from '../../../src/models/AutomationSettings.js';

describe('AutomationSettings', () => {
  it('defaults both blocks to disabled with a daily cadence', () => {
    const doc = new AutomationSettings({ workspaceId: 'ws-1' });
    expect(doc.invoice.enabled).toBe(false);
    expect(doc.statement.enabled).toBe(false);
    expect(doc.invoice.every.n).toBe(1);
    expect(doc.invoice.every.unit).toBe('month');
    expect(doc.invoice.senderIdentityId).toBeNull();
  });

  it('rejects a unit outside the five allowed values', async () => {
    const doc = new AutomationSettings({
      workspaceId: 'ws-1',
      invoice: { every: { n: 1, unit: 'fortnight' } },
    });
    await expect(doc.validate()).rejects.toThrow(/unit/);
  });

  it('requires workspaceId', async () => {
    const doc = new AutomationSettings({});
    await expect(doc.validate()).rejects.toThrow(/workspaceId/);
  });
});
