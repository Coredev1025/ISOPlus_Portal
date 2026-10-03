import { describe, it, expect } from 'vitest';
import { attributeText } from '../../../src/utils/attributeText.js';

// KAN-298. Profile attributes reach documents as printed text. A dropdown
// (select) attribute such as State is stored as an object, {id, name, color},
// and turning that into a string with String() prints "[object Object]".
describe('attributeText', () => {
  it('returns plain text trimmed', () => {
    expect(attributeText('  5 Client Rd ')).toBe('5 Client Rd');
  });

  it('prints a number as its digits', () => {
    expect(attributeText(5001)).toBe('5001');
  });

  it.each([null, undefined, '', '   '])('is empty for %j', (value) => {
    expect(attributeText(value)).toBe('');
  });

  it('prints the name of a select value', () => {
    expect(attributeText({ id: 'uuid-1', name: 'NSW', color: '#FFFFFF' })).toBe('NSW');
  });

  it('prints the names of a list of select values, and nothing for an empty list', () => {
    expect(attributeText([{ id: 'uuid-1', name: 'NSW' }])).toBe('NSW');
    expect(attributeText([{ name: 'NSW' }, { name: 'VIC' }])).toBe('NSW, VIC');
    expect(attributeText([])).toBe('');
  });

  it('falls back to label, then value', () => {
    expect(attributeText({ label: 'Victoria' })).toBe('Victoria');
    expect(attributeText({ value: 'QLD' })).toBe('QLD');
  });

  // The whole point: whatever the shape, a document never prints this.
  it.each([
    [{}],
    [[{}]],
    [{ color: '#FFFFFF' }],
    [{ nested: { name: 'x' } }],
    [[[], {}]],
  ])('never returns "[object Object]" for %j', (value) => {
    expect(attributeText(value)).not.toContain('[object Object]');
    expect(attributeText(value)).toBe('');
  });
});
