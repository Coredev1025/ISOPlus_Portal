import { describe, expect, it } from 'vitest';
import {
  describeXeroLoadError,
  isCanceledError,
  isExpectedMissingIntegrationData,
  isXeroLoadTimeoutError,
  xeroOptionsLoadDescription,
} from '@/lib/xero-integration-errors';

describe('xero-integration-errors', () => {
  it('treats missing business and missing Xero integration as expected empty data', () => {
    expect(
      isExpectedMissingIntegrationData({
        response: { status: 404, data: { message: 'Business not found' } },
      })
    ).toBe(true);
    expect(
      isExpectedMissingIntegrationData({
        response: { status: 400, data: { message: 'Xero integration not found' } },
      })
    ).toBe(true);
    expect(
      isExpectedMissingIntegrationData({
        response: { status: 500, data: { message: 'Business not found' } },
      })
    ).toBe(false);
  });

  it('does not treat timeouts as expected empty data', () => {
    expect(
      isExpectedMissingIntegrationData({
        code: 'ECONNABORTED',
        message: 'timeout of 15000ms exceeded',
      })
    ).toBe(false);
    expect(isXeroLoadTimeoutError({ code: 'ECONNABORTED' })).toBe(true);
    expect(isXeroLoadTimeoutError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(
      isXeroLoadTimeoutError({
        response: { status: 504, data: { message: 'Gateway Timeout' } },
      })
    ).toBe(true);
    expect(describeXeroLoadError({ code: 'ECONNABORTED' })).toMatch(/timed out/i);
  });

  it('describes cancelled requests and missing option payloads', () => {
    expect(isCanceledError({ name: 'CanceledError' })).toBe(true);
    expect(isCanceledError({ name: 'AbortError' })).toBe(true);
    expect(isCanceledError({})).toBe(false);
    expect(describeXeroLoadError({})).toBe('Please try again later');
    expect(xeroOptionsLoadDescription({ code: 'ECONNABORTED' })).toMatch(/timed out/i);
    expect(xeroOptionsLoadDescription({ response: { data: { message: 'No org' } } })).toBe(
      'No org'
    );
    expect(xeroOptionsLoadDescription({})).toMatch(/Disconnect and Connect Xero/i);
  });
});
