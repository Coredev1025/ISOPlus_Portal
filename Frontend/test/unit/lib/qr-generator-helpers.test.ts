import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';
import { hasBusinessLogo, resolveQrLogoField } from '@/lib/business-logo';
import {
  normalizeUrlForQr,
  fetchQrGeneratorPageData,
  getQrGenerationError,
  overlayLogoOnQrCanvas,
  renderQrCodeOnCanvas,
  filterFormDocumentRows,
  getQrDownloadFilename,
  downloadQrCanvas,
  copyQrCanvasWithFallbacks,
  resolveQrTargetUrl,
} from '@/lib/qr-generator-helpers';

process.env.NEXT_PUBLIC_BACKEND_URL = 'https://api.isoplus.test';

const CUSTOM_URL_SELECTION_ID = '__qr_custom_url__';

/** Replaces window.Image so a src assignment fires a chosen lifecycle callback. */
type FakeImageEvent = 'load' | 'error' | 'abort' | 'none';
let imageEvent: FakeImageEvent = 'load';
let lastImageSrc = '';
let originalImage: typeof window.Image;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private value = '';

  get src() {
    return this.value;
  }

  set src(next: string) {
    this.value = next;
    lastImageSrc = next;
    if (imageEvent === 'load') this.onload?.();
    if (imageEvent === 'error') this.onerror?.();
    if (imageEvent === 'abort') this.onabort?.();
  }
}

