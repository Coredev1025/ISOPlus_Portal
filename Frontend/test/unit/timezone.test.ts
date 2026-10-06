import { describe, it, expect } from 'vitest';
import {
  getDateOnlyInTimeZone,
  dateOnlyToStartOfDayISO,
  dateOnlyToEndOfDayISO,
  formatDateDDMMYYYY,
  formatDateTimeDDMMYYYY,
} from '@/lib/timezone';

describe('timezone helpers', () => {
  it('formats date-only in a timezone', () => {
    const date = new Date('2024-01-15T12:00:00.000Z');
    expect(getDateOnlyInTimeZone(date, 'UTC')).toBe('2024-01-15');
  });

  it('builds start and end of day ISO strings', () => {
    const start = dateOnlyToStartOfDayISO('2024-06-01', 'UTC');
    const end = dateOnlyToEndOfDayISO('2024-06-01', 'UTC');
    expect(start).toMatch(/2024-06-01T00:00:00/);
    expect(end).toMatch(/2024-06-01T23:59:59/);
  });

  it('formats display dates', () => {
    expect(formatDateDDMMYYYY('2024-01-15T00:00:00.000Z', 'UTC')).toMatch(/15\/01\/2024/);
    expect(formatDateTimeDDMMYYYY('2024-01-15T10:30:00.000Z', 'UTC')).toMatch(/15\/01\/2024/);
    expect(formatDateDDMMYYYY(null, 'UTC')).toBe('');
    expect(formatDateTimeDDMMYYYY('not-a-date', 'UTC')).toBe('');
  });
});
