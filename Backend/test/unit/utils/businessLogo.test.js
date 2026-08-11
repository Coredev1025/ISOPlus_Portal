import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Only the two S3 round-trips are faked. getContentType stays real, because the
// content type loadBusinessLogoAsset reports is part of the behaviour under test.
vi.mock('../../../src/utils/uploadS3.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getS3FileUrl: vi.fn(),
    getS3File: vi.fn(),
  };
});

import mongoose from 'mongoose';
import { getS3FileUrl, getS3File } from '../../../src/utils/uploadS3.js';
import Business from '../../../src/models/Business.js';
import {
  isValidLogoField,
  buildLogoUrls,
  formatBusinessProfileResponse,
  resolveQrLogoField,
  loadBusinessLogoAsset,
} from '../../../src/utils/businessLogo.js';

describe('isValidLogoField', () => {
  it('accepts exactly the three stored logo fields', () => {
    expect(isValidLogoField('defaultLogo')).toBe(true);
    expect(isValidLogoField('squareLogo')).toBe(true);
    expect(isValidLogoField('wideLogo')).toBe(true);
  });

  it('rejects anything else, including object prototype members', () => {
    expect(isValidLogoField('xeroTokens')).toBe(false);
    expect(isValidLogoField('logo')).toBe(false);
    expect(isValidLogoField('')).toBe(false);
    expect(isValidLogoField(undefined)).toBe(false);
    expect(isValidLogoField('toString')).toBe(false);
    expect(isValidLogoField('__proto__')).toBe(false);
  });
});

describe('buildLogoUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('presigns every populated logo field for one hour and stamps the expiry', async () => {
    getS3FileUrl.mockImplementation(async (key) => `https://signed.example/${key}`);

    const urls = await buildLogoUrls({
      workspaceId: 'ws_4821',
      name: 'Hillsgrade Care Services',
      defaultLogo: 'logos/ws_4821/default-logo.png',
      squareLogo: 'logos/ws_4821/square-logo.jpg',
      wideLogo: null,
    });

    expect(urls).toEqual({
      defaultLogo: {
        url: 'https://signed.example/logos/ws_4821/default-logo.png',
        expiresAt: '2026-03-01T11:00:00.000Z',
      },
      squareLogo: {
        url: 'https://signed.example/logos/ws_4821/square-logo.jpg',
        expiresAt: '2026-03-01T11:00:00.000Z',
      },
    });
  });

  it('requests a private (non public-read) presigned url with a 3600 second expiry', async () => {
    getS3FileUrl.mockResolvedValue('https://signed.example/x');

    await buildLogoUrls({ wideLogo: 'logos/ws_4821/wide-logo.svg' });

    expect(getS3FileUrl).toHaveBeenCalledTimes(1);
    expect(getS3FileUrl).toHaveBeenCalledWith('logos/ws_4821/wide-logo.svg', 3600, false);
  });

  it('returns an empty map when there are no logos, or no business at all', async () => {
    getS3FileUrl.mockResolvedValue('https://signed.example/x');

    expect(await buildLogoUrls({ workspaceId: 'ws_4821' })).toEqual({});
    expect(await buildLogoUrls({ defaultLogo: '' })).toEqual({});
    expect(await buildLogoUrls(null)).toEqual({});
    expect(await buildLogoUrls(undefined)).toEqual({});
    expect(getS3FileUrl).not.toHaveBeenCalled();
  });

  it('propagates an S3 signing failure rather than swallowing it', async () => {
    getS3FileUrl.mockRejectedValue(new Error('Missing required AWS environment variables'));

    await expect(buildLogoUrls({ defaultLogo: 'logos/ws/default-logo.png' })).rejects.toThrow(
      'Missing required AWS environment variables',
    );
  });
});