function makeCtx() {
  return {
    fillStyle: '',
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    drawImage: vi.fn(),
  };
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

beforeEach(() => {
  originalImage = window.Image;
  (window as any).Image = FakeImage;
  imageEvent = 'load';
  lastImageSrc = '';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  (window as any).Image = originalImage;
  vi.restoreAllMocks();
  delete (navigator as any).clipboard;
  delete (window as any).ClipboardItem;
});

describe('normalizeUrlForQr', () => {
  it('returns null for empty or whitespace-only input', () => {
    expect(normalizeUrlForQr('')).toBeNull();
    expect(normalizeUrlForQr('   \n ')).toBeNull();
  });

  it('keeps an already absolute http(s) url, trimmed and unchanged otherwise', () => {
    expect(normalizeUrlForQr('  https://app.isoplus.online/form/9241  ')).toBe(
      'https://app.isoplus.online/form/9241',
    );
    expect(normalizeUrlForQr('http://example.com/path?a=1#frag')).toBe(
      'http://example.com/path?a=1#frag',
    );
  });

  it('matches the scheme case-insensitively and does not lowercase the url', () => {
    expect(normalizeUrlForQr('HTTPS://Example.COM/Path')).toBe('HTTPS://Example.COM/Path');
  });

  it('prefixes https:// when no scheme is present', () => {
    expect(normalizeUrlForQr('example.com')).toBe('https://example.com');
    expect(normalizeUrlForQr('  app.isoplus.online/form/1  ')).toBe(
      'https://app.isoplus.online/form/1',
    );
  });

  it('does not prefix a non-http scheme, and returns null when the result is unparseable', () => {
    expect(normalizeUrlForQr('mailto:someone@example.com')).toBe(
      'https://mailto:someone@example.com',
    );
    expect(normalizeUrlForQr('http://')).toBeNull();
    expect(normalizeUrlForQr('has space.com/x y')).toBeNull();
  });
});

describe('fetchQrGeneratorPageData', () => {
  const boardsPayload = {
    board: [
      { id: 204, name: 'Participants', label: 'NDIS', workspaceId: '5512' },
      { id: 998, name: 'Incidents', label: null, workspaceId: '5512' },
    ],
    nextAfter: null,
    hasMore: false,
  };

  const businessPayload = {
    _id: '66f0c9e1b8a1d2f3a4b5c6d7',
    workspaceId: '5512',
    name: 'Hillsgrade Care',
    abn: '12345678901',
    defaultLogo: 'business/5512/default.png',
    squareLogo: 'business/5512/square.png',
    wideLogo: null,
    logoUrls: {
      defaultLogo: {
        url: 'https://s3.example/business/5512/default.png?sig=abc',
        expiresAt: '2026-08-10T11:00:00.000Z',
      },
      squareLogo: {
        url: 'https://s3.example/business/5512/square.png?sig=def',
        expiresAt: '2026-08-10T11:00:00.000Z',
      },
    },
  };

  function stubEndpoints(views: unknown) {
    server.use(
      http.get('https://api.isoplus.test/api/workspaces/boards', () =>
        HttpResponse.json(boardsPayload),
      ),
      http.get('https://api.isoplus.test/api/business/profile', () =>
        HttpResponse.json(businessPayload),
      ),
      http.get('https://api.isoplus.test/api/boards/views-for-qr', () =>
        HttpResponse.json(views as Record<string, unknown>),
      ),
    );
  }

  it('matches the board loosely by id, returns the business profile, and sorts items by name', async () => {
    stubEndpoints({
      views: [
        {
          id: '77821',
          name: 'zebra checklist',
          url: 'https://app.isoplus.online/p/i5512-31007/zebra-checklist-77821',
          type: 'document',
        },
        {
          id: '9241',
          name: 'Alpha intake form',
          url: 'https://app.isoplus.online/form/9241',
          type: 'form',
          settings: { formSettings: { enabled: true } },
        },
        {
          id: '9242',
          name: 'beta consent form',
          url: 'https://app.isoplus.online/form/9242',
          type: 'form',
        },
      ],
    });

    const result = await fetchQrGeneratorPageData('5512', '204');

    expect(result.boardData).toEqual({
      id: 204,
      name: 'Participants',
      label: 'NDIS',
      workspaceId: '5512',
    });
    expect(result.businessData).toEqual(businessPayload);
    expect(result.items).toEqual([
      { id: '9241', name: 'Alpha intake form', url: 'https://app.isoplus.online/form/9241', type: 'form' },
      { id: '9242', name: 'beta consent form', url: 'https://app.isoplus.online/form/9242', type: 'form' },
      {
        id: '77821',
        name: 'zebra checklist',
        url: 'https://app.isoplus.online/p/i5512-31007/zebra-checklist-77821',
        type: 'document',
      },
    ]);
  });

  it('returns an undefined board when no board id matches', async () => {
    stubEndpoints({ views: [] });

    const result = await fetchQrGeneratorPageData('5512', '11111');

    expect(result.boardData).toBeUndefined();
    expect(result.items).toEqual([]);
  });

  it('falls back to an empty item list when views is absent', async () => {
    stubEndpoints({});

    const result = await fetchQrGeneratorPageData('5512', '204');

    expect(result.items).toEqual([]);
  });

  it('sorts unnamed items first without throwing', async () => {
    stubEndpoints({
      views: [
        { id: '3', name: 'Beta', url: 'https://app.isoplus.online/form/3', type: 'form' },
        { id: '1', name: undefined, url: 'https://app.isoplus.online/form/1', type: 'form' },
      ],
    });

    const result = await fetchQrGeneratorPageData('5512', '204');

    expect(result.items.map((i: { id: string }) => i.id)).toEqual(['1', '3']);
  });

  it('rejects when one of the three requests fails', async () => {
    server.use(
      http.get('https://api.isoplus.test/api/workspaces/boards', () =>
        HttpResponse.json(boardsPayload),
      ),
      http.get('https://api.isoplus.test/api/business/profile', () =>
        HttpResponse.json({ message: 'Business profile not found' }, { status: 404 }),
      ),
      http.get('https://api.isoplus.test/api/boards/views-for-qr', () =>
        HttpResponse.json({ views: [] }),
      ),
    );

    await expect(fetchQrGeneratorPageData('5512', '204')).rejects.toMatchObject({
      response: { status: 404, data: { message: 'Business profile not found' } },
    });
  });
});

describe('getQrGenerationError', () => {
  it('asks for a selection when nothing is selected', () => {
    expect(getQrGenerationError('', CUSTOM_URL_SELECTION_ID)).toBe(
      'Select a form, document, or Custom URL from the list.',
    );
  });

  it('asks for a valid link when the custom url option is selected', () => {
    expect(getQrGenerationError(CUSTOM_URL_SELECTION_ID, CUSTOM_URL_SELECTION_ID)).toBe(
      'Enter a valid link (e.g. https://example.com).',
    );
  });

  it('reports a missing url when a real item is selected', () => {
    expect(getQrGenerationError('9241', CUSTOM_URL_SELECTION_ID)).toBe(
      'Selected item has no URL.',
    );
  });
});

describe('overlayLogoOnQrCanvas', () => {
  it('rejects when the canvas has no 2d context', async () => {
    const canvas = makeCanvas(400, 400);
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);

    await expect(overlayLogoOnQrCanvas(canvas, 'blob:logo')).rejects.toThrow(
      'Canvas context not available',
    );
  });

  it('draws a white rounded backdrop and the logo centred at 15% of the canvas', async () => {
    const ctx = makeCtx();
    const canvas = makeCanvas(400, 400);
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);

    await overlayLogoOnQrCanvas(canvas, 'blob:logo-1');

    expect(lastImageSrc).toBe('blob:logo-1');
    expect(ctx.fillStyle).toBe('#ffffff');
    // logoSize 60, logoX/Y 170, padding 12, bg 84 at (158,158), radius 6
    expect(ctx.moveTo).toHaveBeenCalledWith(164, 158);
    expect(ctx.lineTo).toHaveBeenNthCalledWith(1, 236, 158);
    expect(ctx.quadraticCurveTo).toHaveBeenNthCalledWith(1, 242, 158, 242, 164);
    expect(ctx.lineTo).toHaveBeenNthCalledWith(2, 242, 236);
    expect(ctx.quadraticCurveTo).toHaveBeenNthCalledWith(2, 242, 242, 236, 242);
    expect(ctx.lineTo).toHaveBeenNthCalledWith(3, 164, 242);
    expect(ctx.quadraticCurveTo).toHaveBeenNthCalledWith(3, 158, 242, 158, 236);
    expect(ctx.lineTo).toHaveBeenNthCalledWith(4, 158, 164);
    expect(ctx.quadraticCurveTo).toHaveBeenNthCalledWith(4, 158, 158, 164, 158);
    expect(ctx.closePath).toHaveBeenCalledTimes(1);
    expect(ctx.fill).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 170, 170, 60, 60);
  });

  it('sizes the logo from the shorter side on a non-square canvas', async () => {
    const ctx = makeCtx();
    const canvas = makeCanvas(400, 200);
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);

    await overlayLogoOnQrCanvas(canvas, 'blob:logo-2');

    // logoSize = 200 * 0.15 = 30, logoX = 185, logoY = 85
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 185, 85, 30, 30);
  });

  it('resolves without drawing the logo when the image fails to load', async () => {
    imageEvent = 'error';
    const ctx = makeCtx();
    const canvas = makeCanvas(400, 400);
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);

    await expect(overlayLogoOnQrCanvas(canvas, 'blob:missing')).resolves.toBeUndefined();
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('Failed to load logo, using QR code without logo');
  });

  it('resolves without drawing the logo when the image load is aborted', async () => {
    imageEvent = 'abort';
    const ctx = makeCtx();
    const canvas = makeCanvas(400, 400);
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);

    await expect(overlayLogoOnQrCanvas(canvas, 'blob:aborted')).resolves.toBeUndefined();
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('Logo loading aborted, using QR code without logo');
  });

  it('swallows a drawing failure and still resolves', async () => {
    const ctx = makeCtx();
    ctx.drawImage.mockImplementation(() => {
      throw new Error('Tainted canvases may not be exported.');
    });
    const canvas = makeCanvas(400, 400);
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);

    await expect(overlayLogoOnQrCanvas(canvas, 'blob:logo-3')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('Error drawing logo:', expect.any(Error));
  });
});

