import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, PassThrough } from 'node:stream';

// The AWS SDK is the external edge: nothing here may reach S3. The fakes keep the
// command objects the module builds, so the assertions below are about the exact
// request this code constructs (bucket, key, body, expiry), not about "a mock was
// called".
const { sendMock, getSignedUrlMock, fakeWriteStreams } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
  fakeWriteStreams: new Map(),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class FakeCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class PutObjectCommand extends FakeCommand {}
  class GetObjectCommand extends FakeCommand {}
  class DeleteObjectCommand extends FakeCommand {}
  class S3Client {
    constructor(config) {
      this.config = config;
    }

    send(command) {
      return sendMock(command);
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlMock(...args),
}));

// Only the one path the download test registers is faked; every other path (the
// mongodb-memory-server binary download, for instance) still hits the real fs.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  const createWriteStream = (path, ...rest) =>
    (fakeWriteStreams.has(path) ? fakeWriteStreams.get(path) : actual.default.createWriteStream(path, ...rest));
  return { ...actual, default: { ...actual.default, createWriteStream } };
});

import {
  uploadFileToS3,
  downloadFileFromS3Stream,
  getS3FileUrl,
  deleteFileFromS3,
  getS3File,
  getContentType,
} from '../../../src/utils/uploadS3.js';

const AWS_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_BUCKET',
  'AWS_BUCKET_PUBLIC',
];

const saved = {};

function setFullAwsEnv() {
  process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'secret-example';
  process.env.AWS_REGION = 'ap-southeast-2';
  process.env.AWS_BUCKET = 'isoplus-private';
  process.env.AWS_BUCKET_PUBLIC = 'isoplus-public';
}

