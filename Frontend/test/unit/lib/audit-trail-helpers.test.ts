import { describe, it, expect } from 'vitest';

import {
  normalizeAuditDetail,
  normalizeAuditDetailFromJson,
} from '@/lib/audit-trail-helpers';

/**
 * The backend writes `detail` two ways (Backend/src/utils/auditLogger.js):
 * a plain human string, or `JSON.stringify(detail)` truncated to 4000 chars
 * when the caller passed an object. Only the second form is re-formatted here.
 */
describe('normalizeAuditDetailFromJson', () => {
  it('summarises a successful request as OK with status and duration', () => {
    expect(
      normalizeAuditDetailFromJson(
        '{"statusCode":200,"durationMs":183.44219,"requestId":"3f0c1b2a","path":"/api/business/profile"}',
      ),
    ).toBe('OK status=200 durationMs=183.44');
  });

  it('summarises a 4xx as FAILED', () => {
    expect(normalizeAuditDetailFromJson('{"statusCode":404,"durationMs":12}')).toBe(
      'FAILED status=404 durationMs=12',
    );
  });

  it('treats 399 as OK and 400 as FAILED, matching the backend success boundary', () => {
    expect(normalizeAuditDetailFromJson('{"statusCode":399}')).toBe('OK status=399');
    expect(normalizeAuditDetailFromJson('{"statusCode":400}')).toBe('FAILED status=400');
  });

  it('rounds durationMs to two decimals, half up', () => {
    expect(normalizeAuditDetailFromJson('{"durationMs":12.3456}')).toBe('durationMs=12.35');
    expect(normalizeAuditDetailFromJson('{"durationMs":1234.5678}')).toBe('durationMs=1234.57');
    expect(normalizeAuditDetailFromJson('{"durationMs":12.005}')).toBe('durationMs=12.01');
  });

  it('keeps a zero statusCode and a zero durationMs, because both are numbers', () => {
    expect(normalizeAuditDetailFromJson('{"statusCode":0,"durationMs":0}')).toBe(
      'OK status=0 durationMs=0',
    );
  });

  it('omits the OK/FAILED word when statusCode is not a number', () => {
    expect(normalizeAuditDetailFromJson('{"statusCode":"200","durationMs":9.5}')).toBe(
      'durationMs=9.5',
    );
  });

  it('omits durationMs when it is not a number', () => {
    expect(normalizeAuditDetailFromJson('{"statusCode":201,"durationMs":null}')).toBe(
      'OK status=201',
    );
  });

  it('returns the original text when the JSON parses but carries neither field', () => {
    expect(
      normalizeAuditDetailFromJson('{"http":{"method":"POST","path":"/api/business/profile"}}'),
    ).toBe('{"http":{"method":"POST","path":"/api/business/profile"}}');
  });

  it('returns the original text when the JSON is a bare null or a bare string', () => {
    expect(normalizeAuditDetailFromJson('null')).toBe('null');
    expect(normalizeAuditDetailFromJson('"Business profile updated"')).toBe(
      '"Business profile updated"',
    );
  });

  it('returns the original text when parsing throws', () => {
    expect(normalizeAuditDetailFromJson('{statusCode: 200}')).toBe('{statusCode: 200}');
    expect(normalizeAuditDetailFromJson('Business profile updated')).toBe(
      'Business profile updated',
    );
  });
});

describe('normalizeAuditDetail', () => {
  it('returns a plain backend detail string untouched', () => {
    expect(
      normalizeAuditDetail({ detail: 'OK item=8842011 status=200 durationMs=183.44' }),
    ).toBe('OK item=8842011 status=200 durationMs=183.44');
  });

  it('summarises a detail that is a JSON object', () => {
    expect(
      normalizeAuditDetail({
        detail:
          '{"statusCode":500,"durationMs":4021.777,"requestId":"9a12","userEmail":"ops@hillsgrade.com.au"}',
      }),
    ).toBe('FAILED status=500 durationMs=4021.78');
  });

  it('returns an empty string when detail is missing, empty or the item itself is absent', () => {
    expect(normalizeAuditDetail({})).toBe('');
    expect(normalizeAuditDetail({ detail: '' })).toBe('');
    expect(normalizeAuditDetail({ detail: undefined })).toBe('');
    expect(normalizeAuditDetail(undefined as unknown as { detail?: string })).toBe('');
    expect(normalizeAuditDetail(null as unknown as { detail?: string })).toBe('');
  });

  it('does not treat a JSON object with surrounding whitespace as JSON', () => {
    expect(normalizeAuditDetail({ detail: ' {"statusCode":200,"durationMs":10} ' })).toBe(
      ' {"statusCode":200,"durationMs":10} ',
    );
  });

  it('does not treat a JSON array as JSON', () => {
    expect(normalizeAuditDetail({ detail: '[{"statusCode":200}]' })).toBe(
      '[{"statusCode":200}]',
    );
  });

  it('returns a JSON detail truncated by the backend verbatim, since it no longer ends in a brace', () => {
    // Backend truncate() cuts at 4000 chars and appends "...", so the closing
    // brace is gone and the string is never handed to JSON.parse.
    const truncated = `{"statusCode":200,"body":{"notes":"${'x'.repeat(3950)}...`;
    expect(normalizeAuditDetail({ detail: truncated })).toBe(truncated);
  });

  it('returns a very long non-JSON detail in full, without truncating or eliding it', () => {
    const longDetail = `Invoice generated successfully, invoice number: INV-1042 (ISO+™), participant: ${'Alexandra Vasilenko-Whitmore '.repeat(
      40,
    )}, items: 37`;
    expect(normalizeAuditDetail({ detail: longDetail })).toBe(longDetail);
    expect(normalizeAuditDetail({ detail: longDetail })).toContain('items: 37');
  });

  it('stringifies a non-string detail before inspecting it', () => {
    expect(normalizeAuditDetail({ detail: 12345 as unknown as string })).toBe('12345');
  });
});