describe('renderQrCodeOnCanvas', () => {
  function baseOptions(overrides: Partial<Parameters<typeof renderQrCodeOnCanvas>[2]> = {}) {
    return {
      drawLogo: false,
      business: undefined,
      workspaceId: '5512',
      fetchBusinessLogoBlobUrl: vi.fn().mockResolvedValue(null),
      hasBusinessLogo,
      resolveQrLogoField,
      revokeBlobUrl: vi.fn(),
      QRCode: { toCanvas: vi.fn().mockResolvedValue(undefined) },
      ...overrides,
    } as Parameters<typeof renderQrCodeOnCanvas>[2];
  }

  it('sizes the canvas to 400x400 and renders with high error correction', async () => {
    const canvas = makeCanvas(10, 10);
    const options = baseOptions();

    await renderQrCodeOnCanvas(canvas, 'https://example.com/x', options);

    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(400);
    expect(options.QRCode.toCanvas).toHaveBeenCalledWith(canvas, 'https://example.com/x', {
      errorCorrectionLevel: 'H',
      margin: 3,
      color: { dark: '#000000', light: '#ffffff' },
      width: 400,
    });
    expect(options.fetchBusinessLogoBlobUrl).not.toHaveBeenCalled();
  });

  it('skips the logo when drawLogo is false even though a logo exists', async () => {
    const options = baseOptions({
      drawLogo: false,
      business: { squareLogo: 'business/5512/square.png' },
    });

    await renderQrCodeOnCanvas(makeCanvas(400, 400), 'https://example.com', options);

    expect(options.fetchBusinessLogoBlobUrl).not.toHaveBeenCalled();
  });

  it('skips the logo when the business has none', async () => {
    const options = baseOptions({ drawLogo: true, business: { defaultLogo: '' } });

    await renderQrCodeOnCanvas(makeCanvas(400, 400), 'https://example.com', options);

    expect(options.fetchBusinessLogoBlobUrl).not.toHaveBeenCalled();
  });

  it('fetches the resolved logo field, overlays it, then revokes the blob url', async () => {
    const ctx = makeCtx();
    const canvas = makeCanvas(400, 400);
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);
    const options = baseOptions({
      drawLogo: true,
      business: { defaultLogo: 'business/5512/default.png', squareLogo: 'business/5512/square.png' },
      fetchBusinessLogoBlobUrl: vi.fn().mockResolvedValue('blob:square-logo'),
    });

    await renderQrCodeOnCanvas(canvas, 'https://example.com', options);

    expect(options.fetchBusinessLogoBlobUrl).toHaveBeenCalledWith('5512', 'squareLogo');
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 170, 170, 60, 60);
    expect(options.revokeBlobUrl).toHaveBeenCalledWith('blob:square-logo');
  });

  it('omits the field argument when no field can be resolved', async () => {
    const ctx = makeCtx();
    const canvas = makeCanvas(400, 400);
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);
    const fetchBusinessLogoBlobUrl = vi.fn().mockResolvedValue('blob:wide-logo');
    const options = baseOptions({
      drawLogo: true,
      // wideLogo counts as "has logo" but resolveQrLogoField ignores it
      business: { wideLogo: 'business/5512/wide.png' },
      fetchBusinessLogoBlobUrl,
    });

    await renderQrCodeOnCanvas(canvas, 'https://example.com', options);

    expect(fetchBusinessLogoBlobUrl).toHaveBeenCalledWith('5512');
    expect(fetchBusinessLogoBlobUrl.mock.calls[0]).toHaveLength(1);
  });

  it('does not overlay or revoke when the logo fetch yields null', async () => {
    const ctx = makeCtx();
    const canvas = makeCanvas(400, 400);
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);
    const options = baseOptions({
      drawLogo: true,
      business: { squareLogo: 'business/5512/square.png' },
      fetchBusinessLogoBlobUrl: vi.fn().mockResolvedValue(null),
    });

    await renderQrCodeOnCanvas(canvas, 'https://example.com', options);

    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(options.revokeBlobUrl).not.toHaveBeenCalled();
  });

  it('revokes the blob url even when the overlay rejects', async () => {
    const canvas = makeCanvas(400, 400);
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    const options = baseOptions({
      drawLogo: true,
      business: { squareLogo: 'business/5512/square.png' },
      fetchBusinessLogoBlobUrl: vi.fn().mockResolvedValue('blob:square-logo'),
    });

    await expect(
      renderQrCodeOnCanvas(canvas, 'https://example.com', options),
    ).rejects.toThrow('Canvas context not available');
    expect(options.revokeBlobUrl).toHaveBeenCalledWith('blob:square-logo');
  });

  it('propagates a QRCode failure before any logo work', async () => {
    const options = baseOptions({
      drawLogo: true,
      business: { squareLogo: 'business/5512/square.png' },
      QRCode: { toCanvas: vi.fn().mockRejectedValue(new Error('code length overflow')) },
    });

    await expect(
      renderQrCodeOnCanvas(makeCanvas(400, 400), 'https://example.com', options),
    ).rejects.toThrow('code length overflow');
    expect(options.fetchBusinessLogoBlobUrl).not.toHaveBeenCalled();
  });
});