describe('formatBusinessProfileResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
    getS3FileUrl.mockImplementation(async (key) => `https://signed.example/${key}`);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches logoUrls to a lean business document without mutating the input', async () => {
    const lean = {
      _id: '507f1f77bcf86cd799439011',
      workspaceId: 'ws_4821',
      name: 'Hillsgrade Care Services',
      email: 'accounts@hillsgrade.example',
      defaultLogo: 'logos/ws_4821/default-logo.png',
      xeroIntegrated: false,
    };

    const response = await formatBusinessProfileResponse(lean);

    expect(response.name).toBe('Hillsgrade Care Services');
    expect(response.email).toBe('accounts@hillsgrade.example');
    expect(response.xeroIntegrated).toBe(false);
    expect(response.featureToggles).toEqual({
      invoiceStatementAutomation: false,
    });
    expect(response.logoUrls).toEqual({
      defaultLogo: {
        url: 'https://signed.example/logos/ws_4821/default-logo.png',
        expiresAt: '2026-03-01T11:00:00.000Z',
      },
    });
    expect(lean).not.toHaveProperty('logoUrls');
  });

  it('converts a hydrated mongoose document via toObject', async () => {
    const doc = new Business({
      workspaceId: 'ws_4821',
      name: 'Hillsgrade Care Services',
      squareLogo: 'logos/ws_4821/square-logo.jpg',
      address: { street: '12 Bourke Street', suburb: 'Surry Hills', state: 'NSW', postcode: '2010' },
    });

    const response = await formatBusinessProfileResponse(doc);

    expect(response).not.toBeInstanceOf(mongoose.Document);
    expect(response.name).toBe('Hillsgrade Care Services');
    expect(response.address.suburb).toBe('Surry Hills');
    expect(response.logoUrls.squareLogo.url).toBe(
      'https://signed.example/logos/ws_4821/square-logo.jpg',
    );
    expect(doc.logoUrls).toBeUndefined();
  });

  it('returns logoUrls and default featureToggles for a nullish business', async () => {
    expect(await formatBusinessProfileResponse(null)).toEqual({
      logoUrls: {},
      featureToggles: { invoiceStatementAutomation: false },
    });
  });
});

describe('resolveQrLogoField', () => {
  it('prefers the square logo when both are present', () => {
    expect(
      resolveQrLogoField({
        defaultLogo: 'logos/ws/default-logo.png',
        squareLogo: 'logos/ws/square-logo.png',
      }),
    ).toBe('squareLogo');
  });

  it('falls back to the default logo when there is no square logo', () => {
    expect(resolveQrLogoField({ defaultLogo: 'logos/ws/default-logo.png', squareLogo: null })).toBe(
      'defaultLogo',
    );
  });

  it('returns null when neither is set, and ignores the wide logo entirely', () => {
    expect(resolveQrLogoField({ wideLogo: 'logos/ws/wide-logo.png' })).toBeNull();
    expect(resolveQrLogoField({})).toBeNull();
    expect(resolveQrLogoField(null)).toBeNull();
  });
});

describe('loadBusinessLogoAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const business = {
    workspaceId: 'ws_4821',
    defaultLogo: 'logos/ws_4821/default-logo.PNG',
    squareLogo: 'logos/ws_4821/square-logo.jpeg',
    wideLogo: 'logos/ws_4821/wide-logo',
  };

  it('rejects a logo key that is not one of the three stored fields', async () => {
    await expect(loadBusinessLogoAsset(business, 'xeroTokens')).rejects.toThrow('Invalid logo key');
    await expect(loadBusinessLogoAsset(business, undefined)).rejects.toThrow('Invalid logo key');
    expect(getS3File).not.toHaveBeenCalled();
  });

  it('returns null when the field is empty on the business', async () => {
    expect(await loadBusinessLogoAsset({ defaultLogo: null }, 'defaultLogo')).toBeNull();
    expect(await loadBusinessLogoAsset(null, 'squareLogo')).toBeNull();
    expect(getS3File).not.toHaveBeenCalled();
  });

  it('returns null when S3 yields no bytes', async () => {
    getS3File.mockResolvedValue(null);

    expect(await loadBusinessLogoAsset(business, 'defaultLogo')).toBeNull();
    expect(getS3File).toHaveBeenCalledWith('logos/ws_4821/default-logo.PNG', false);
  });

  it('derives the content type from a lower-cased file extension', async () => {
    const buffer = Buffer.from('png-bytes');
    getS3File.mockResolvedValue(buffer);

    expect(await loadBusinessLogoAsset(business, 'defaultLogo')).toEqual({
      buffer,
      contentType: 'image/png',
      logoPath: 'logos/ws_4821/default-logo.PNG',
    });
  });

  it('maps jpeg to image/jpeg', async () => {
    const buffer = Buffer.from('jpeg-bytes');
    getS3File.mockResolvedValue(buffer);

    const asset = await loadBusinessLogoAsset(business, 'squareLogo');
    expect(asset.contentType).toBe('image/jpeg');
    expect(asset.logoPath).toBe('logos/ws_4821/square-logo.jpeg');
  });

  it('falls back to application/octet-stream for a key with no extension', async () => {
    getS3File.mockResolvedValue(Buffer.from('bytes'));

    const asset = await loadBusinessLogoAsset(business, 'wideLogo');
    expect(asset.contentType).toBe('application/octet-stream');
  });

  it('propagates an S3 download failure', async () => {
    getS3File.mockRejectedValue(new Error('NoSuchKey'));

    await expect(loadBusinessLogoAsset(business, 'defaultLogo')).rejects.toThrow('NoSuchKey');
  });
});