beforeEach(() => {
  for (const k of AWS_KEYS) saved[k] = process.env[k];
  setFullAwsEnv();
  sendMock.mockReset();
  getSignedUrlMock.mockReset();
  fakeWriteStreams.clear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of AWS_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('uploadFileToS3', () => {
  it('builds a PutObjectCommand against the private bucket and returns the SDK result', async () => {
    const body = Buffer.from('%PDF-1.7 invoice');
    sendMock.mockResolvedValue({ ETag: '"e0d3"', $metadata: { httpStatusCode: 200 } });

    const result = await uploadFileToS3(body, 'invoices/INV-1042.pdf');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    expect(command.constructor.name).toBe('PutObjectCommand');
    expect(command.input).toEqual({
      Bucket: 'isoplus-private',
      Key: 'invoices/INV-1042.pdf',
      Body: body,
    });
    expect(result).toEqual({ ETag: '"e0d3"', $metadata: { httpStatusCode: 200 } });
  });

  it('sends neither ACL nor ContentType — the upload inherits the bucket defaults', async () => {
    sendMock.mockResolvedValue({});

    await uploadFileToS3(Buffer.from('logo'), 'logos/ws1.png', true);

    const { input } = sendMock.mock.calls[0][0];
    expect(Object.keys(input).sort()).toEqual(['Body', 'Bucket', 'Key']);
    expect('ACL' in input).toBe(false);
    expect('ContentType' in input).toBe(false);
  });

  it('switches to the public bucket when publicRead is true', async () => {
    sendMock.mockResolvedValue({});

    await uploadFileToS3(Buffer.from('pdf'), 'statements/2026-08.pdf', true);

    expect(sendMock.mock.calls[0][0].input.Bucket).toBe('isoplus-public');
  });

  it('refuses to send when the private bucket name is missing', async () => {
    delete process.env.AWS_BUCKET;

    await expect(uploadFileToS3(Buffer.from('x'), 'k')).rejects.toThrow(
      'Missing required AWS environment variables',
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('checks only the bucket matching the publicRead flag', async () => {
    sendMock.mockResolvedValue({});

    // Private upload with no public bucket configured still goes through.
    delete process.env.AWS_BUCKET_PUBLIC;
    await uploadFileToS3(Buffer.from('x'), 'k', false);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // A public upload with the same environment is rejected.
    await expect(uploadFileToS3(Buffer.from('x'), 'k', true)).rejects.toThrow(
      'Missing required AWS environment variables',
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it.each(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'])(
    'refuses to send when %s is missing',
    async (missingKey) => {
      delete process.env[missingKey];

      await expect(uploadFileToS3(Buffer.from('x'), 'k')).rejects.toThrow(
        'Missing required AWS environment variables',
      );
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it('rethrows the SDK failure rather than swallowing it', async () => {
    sendMock.mockRejectedValue(new Error('AccessDenied'));

    await expect(uploadFileToS3(Buffer.from('x'), 'invoices/INV-1.pdf')).rejects.toThrow('AccessDenied');
  });
});

describe('getS3FileUrl', () => {
  it('returns an unsigned public URL and never asks the presigner', async () => {
    const url = await getS3FileUrl('logos/ws1.png', 3600, true);

    expect(url).toBe('https://isoplus-public.s3.ap-southeast-2.amazonaws.com/logos/ws1.png');
    expect(getSignedUrlMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('percent-encodes "+" in the public key but leaves spaces and slashes alone', async () => {
    const url = await getS3FileUrl('invoices/Jane + Co/INV 1+2.pdf', 3600, true);

    expect(url).toBe(
      'https://isoplus-public.s3.ap-southeast-2.amazonaws.com/invoices/Jane %2B Co/INV 1%2B2.pdf',
    );
  });

  it('presigns a GetObjectCommand on the private bucket with the default 3600s expiry', async () => {
    getSignedUrlMock.mockResolvedValue('https://signed.example/invoice.pdf');

    const url = await getS3FileUrl('invoices/INV-1042.pdf');

    expect(url).toBe('https://signed.example/invoice.pdf');
    const [client, command, options] = getSignedUrlMock.mock.calls[0];
    expect(client.constructor.name).toBe('S3Client');
    expect(command.constructor.name).toBe('GetObjectCommand');
    expect(command.input).toEqual({ Bucket: 'isoplus-private', Key: 'invoices/INV-1042.pdf' });
    expect(options).toEqual({ expiresIn: 3600 });
  });

  it('passes an explicit expiration through to the presigner', async () => {
    getSignedUrlMock.mockResolvedValue('https://signed.example/short.pdf');

    await getS3FileUrl('invoices/INV-1042.pdf', 60);

    expect(getSignedUrlMock.mock.calls[0][2]).toEqual({ expiresIn: 60 });
  });

  it('rejects before presigning when the environment is incomplete', async () => {
    delete process.env.AWS_REGION;

    await expect(getS3FileUrl('k')).rejects.toThrow('Missing required AWS environment variables');
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it('rethrows a presigner failure', async () => {
    getSignedUrlMock.mockRejectedValue(new Error('presign exploded'));

    await expect(getS3FileUrl('k')).rejects.toThrow('presign exploded');
  });
});

describe('deleteFileFromS3', () => {
  it('builds a DeleteObjectCommand on the private bucket and returns the SDK result', async () => {
    sendMock.mockResolvedValue({ DeleteMarker: true });

    const result = await deleteFileFromS3('logos/old.png');

    const command = sendMock.mock.calls[0][0];
    expect(command.constructor.name).toBe('DeleteObjectCommand');
    expect(command.input).toEqual({ Bucket: 'isoplus-private', Key: 'logos/old.png' });
    expect(result).toEqual({ DeleteMarker: true });
  });

  it('targets the public bucket when publicRead is true', async () => {
    sendMock.mockResolvedValue({});

    await deleteFileFromS3('statements/old.pdf', true);

    expect(sendMock.mock.calls[0][0].input.Bucket).toBe('isoplus-public');
  });

  it('validates the environment before sending and rethrows SDK failures', async () => {
    delete process.env.AWS_BUCKET;
    await expect(deleteFileFromS3('k')).rejects.toThrow('Missing required AWS environment variables');
    expect(sendMock).not.toHaveBeenCalled();

    setFullAwsEnv();
    sendMock.mockRejectedValue(new Error('NoSuchKey'));
    await expect(deleteFileFromS3('k')).rejects.toThrow('NoSuchKey');
  });
});

describe('getS3File', () => {
  it('concatenates the streamed body into a single Buffer', async () => {
    sendMock.mockResolvedValue({
      Body: Readable.from([Buffer.from('%PDF-'), Buffer.from('1.7 '), Buffer.from('body')]),
    });

    const buffer = await getS3File('invoices/INV-1042.pdf');

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toBe('%PDF-1.7 body');
    const command = sendMock.mock.calls[0][0];
    expect(command.constructor.name).toBe('GetObjectCommand');
    expect(command.input).toEqual({ Bucket: 'isoplus-private', Key: 'invoices/INV-1042.pdf' });
  });

  it('returns an empty Buffer for an empty body', async () => {
    sendMock.mockResolvedValue({ Body: Readable.from([]) });

    const buffer = await getS3File('logos/empty.png');

    expect(buffer).toHaveLength(0);
  });

  it('reads from the public bucket when publicRead is true', async () => {
    sendMock.mockResolvedValue({ Body: Readable.from([Buffer.from('png')]) });

    await getS3File('logos/ws1.png', true);

    expect(sendMock.mock.calls[0][0].input.Bucket).toBe('isoplus-public');
  });

  it('rethrows when the body stream fails mid-read', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('stream reset'));
      },
    });
    sendMock.mockResolvedValue({ Body: failing });

    await expect(getS3File('invoices/INV-1042.pdf')).rejects.toThrow('stream reset');
  });

  it('validates the environment before sending', async () => {
    delete process.env.AWS_BUCKET_PUBLIC;

    await expect(getS3File('k', true)).rejects.toThrow('Missing required AWS environment variables');
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('downloadFileFromS3Stream', () => {
  it('pipes the S3 body into the write stream for the download path', async () => {
    const downloadPath = '/isoplus-test/download-target.pdf';
    const sink = new PassThrough();
    const written = [];
    sink.on('data', (chunk) => written.push(chunk));
    fakeWriteStreams.set(downloadPath, sink);

    sendMock.mockResolvedValue({ Body: Readable.from([Buffer.from('chunk-a'), Buffer.from('chunk-b')]) });

    await downloadFileFromS3Stream('invoices/INV-1042.pdf', downloadPath);
    await new Promise((resolve) => sink.on('end', resolve));

    expect(Buffer.concat(written).toString()).toBe('chunk-achunk-b');
    const command = sendMock.mock.calls[0][0];
    expect(command.constructor.name).toBe('GetObjectCommand');
    expect(command.input).toEqual({ Bucket: 'isoplus-private', Key: 'invoices/INV-1042.pdf' });
  });

  it('ignores publicRead entirely — it always reads the private bucket, with no env check', async () => {
    delete process.env.AWS_BUCKET_PUBLIC;
    delete process.env.AWS_ACCESS_KEY_ID;
    const downloadPath = '/isoplus-test/no-env-check.pdf';
    const sink = new PassThrough();
    sink.resume();
    fakeWriteStreams.set(downloadPath, sink);
    sendMock.mockResolvedValue({ Body: Readable.from([Buffer.from('x')]) });

    await downloadFileFromS3Stream('k', downloadPath);

    expect(sendMock.mock.calls[0][0].input.Bucket).toBe('isoplus-private');
  });

  it('rethrows when the GetObject call itself fails', async () => {
    sendMock.mockRejectedValue(new Error('NoSuchKey'));

    await expect(downloadFileFromS3Stream('missing.pdf', '/isoplus-test/never.pdf')).rejects.toThrow(
      'NoSuchKey',
    );
  });
});

describe('getContentType', () => {
  it('maps every known image extension', () => {
    expect(getContentType('png')).toBe('image/png');
    expect(getContentType('jpg')).toBe('image/jpeg');
    expect(getContentType('jpeg')).toBe('image/jpeg');
    expect(getContentType('gif')).toBe('image/gif');
    expect(getContentType('svg')).toBe('image/svg+xml');
    expect(getContentType('webp')).toBe('image/webp');
    expect(getContentType('bmp')).toBe('image/bmp');
    expect(getContentType('ico')).toBe('image/x-icon');
  });

  it('falls back to application/octet-stream for anything else', () => {
    expect(getContentType('pdf')).toBe('application/octet-stream');
    expect(getContentType('')).toBe('application/octet-stream');
    expect(getContentType(undefined)).toBe('application/octet-stream');
    expect(getContentType(null)).toBe('application/octet-stream');
  });

  it('is case sensitive and does not strip a leading dot', () => {
    expect(getContentType('PNG')).toBe('application/octet-stream');
    expect(getContentType('.png')).toBe('application/octet-stream');
  });
});