describe('filterFormDocumentRows', () => {
  const items = [
    {
      id: '9241',
      name: 'Alpha intake form',
      url: 'https://app.isoplus.online/form/9241',
      type: 'form',
    },
    {
      id: '77821',
      name: 'Zebra checklist',
      url: 'https://app.isoplus.online/p/i5512-31007/zebra-checklist-77821',
      type: 'document',
    },
  ];

  it('always shows the custom url row, even for a search that matches nothing', () => {
    expect(
      filterFormDocumentRows(CUSTOM_URL_SELECTION_ID, 'nothing matches', CUSTOM_URL_SELECTION_ID, items),
    ).toBe(1);
  });

  it('shows every row when the search is empty or whitespace', () => {
    expect(filterFormDocumentRows('9241', '', CUSTOM_URL_SELECTION_ID, items)).toBe(1);
    expect(filterFormDocumentRows('9241', '   ', CUSTOM_URL_SELECTION_ID, items)).toBe(1);
  });

  it('hides a row whose id is not in the item list once a search is active', () => {
    expect(filterFormDocumentRows('does-not-exist', 'alpha', CUSTOM_URL_SELECTION_ID, items)).toBe(0);
  });

  it('matches on name, id, url and type case-insensitively', () => {
    expect(filterFormDocumentRows('9241', 'ALPHA', CUSTOM_URL_SELECTION_ID, items)).toBe(1);
    expect(filterFormDocumentRows('9241', '924', CUSTOM_URL_SELECTION_ID, items)).toBe(1);
    expect(filterFormDocumentRows('9241', 'isoplus.online/form', CUSTOM_URL_SELECTION_ID, items)).toBe(1);
    expect(filterFormDocumentRows('77821', 'Document', CUSTOM_URL_SELECTION_ID, items)).toBe(1);
  });

  it('trims the search before matching', () => {
    expect(filterFormDocumentRows('77821', '  zebra  ', CUSTOM_URL_SELECTION_ID, items)).toBe(1);
  });

  it('hides a row that matches nothing', () => {
    expect(filterFormDocumentRows('9241', 'zebra', CUSTOM_URL_SELECTION_ID, items)).toBe(0);
  });
});

