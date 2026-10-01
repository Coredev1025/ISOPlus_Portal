import { describe, it, expect } from 'vitest';

import {
  assertGeneratedDocumentKeyForWorkspace,
  filenameFromObjectKey,
  safeAttachmentFilename,
} from '../../../src/utils/pdfFileDownloadHelpers.js';

/**
 * The browser must not fetch S3 directly (CORS). These helpers are the
 * gate the authenticated proxy uses: only keys under this workspace's
 * output/ folder, and a Content-Disposition name that cannot break the header.
 */
describe('assertGeneratedDocumentKeyForWorkspace', () => {
  it('accepts a key built for the claimed workspace', () => {
    expect(assertGeneratedDocumentKeyForWorkspace(
      'output/ws-1/board-a/monthly-statements/Jane_January_2026_Statement.pdf',
      'ws-1',
    )).toBe(true);
  });

  it('rejects a key that belongs to another workspace', () => {
    expect(assertGeneratedDocumentKeyForWorkspace(
      'output/other-ws/board-a/monthly-statements/x.pdf',
      'ws-1',
    )).toBe(false);
  });

  it('rejects keys outside the generated-document prefix', () => {
    expect(assertGeneratedDocumentKeyForWorkspace('logos/ws-1/logo.png', 'ws-1')).toBe(false);
    expect(assertGeneratedDocumentKeyForWorkspace('ws-1/board/x.pdf', 'ws-1')).toBe(false);
  });

  it('rejects empty or non-string inputs', () => {
    expect(assertGeneratedDocumentKeyForWorkspace('', 'ws-1')).toBe(false);
    expect(assertGeneratedDocumentKeyForWorkspace(null, 'ws-1')).toBe(false);
    expect(assertGeneratedDocumentKeyForWorkspace('output/ws-1/a.pdf', '')).toBe(false);
  });

  // A workspace id of "ws" must not unlock "output/ws-extra/...".
  it('requires a path boundary after the workspace id', () => {
    expect(assertGeneratedDocumentKeyForWorkspace(
      'output/ws-1-extra/board/x.pdf',
      'ws-1',
    )).toBe(false);
  });
});

describe('safeAttachmentFilename', () => {
  it('keeps a normal pdf name', () => {
    expect(safeAttachmentFilename('Jane_January_2026_Statement.pdf')).toBe(
      'Jane_January_2026_Statement.pdf',
    );
  });

  it('strips quotes and CR/LF that would break Content-Disposition', () => {
    expect(safeAttachmentFilename('evil"\r\nName.pdf')).toBe('evilName.pdf');
  });

  it('flattens path separators so a name cannot climb directories', () => {
    expect(safeAttachmentFilename('../../etc/passwd')).toBe('..-..-etc-passwd.pdf');
  });

  it('falls back when the name is empty', () => {
    expect(safeAttachmentFilename('')).toBe('document.pdf');
    expect(safeAttachmentFilename(null, 'monthly-statement.pdf')).toBe('monthly-statement.pdf');
  });

  it('appends .pdf when the extension is missing', () => {
    expect(safeAttachmentFilename('statement')).toBe('statement.pdf');
  });
});

describe('filenameFromObjectKey', () => {
  it('returns the last path segment', () => {
    expect(filenameFromObjectKey(
      'output/ws-1/board/monthly-statements/Jane_January_2026_Statement.pdf',
    )).toBe('Jane_January_2026_Statement.pdf');
  });

  it('returns document.pdf for an empty key', () => {
    expect(filenameFromObjectKey('')).toBe('document.pdf');
  });
});
