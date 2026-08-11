import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';

import {
  LOGO_FIELDS,
  fetchBusinessLogoBlobUrl,
  getBusinessLogoImageUrl,
  hasBusinessLogo,
  isLogoUrlExpired,
  loadBusinessLogoPreviews,
  resolveQrLogoField,
  revokeBlobUrl,
} from '@/lib/business-logo';

const BACKEND = 'https://api.isoplus.test';
const LOGO_ENDPOINT = `${BACKEND}/api/business/logo-image`;

/** A one-pixel PNG, so the response body is real image bytes rather than text. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

/**
 * The stored S3 keys the backend puts on a Business document, as
 * Backend/src/models/Business.js declares them.
 */
const BUSINESS = {
  defaultLogo: 'business-logos/ws-4471/default-1739412000000.png',
  squareLogo: 'business-logos/ws-4471/square-1739412000000.png',
  wideLogo: 'business-logos/ws-4471/wide-1739412000000.png',
};

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let objectUrlCounter: number;

beforeEach(() => {
  process.env.NEXT_PUBLIC_BACKEND_URL = BACKEND;
  objectUrlCounter = 0;
  createObjectURL = vi.fn(() => `blob:${BACKEND}/object-${++objectUrlCounter}`);
  revokeObjectURL = vi.fn();
  // jsdom implements neither of these.
  (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  vi.useRealTimers();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

/** Serves the logo image and records every request URL that reached the server. */
function serveLogo(status = 200): string[] {
  const seen: string[] = [];
  server.use(
    http.get(LOGO_ENDPOINT, ({ request }) => {
      seen.push(request.url);
      if (status !== 200) {
        return HttpResponse.json({ message: 'Logo not found' }, { status });
      }
      return new HttpResponse(PNG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }),
  );
  return seen;
}

describe('LOGO_FIELDS', () => {
  it('lists the three logo fields the Business model stores, in order', () => {
    expect(LOGO_FIELDS).toEqual(['defaultLogo', 'squareLogo', 'wideLogo']);
  });
});

describe('revokeBlobUrl', () => {
  it('revokes an object URL', () => {
    revokeBlobUrl('blob:https://api.isoplus.test/object-1');

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://api.isoplus.test/object-1');
  });

  it('leaves a non-blob URL alone, so a backend URL is never revoked', () => {
    revokeBlobUrl('https://api.isoplus.test/api/business/logo-image?workspaceId=ws-4471');
    revokeBlobUrl('data:image/png;base64,iVBORw0KGgo=');

    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('tolerates null, undefined and the empty string', () => {
    revokeBlobUrl(null);
    revokeBlobUrl(undefined);
    revokeBlobUrl('');

    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe('getBusinessLogoImageUrl', () => {
  it('builds the endpoint with only workspaceId when no logo key is given', () => {
    expect(getBusinessLogoImageUrl('ws-4471')).toBe(
      'https://api.isoplus.test/api/business/logo-image?workspaceId=ws-4471',
    );
  });

  it('appends logoKey after workspaceId', () => {
    expect(getBusinessLogoImageUrl('ws-4471', 'squareLogo')).toBe(
      'https://api.isoplus.test/api/business/logo-image?workspaceId=ws-4471&logoKey=squareLogo',
    );
    expect(getBusinessLogoImageUrl('ws-4471', 'wideLogo')).toBe(
      'https://api.isoplus.test/api/business/logo-image?workspaceId=ws-4471&logoKey=wideLogo',
    );
  });

  it('percent-encodes a workspace id that would otherwise inject a query parameter', () => {
    expect(getBusinessLogoImageUrl('ws 1&logoKey=wideLogo', 'defaultLogo')).toBe(
      'https://api.isoplus.test/api/business/logo-image?workspaceId=ws+1%26logoKey%3DwideLogo&logoKey=defaultLogo',
    );
  });

  it('reads the backend base URL at call time', () => {
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';

    expect(getBusinessLogoImageUrl('ws-4471')).toBe(
      'http://localhost:4001/api/business/logo-image?workspaceId=ws-4471',
    );
  });
});

describe('fetchBusinessLogoBlobUrl', () => {
  it('requests the logo endpoint and returns an object URL for the response body', async () => {
    const seen = serveLogo();

    const result = await fetchBusinessLogoBlobUrl('ws-4471', 'squareLogo');

    expect(seen).toEqual([
      'https://api.isoplus.test/api/business/logo-image?workspaceId=ws-4471&logoKey=squareLogo',
    ]);
    expect(result).toBe('blob:https://api.isoplus.test/object-1');
  });

  it('omits logoKey from the request when no field is given', async () => {
    const seen = serveLogo();

    await fetchBusinessLogoBlobUrl('ws-4471');

    expect(seen).toEqual([
      'https://api.isoplus.test/api/business/logo-image?workspaceId=ws-4471',
    ]);
  });

  it('hands the downloaded bytes to createObjectURL', async () => {
    serveLogo();

    await fetchBusinessLogoBlobUrl('ws-4471', 'defaultLogo');

    const [body] = createObjectURL.mock.calls[0];
    expect(body).toBeInstanceOf(Blob);
  });

  it('returns null when the backend answers 404, without creating an object URL', async () => {
    serveLogo(404);

    expect(await fetchBusinessLogoBlobUrl('ws-4471', 'wideLogo')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('returns null when the backend answers 401', async () => {
    serveLogo(401);

    expect(await fetchBusinessLogoBlobUrl('ws-4471')).toBeNull();
  });

  it('returns null when the request fails at the network level', async () => {
    server.use(http.get(LOGO_ENDPOINT, () => HttpResponse.error()));

    expect(await fetchBusinessLogoBlobUrl('ws-4471', 'squareLogo')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe('isLogoUrlExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T09:00:00.000Z'));
  });

  it('treats a missing info object as expired', () => {
    expect(isLogoUrlExpired(undefined)).toBe(true);
  });

  it('treats an empty expiresAt as expired', () => {
    expect(
      isLogoUrlExpired({ url: 'https://s3.ap-southeast-2.amazonaws.com/logo.png', expiresAt: '' }),
    ).toBe(true);
  });

  it('is not expired when more than the 60 second skew window remains', () => {
    expect(
      isLogoUrlExpired({
        url: 'https://s3.ap-southeast-2.amazonaws.com/logo.png?X-Amz-Expires=900',
        expiresAt: '2026-03-15T09:01:00.001Z',
      }),
    ).toBe(false);
  });

  it('is expired once inside the 60 second skew window', () => {
    expect(
      isLogoUrlExpired({
        url: 'https://s3.ap-southeast-2.amazonaws.com/logo.png?X-Amz-Expires=900',
        expiresAt: '2026-03-15T09:00:30.000Z',
      }),
    ).toBe(true);
  });

  it('is expired exactly on the 60 second boundary', () => {
    expect(
      isLogoUrlExpired({
        url: 'https://s3.ap-southeast-2.amazonaws.com/logo.png',
        expiresAt: '2026-03-15T09:01:00.000Z',
      }),
    ).toBe(true);
  });

  it('is expired for a timestamp already in the past', () => {
    expect(
      isLogoUrlExpired({
        url: 'https://s3.ap-southeast-2.amazonaws.com/logo.png',
        expiresAt: '2026-03-15T08:45:00.000Z',
      }),
    ).toBe(true);
  });

  it('reports an unparseable expiresAt as NOT expired, because the NaN comparison is false', () => {
    expect(
      isLogoUrlExpired({
        url: 'https://s3.ap-southeast-2.amazonaws.com/logo.png',
        expiresAt: 'not-a-date',
      }),
    ).toBe(false);
  });
});

describe('hasBusinessLogo', () => {
  it('is false when the business is missing or has no logo fields', () => {
    expect(hasBusinessLogo(undefined)).toBe(false);
    expect(hasBusinessLogo({})).toBe(false);
  });

  it('is false when every logo field is null, undefined or empty', () => {
    expect(hasBusinessLogo({ defaultLogo: null, squareLogo: undefined, wideLogo: '' })).toBe(
      false,
    );
  });

  it('is true when any single logo field is set', () => {
    expect(hasBusinessLogo({ defaultLogo: BUSINESS.defaultLogo })).toBe(true);
    expect(hasBusinessLogo({ squareLogo: BUSINESS.squareLogo })).toBe(true);
    expect(hasBusinessLogo({ wideLogo: BUSINESS.wideLogo })).toBe(true);
  });

  it('ignores non-logo fields', () => {
    expect(
      hasBusinessLogo({ name: 'Hillsgrade Care' } as unknown as Record<string, string>),
    ).toBe(false);
  });
});

describe('resolveQrLogoField', () => {
  it('prefers the square logo when both square and default exist', () => {
    expect(resolveQrLogoField(BUSINESS)).toBe('squareLogo');
  });

  it('falls back to the default logo when there is no square logo', () => {
    expect(
      resolveQrLogoField({ defaultLogo: BUSINESS.defaultLogo, wideLogo: BUSINESS.wideLogo }),
    ).toBe('defaultLogo');
  });

  it('returns undefined when only a wide logo exists, since it is never used for QR codes', () => {
    expect(resolveQrLogoField({ wideLogo: BUSINESS.wideLogo })).toBeUndefined();
  });

  it('returns undefined for a missing or empty business', () => {
    expect(resolveQrLogoField(undefined)).toBeUndefined();
    expect(resolveQrLogoField({ defaultLogo: '', squareLogo: null })).toBeUndefined();
  });
});

describe('loadBusinessLogoPreviews', () => {
  it('fetches only the fields the business actually has, keyed by field', async () => {
    const seen = serveLogo();

    const previews = await loadBusinessLogoPreviews('ws-4471', {
      defaultLogo: BUSINESS.defaultLogo,
      squareLogo: null,
      wideLogo: BUSINESS.wideLogo,
    });

    expect(Object.keys(previews).sort()).toEqual(['defaultLogo', 'wideLogo']);
    expect(previews.squareLogo).toBeUndefined();
    expect(seen.map((url) => new URL(url).searchParams.get('logoKey')).sort()).toEqual([
      'defaultLogo',
      'wideLogo',
    ]);
    expect(new Set(Object.values(previews)).size).toBe(2);
  });

  it('requests nothing and returns an empty object when no logo is set', async () => {
    const seen = serveLogo();

    expect(await loadBusinessLogoPreviews('ws-4471', {})).toEqual({});
    expect(seen).toEqual([]);
  });

  it('omits a field whose download fails and keeps the ones that succeed', async () => {
    const seen: string[] = [];
    server.use(
      http.get(LOGO_ENDPOINT, ({ request }) => {
        seen.push(request.url);
        if (new URL(request.url).searchParams.get('logoKey') === 'squareLogo') {
          return HttpResponse.json({ message: 'Logo not found' }, { status: 404 });
        }
        return new HttpResponse(PNG_BYTES, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }),
    );

    const previews = await loadBusinessLogoPreviews('ws-4471', BUSINESS);

    expect(seen).toHaveLength(3);
    expect(Object.keys(previews).sort()).toEqual(['defaultLogo', 'wideLogo']);
  });

  it('returns an empty object when every download fails', async () => {
    serveLogo(500);

    expect(await loadBusinessLogoPreviews('ws-4471', BUSINESS)).toEqual({});
  });

  it('sends the workspace id given to it, not one read from the business record', async () => {
    const seen = serveLogo();

    await loadBusinessLogoPreviews('ws-9902', { squareLogo: BUSINESS.squareLogo });

    expect(seen).toEqual([
      'https://api.isoplus.test/api/business/logo-image?workspaceId=ws-9902&logoKey=squareLogo',
    ]);
  });
});