describe('getQrDownloadFilename', () => {
  it('uses the custom-link suffix for no selection and for the custom url option', () => {
    expect(getQrDownloadFilename('', CUSTOM_URL_SELECTION_ID)).toBe('qr-code-custom-link.png');
    expect(getQrDownloadFilename(CUSTOM_URL_SELECTION_ID, CUSTOM_URL_SELECTION_ID)).toBe(
      'qr-code-custom-link.png',
    );
  });

  it('uses the selected id for a real item', () => {
    expect(getQrDownloadFilename('77821', CUSTOM_URL_SELECTION_ID)).toBe('qr-code-77821.png');
  });
});

describe('downloadQrCanvas', () => {
  it('clicks a detachable anchor and shows no toast on success', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,CCCC');
    let downloadAtClickTime = '';
    let hrefAtClickTime = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadAtClickTime = this.download;
      hrefAtClickTime = this.getAttribute('href') ?? '';
    });
    const showFetchErrorToast = vi.fn();

    downloadQrCanvas(makeCanvas(400, 400), 'qr-code-9241.png', showFetchErrorToast);

    expect(downloadAtClickTime).toBe('qr-code-9241.png');
    expect(hrefAtClickTime).toBe('data:image/png;base64,CCCC');
    expect(showFetchErrorToast).not.toHaveBeenCalled();
    expect(document.body.querySelector('a')).toBeNull();
  });

  it('shows the screenshot advice for a lowercase "tainted" message', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      throw new Error('the canvas is tainted by cross-origin data');
    });
    const showFetchErrorToast = vi.fn();

    downloadQrCanvas(makeCanvas(400, 400), 'qr-code-9241.png', showFetchErrorToast);

    expect(showFetchErrorToast).toHaveBeenCalledWith(
      'QR code',
      'Cannot download QR code with logo due to security restrictions. Try taking a screenshot instead.',
    );
  });

  it('misses the browser\'s real capitalised "Tainted canvases" message and falls back to the generic one', () => {
    // Characterizes current behaviour: the check here is a case-sensitive
    // includes('tainted'), unlike isTaintedCanvasError which lowercases first.
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      throw new Error('Tainted canvases may not be exported.');
    });
    const showFetchErrorToast = vi.fn();

    downloadQrCanvas(makeCanvas(400, 400), 'qr-code-9241.png', showFetchErrorToast);

    expect(showFetchErrorToast).toHaveBeenCalledWith(
      'QR code',
      'Failed to download QR code due to security restrictions',
    );
  });

  it('falls back to the generic message for any other failure', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      throw new Error('SecurityError: the operation is insecure');
    });
    const showFetchErrorToast = vi.fn();

    downloadQrCanvas(makeCanvas(400, 400), 'qr-code-9241.png', showFetchErrorToast);

    expect(showFetchErrorToast).toHaveBeenCalledWith(
      'QR code',
      'Failed to download QR code due to security restrictions',
    );
  });

  it('uses the generic message when a non-Error is thrown', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'tainted';
    });
    const showFetchErrorToast = vi.fn();

    downloadQrCanvas(makeCanvas(400, 400), 'qr-code-9241.png', showFetchErrorToast);

    expect(showFetchErrorToast).toHaveBeenCalledWith(
      'QR code',
      'Failed to download QR code due to security restrictions',
    );
  });
});

