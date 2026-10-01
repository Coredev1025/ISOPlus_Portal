import { describe, it, expect, vi } from 'vitest';

import {
  assertGeneratedDocumentKeyForWorkspace,
  filenameFromObjectKey,
  safeAttachmentFilename,
  contentDispositionAttachment,
  preferPublicBucketFromUrl,
  readGeneratedDocumentBytes,
} from '../../../src/utils/pdfFileDownloadHelpers.js';

/**
 * The browser must not fetch S3 directly (CORS). These helpers are the
 * gate the authenticated proxy uses: only keys under this workspace's
 * output/ folder, and a Content-Disposition that Node can emit without
 * changing the download name the client already chose.
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

  // ASCII fallback only — the origin download name (with ™) is preserved via
  // filename*=UTF-8''... on contentDispositionAttachment.
  it('strips non-ASCII characters such as the ISO+ trademark for the ASCII fallback', () => {
    expect(safeAttachmentFilename('Invoice_INV-14 (ISO+™)_Jane_Smith.pdf')).toBe(
      'Invoice_INV-14 (ISO+)_Jane_Smith.pdf',
    );
  });
});

describe('contentDispositionAttachment', () => {
  it('keeps the origin filename (including ISO+™) in filename*= without changing S3 keys', () => {
    const original = 'Invoice_INV-14 (ISO+™)_Jane_Smith.pdf';
    const header = contentDispositionAttachment(original);

    expect(header).toContain('filename="Invoice_INV-14 (ISO+)_Jane_Smith.pdf"');
    expect(header).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).toBe(original);
    // Header value must be Latin-1-safe for Node setHeader.
    expect(() => {
      const { OutgoingMessage } = require('node:http');
      const msg = new OutgoingMessage();
      msg.setHeader('Content-Disposition', header);
    }).not.toThrow();
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

describe('preferPublicBucketFromUrl', () => {
  it('detects the public bucket host used by older invoice links', () => {
    process.env.AWS_BUCKET_PUBLIC = 'isoplus-portal-dev-public';
    expect(preferPublicBucketFromUrl(
      'https://isoplus-portal-dev-public.s3.ap-southeast-2.amazonaws.com/output/55515/x.pdf',
    )).toBe(true);
    expect(preferPublicBucketFromUrl(
      'https://isoplus-portal-dev.s3.ap-southeast-2.amazonaws.com/output/55515/x.pdf?X-Amz-Signature=abc',
    )).toBe(false);
  });
});

describe('readGeneratedDocumentBytes', () => {
  const KEY = 'output/55515/board/Participant-invoices/INV-14-ISO+™-Jane-Smith.pdf';

  it('reads the private bucket first for current (presigned) URLs', async () => {
    const getS3File = vi.fn(async (_key, publicRead) => {
      if (publicRead) throw new Error('not in public');
      return Buffer.from('private-bytes');
    });

    const bytes = await readGeneratedDocumentBytes(
      KEY,
      'https://isoplus-portal-dev.s3.ap-southeast-2.amazonaws.com/output/55515/x.pdf?X-Amz-Signature=abc',
      { getS3File },
    );

    expect(bytes.toString()).toBe('private-bytes');
    expect(getS3File.mock.calls.map((c) => c[1])).toEqual([false]);
  });

  it('falls back to the public bucket so older invoices remain downloadable without renaming keys', async () => {
    const getS3File = vi.fn(async (_key, publicRead) => {
      if (!publicRead) throw new Error('missing in private');
      return Buffer.from('legacy-public-bytes');
    });

    const bytes = await readGeneratedDocumentBytes(
      KEY,
      'https://isoplus-portal-dev.s3.ap-southeast-2.amazonaws.com/output/55515/x.pdf?X-Amz-Signature=abc',
      { getS3File },
    );

    expect(bytes.toString()).toBe('legacy-public-bytes');
    expect(getS3File.mock.calls.map((c) => c[1])).toEqual([false, true]);
  });

  it('tries the public bucket first when the stored URL already points at it', async () => {
    process.env.AWS_BUCKET_PUBLIC = 'isoplus-portal-dev-public';
    const getS3File = vi.fn(async (_key, publicRead) => {
      if (!publicRead) throw new Error('not private');
      return Buffer.from('public-bytes');
    });

    const bytes = await readGeneratedDocumentBytes(
      KEY,
      'https://isoplus-portal-dev-public.s3.ap-southeast-2.amazonaws.com/output/55515/old.pdf',
      { getS3File },
    );

    expect(bytes.toString()).toBe('public-bytes');
    expect(getS3File.mock.calls.map((c) => c[1])).toEqual([true]);
  });
});
