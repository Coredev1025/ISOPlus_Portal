import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getValidationRulesForLabel, validateBoard } from '../../../src/services/sync/validator.js';

vi.mock('../../../src/services/isoplus.js', () => ({
  getFolder: vi.fn(),
}));

import { getFolder } from '../../../src/services/isoplus.js';

describe('getValidationRulesForLabel', () => {
  it('returns specific rules for known labels', () => {
    const rules = getValidationRulesForLabel('NDIS');
    expect(rules.requiredFolders).toContain('Participants');
  });

  it('falls back to Default for unknown labels', () => {
    const rules = getValidationRulesForLabel('Unknown Label');
    expect(rules.requiredFolders).toEqual([]);
  });
});

describe('validateBoard', () => {
  beforeEach(() => {
    getFolder.mockReset();
  });

  it('returns valid with warning when no required rules', async () => {
    const result = await validateBoard('ws', 'b1', 'Default');
    expect(result.isValid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(getFolder).not.toHaveBeenCalled();
  });

  it('fails when required folders are missing', async () => {
    getFolder.mockResolvedValue({ status: 200, folder: [{ name: 'Archive' }] });
    const result = await validateBoard('ws', 'b1', 'NDIS');
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => /Participants/.test(e))).toBe(true);
  });

  it('passes when required folders exist', async () => {
    getFolder.mockResolvedValue({
      status: 200,
      folder: [{ name: 'Participants' }, { name: 'Service Plans' }],
    });
    const result = await validateBoard('ws', 'b1', 'NDIS');
    expect(result.isValid).toBe(true);
  });

  it('returns failure when folder fetch fails', async () => {
    getFolder.mockResolvedValue({ status: 500 });
    const result = await validateBoard('ws', 'b1', 'NDIS');
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/Validation failed/);
  });
});