describe('copyQrCanvasWithFallbacks', () => {
  function makeHelpers(overrides: Record<string, unknown> = {}) {
    return {
      canvasToPngBlob: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
      writePngBlobToClipboard: vi.fn().mockResolvedValue(undefined),
      downloadCanvasPng: vi.fn(),
      openCanvasInNewTab: vi.fn().mockReturnValue(true),
      isTaintedCanvasError: vi.fn().mockReturnValue(false),
      showFetchErrorToast: vi.fn(),
      showSuccessToast: vi.fn(),
      ...overrides,
    } as unknown as Parameters<typeof copyQrCanvasWithFallbacks>[2];
  }

  function enableClipboard() {
    (navigator as any).clipboard = { write: vi.fn() };
    (window as any).ClipboardItem = class {};
  }

  it('reports an unsupported browser and does nothing else when the clipboard API is absent', async () => {
    (window as any).ClipboardItem = class {};
    const helpers = makeHelpers();

    await copyQrCanvasWithFallbacks(makeCanvas(400, 400), 'qr-code-9241.png', helpers);

    expect(helpers.showFetchErrorToast).toHaveBeenCalledWith(
      'Clipboard',
      "Your browser doesn't support copying images to clipboard. Try downloading instead.",
    );
    expect(helpers.canvasToPngBlob).not.toHaveBeenCalled();
    expect(helpers.downloadCanvasPng).not.toHaveBeenCalled();
  });

  it('reports an unsupported browser when ClipboardItem is absent', async () => {
    (navigator as any).clipboard = { write: vi.fn() };
    const helpers = makeHelpers();

    await copyQrCanvasWithFallbacks(makeCanvas(400, 400), 'qr-code-9241.png', helpers);

    expect(helpers.showFetchErrorToast).toHaveBeenCalledWith(
      'Clipboard',
      "Your browser doesn't support copying images to clipboard. Try downloading instead.",
    );
  });

  it('copies the blob to the clipboard and reports success', async () => {
    enableClipboard();
    const canvas = makeCanvas(400, 400);
    const blob = new Blob(['png'], { type: 'image/png' });
    const helpers = makeHelpers({ canvasToPngBlob: vi.fn().mockResolvedValue(blob) });

    await copyQrCanvasWithFallbacks(canvas, 'qr-code-9241.png', helpers);

    expect(helpers.canvasToPngBlob).toHaveBeenCalledWith(canvas);
    expect(helpers.writePngBlobToClipboard).toHaveBeenCalledWith(blob);
    expect(helpers.showSuccessToast).toHaveBeenCalledWith('QR code copied to clipboard successfully!');
    expect(helpers.downloadCanvasPng).not.toHaveBeenCalled();
  });

  it('stops at a toast without falling back when the canvas is tainted', async () => {
    enableClipboard();
    const helpers = makeHelpers({
      writePngBlobToClipboard: vi
        .fn()
        .mockRejectedValue(new Error('Tainted canvases may not be exported.')),
      isTaintedCanvasError: vi.fn().mockReturnValue(true),
    });

    await copyQrCanvasWithFallbacks(makeCanvas(400, 400), 'qr-code-9241.png', helpers);

    expect(helpers.showFetchErrorToast).toHaveBeenCalledWith(
      'QR code',
      'Cannot copy QR code with logo due to security restrictions. Try regenerating without logo or downloading instead.',
    );
    expect(helpers.downloadCanvasPng).not.toHaveBeenCalled();
    expect(helpers.openCanvasInNewTab).not.toHaveBeenCalled();
    expect(helpers.showSuccessToast).not.toHaveBeenCalled();
  });

  it('downloads instead when the clipboard write is denied', async () => {
    enableClipboard();
    const canvas = makeCanvas(400, 400);
    const helpers = makeHelpers({
      writePngBlobToClipboard: vi
        .fn()
        .mockRejectedValue(new Error('NotAllowedError: write permission denied')),
    });

    await copyQrCanvasWithFallbacks(canvas, 'qr-code-9241.png', helpers);

    expect(helpers.downloadCanvasPng).toHaveBeenCalledWith(canvas, 'qr-code-9241.png');
    expect(helpers.showSuccessToast).toHaveBeenCalledWith('QR code downloaded (clipboard not available)');
    expect(helpers.openCanvasInNewTab).not.toHaveBeenCalled();
  });

  it('opens a new tab when both the clipboard write and the download fail', async () => {
    enableClipboard();
    const canvas = makeCanvas(400, 400);
    const helpers = makeHelpers({
      canvasToPngBlob: vi.fn().mockRejectedValue(new Error('Failed to create blob from canvas')),
      downloadCanvasPng: vi.fn().mockImplementation(() => {
        throw new Error('download blocked');
      }),
    });

    await copyQrCanvasWithFallbacks(canvas, 'qr-code-9241.png', helpers);

    expect(helpers.openCanvasInNewTab).toHaveBeenCalledWith(canvas);
    expect(helpers.showSuccessToast).toHaveBeenCalledWith('QR code opened in a new tab');
    expect(helpers.showFetchErrorToast).not.toHaveBeenCalled();
  });

  it('shows no toast at all when the popup is blocked', async () => {
    enableClipboard();
    const helpers = makeHelpers({
      canvasToPngBlob: vi.fn().mockRejectedValue(new Error('Failed to create blob from canvas')),
      downloadCanvasPng: vi.fn().mockImplementation(() => {
        throw new Error('download blocked');
      }),
      openCanvasInNewTab: vi.fn().mockReturnValue(false),
    });

    await copyQrCanvasWithFallbacks(makeCanvas(400, 400), 'qr-code-9241.png', helpers);

    expect(helpers.showSuccessToast).not.toHaveBeenCalled();
    expect(helpers.showFetchErrorToast).not.toHaveBeenCalled();
  });

  it('reports the give-up message when opening a new tab throws', async () => {
    enableClipboard();
    const helpers = makeHelpers({
      canvasToPngBlob: vi.fn().mockRejectedValue(new Error('Failed to create blob from canvas')),
      downloadCanvasPng: vi.fn().mockImplementation(() => {
        throw new Error('download blocked');
      }),
      openCanvasInNewTab: vi.fn().mockImplementation(() => {
        throw new Error('Tainted canvases may not be exported.');
      }),
    });

    await copyQrCanvasWithFallbacks(makeCanvas(400, 400), 'qr-code-9241.png', helpers);

    expect(helpers.showFetchErrorToast).toHaveBeenCalledWith(
      'QR code',
      'Unable to export QR code. Please try taking a screenshot or regenerating without logo.',
    );
  });
});

