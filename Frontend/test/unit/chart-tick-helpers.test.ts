import { describe, it, expect } from 'vitest';
import { wrapChartTickSegment } from '@/lib/chart-tick-helpers';

describe('wrapChartTickSegment', () => {
  it('returns short segment unchanged', () => {
    expect(wrapChartTickSegment('hello', 20)).toEqual(['hello']);
  });

  it('wraps long text into multiple lines', () => {
    const lines = wrapChartTickSegment('one two three four five', 8);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toContain('one');
  });
});
