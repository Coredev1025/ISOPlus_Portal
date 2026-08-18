import { describe, it, expect } from 'vitest';

import { OUTPUT_TYPE } from '../../../src/constants/storage.js';
import { buildOutputKey } from '../../../src/utils/s3OutputKey.js';

describe('buildOutputKey', () => {
  it('lays a generated document out as output/<workspace>/<board>/<type>/<name>', () => {
    expect(buildOutputKey({
      workspaceId: '55390',
      boardId: 'jpjztrn14pJ',
      type: OUTPUT_TYPE.NDIS_INVOICE,
      name: 'INV-1004-ISO+™-Jane-Smith.pdf',
    })).toBe('output/55390/jpjztrn14pJ/NDIS-invoices/INV-1004-ISO+™-Jane-Smith.pdf');
  });

  it.each(Object.values(OUTPUT_TYPE))('keeps the %s folder inside the same three levels', (type) => {
    const key = buildOutputKey({ workspaceId: 'ws', boardId: 'bd', type, name: 'f.pdf' });
    expect(key.split('/').slice(0, 4)).toEqual(['output', 'ws', 'bd', type]);
  });

  it('refuses a missing segment rather than writing to a half-formed path', () => {
    // A blank workspace or board would collapse the key into output//bd/... —
    // every workspace's documents in one folder, which is the layout this
    // convention exists to prevent.
    expect(() => buildOutputKey({ workspaceId: '', boardId: 'bd', type: 'quote', name: 'f.pdf' }))
      .toThrow(/workspaceId/);
    expect(() => buildOutputKey({ workspaceId: 'ws', boardId: null, type: 'quote', name: 'f.pdf' }))
      .toThrow(/boardId/);
    expect(() => buildOutputKey({ workspaceId: 'ws', boardId: 'bd', type: 'quote', name: '' }))
      .toThrow(/name/);
  });

  it('cannot be walked out of its own folder by a crafted name', () => {
    // Names carry participant and item text from ISO+, so they are untrusted.
    const key = buildOutputKey({
      workspaceId: 'ws', boardId: 'bd', type: 'quote', name: '../../other-workspace/steal.pdf',
    });
    expect(key.startsWith('output/ws/bd/quote/')).toBe(true);
    expect(key).not.toContain('..');
  });

  it('does not let a segment smuggle in another path level', () => {
    const key = buildOutputKey({ workspaceId: 'ws/evil', boardId: 'bd', type: 'quote', name: 'f.pdf' });
    expect(key.split('/')).toHaveLength(5);
  });
});