describe('resolveQrTargetUrl', () => {
  const items = [
    { id: '9241', url: 'https://app.isoplus.online/form/9241' },
    { id: 77821 as unknown as string, url: 'https://app.isoplus.online/p/i5512-31007/x-77821' },
  ];

  it('normalizes the custom url when the custom option is selected', () => {
    expect(
      resolveQrTargetUrl(CUSTOM_URL_SELECTION_ID, '  example.com/booking ', CUSTOM_URL_SELECTION_ID, items),
    ).toBe('https://example.com/booking');
  });

  it('returns null when the custom url cannot be normalized', () => {
    expect(resolveQrTargetUrl(CUSTOM_URL_SELECTION_ID, '   ', CUSTOM_URL_SELECTION_ID, items)).toBeNull();
  });

  it('returns the selected item url, matching ids across types', () => {
    expect(resolveQrTargetUrl('9241', '', CUSTOM_URL_SELECTION_ID, items)).toBe(
      'https://app.isoplus.online/form/9241',
    );
    expect(resolveQrTargetUrl('77821', '', CUSTOM_URL_SELECTION_ID, items)).toBe(
      'https://app.isoplus.online/p/i5512-31007/x-77821',
    );
  });

  it('returns null when the selected item is unknown or has no url', () => {
    expect(resolveQrTargetUrl('does-not-exist', '', CUSTOM_URL_SELECTION_ID, items)).toBeNull();
    expect(
      resolveQrTargetUrl('1', '', CUSTOM_URL_SELECTION_ID, [
        { id: '1', url: undefined as unknown as string },
      ]),
    ).toBeNull();
  });

  it('returns null when nothing is selected', () => {
    expect(resolveQrTargetUrl('', 'https://example.com', CUSTOM_URL_SELECTION_ID, items)).toBeNull();
  });
});
