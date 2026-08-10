import { describe, it, expect } from 'vitest';
import {
  parseXeroValidationErrors,
  buildXeroContactErrorMessage,
} from '../../../src/utils/xeroContactErrorHelpers.js';

const MESSAGE_PREFIX = 'Error creating or updating contact in Xero';

/**
 * A Xero Accounting API validation body, shaped the way the API really returns
 * it for POST /Contacts (ErrorNumber/Type/Message at the top, the rejected
 * entities under Elements, each carrying its own ValidationErrors array).
 */
function validationBody(overrides = {}) {
  return {
    ErrorNumber: 10,
    Type: 'ValidationException',
    Message: 'A validation exception occurred',
    Elements: [
      {
        ContactID: '00000000-0000-0000-0000-000000000000',
        Name: 'Jane Doe',
        EmailAddress: 'not-an-email',
        ContactStatus: 'ACTIVE',
        HasValidationErrors: true,
        ValidationErrors: [{ Message: 'Email address must be valid.' }],
      },
    ],
    ...overrides,
  };
}

/**
 * The error object xero-node throws: an Error carrying the raw HTTP response
 * under `response` (statusCode + parsed or raw body + headers).
 */
function xeroError({ statusCode, body, message = 'HTTP request failed' }) {
  const err = new Error(message);
  err.response = {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  };
  return err;
}

describe('parseXeroValidationErrors', () => {
  it('joins every validation message across every element with "; "', () => {
    const body = validationBody({
      Elements: [
        {
          Name: 'Jane Doe',
          HasValidationErrors: true,
          ValidationErrors: [
            { Message: 'Email address must be valid.' },
            { Message: 'Contact Name must be unique across all active contacts.' },
          ],
        },
        {
          Name: 'John Doe',
          HasValidationErrors: true,
          ValidationErrors: [{ Message: 'Account Number must be unique.' }],
        },
      ],
    });

    expect(parseXeroValidationErrors(body)).toBe(
      'Email address must be valid.; Contact Name must be unique across all active contacts.; Account Number must be unique.',
    );
  });

  it('returns an empty string when the body is a different Xero exception type', () => {
    const body = {
      ErrorNumber: 14,
      Type: 'PostDataInvalidException',
      Message: 'Invalid post data',
      Elements: [{ ValidationErrors: [{ Message: 'ignored because Type is wrong' }] }],
    };

    expect(parseXeroValidationErrors(body)).toBe('');
  });

  it('returns an empty string when Elements is missing or empty', () => {
    expect(parseXeroValidationErrors({ Type: 'ValidationException', Message: 'x' })).toBe('');
    expect(parseXeroValidationErrors({ Type: 'ValidationException', Elements: [] })).toBe('');
  });

  it('returns an empty string for nullish input', () => {
    expect(parseXeroValidationErrors(null)).toBe('');
    expect(parseXeroValidationErrors(undefined)).toBe('');
  });

  it('skips elements without ValidationErrors and drops blank messages', () => {
    const body = validationBody({
      Elements: [
        { Name: 'No errors here', HasValidationErrors: false },
        { Name: 'Jane Doe', ValidationErrors: [{ Message: '' }, { Message: 'Real problem.' }] },
      ],
    });

    expect(parseXeroValidationErrors(body)).toBe('Real problem.');
  });

  it('returns an empty string when every message is blank', () => {
    const body = validationBody({
      Elements: [{ Name: 'Jane Doe', ValidationErrors: [{ Message: '' }, {}] }],
    });

    expect(parseXeroValidationErrors(body)).toBe('');
  });
});

describe('buildXeroContactErrorMessage', () => {
  it('returns the scope-specific message for HTTP 403 and ignores the body', () => {
    const err = xeroError({ statusCode: 403, body: validationBody() });

    expect(buildXeroContactErrorMessage(err)).toBe(
      `${MESSAGE_PREFIX}: Permission denied. Ensure your app has accounting.contacts scope.`,
    );
  });

  it('returns the re-authentication message for HTTP 401 and ignores the body', () => {
    const err = xeroError({ statusCode: 401, body: validationBody() });

    expect(buildXeroContactErrorMessage(err)).toBe(
      `${MESSAGE_PREFIX}: Authentication expired. Please re-authenticate.`,
    );
  });

  it('includes the status, the validation detail and the raw body for a 400', () => {
    const body = validationBody();
    const err = xeroError({ statusCode: 400, body });

    expect(buildXeroContactErrorMessage(err)).toBe(
      `${MESSAGE_PREFIX} [HTTP 400]. Email address must be valid.`
        + ` Xero API response: ${JSON.stringify(body)}`,
    );
  });

  it('parses a JSON string body and echoes it back re-serialised without whitespace', () => {
    const body = validationBody();
    const err = xeroError({ statusCode: 400, body: JSON.stringify(body, null, 2) });

    const message = buildXeroContactErrorMessage(err);

    expect(message).toBe(
      `${MESSAGE_PREFIX} [HTTP 400]. Email address must be valid.`
        + ` Xero API response: ${JSON.stringify(body)}`,
    );
    expect(message).not.toContain('\n');
  });

  it('falls back to err.message and echoes a non-JSON string body verbatim', () => {
    const err = xeroError({
      statusCode: 502,
      body: '<html><body>502 Bad Gateway</body></html>',
      message: 'Request failed with status code 502',
    });

    expect(buildXeroContactErrorMessage(err)).toBe(
      `${MESSAGE_PREFIX} [HTTP 502]. Request failed with status code 502`
        + ' Xero API response: <html><body>502 Bad Gateway</body></html>',
    );
  });

  it('omits the status and the API response when the error carries no HTTP response', () => {
    expect(buildXeroContactErrorMessage(new Error('socket hang up'))).toBe(
      `${MESSAGE_PREFIX}. socket hang up`,
    );
  });

  it('trims to the bare prefix when there is no status, body or message', () => {
    expect(buildXeroContactErrorMessage({})).toBe(`${MESSAGE_PREFIX}.`);
  });

  it('falls back to err.body when response.body is null', () => {
    const err = new Error('Request failed');
    err.response = { statusCode: 400, body: null };
    err.body = validationBody();

    expect(buildXeroContactErrorMessage(err)).toBe(
      `${MESSAGE_PREFIX} [HTTP 400]. Email address must be valid.`
        + ` Xero API response: ${JSON.stringify(err.body)}`,
    );
  });

  it('uses err.message as the detail when a 500 body carries no validation errors', () => {
    const body = {
      ErrorNumber: 500,
      Type: 'InternalServerException',
      Message: 'An unexpected error occurred',
    };
    const err = xeroError({ statusCode: 500, body, message: 'Internal Server Error' });

    expect(buildXeroContactErrorMessage(err)).toBe(
      `${MESSAGE_PREFIX} [HTTP 500]. Internal Server Error`
        + ` Xero API response: ${JSON.stringify(body)}`,
    );
  });
});
