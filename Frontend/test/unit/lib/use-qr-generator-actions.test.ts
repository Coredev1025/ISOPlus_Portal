import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';
import { useQrGeneratorActions } from '@/lib/use-qr-generator-actions';

process.env.NEXT_PUBLIC_BACKEND_URL = 'https://api.isoplus.test';

const { toCanvas } = vi.hoisted(() => ({ toCanvas: vi.fn() }));
const { showFetchErrorToast, showSuccessToast } = vi.hoisted(() => ({
  showFetchErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

vi.mock('qrcode', () => ({ default: { toCanvas } }));
vi.mock('@/lib/toast-utils', () => ({ showFetchErrorToast, showSuccessToast }));

const CUSTOM_URL_SELECTION_ID = '__qr_custom_url__';

const ITEMS = [
  { id: '9241', url: 'https://app.isoplus.online/form/9241' },
  { id: '77821', url: 'https://app.isoplus.online/p/i5512-31007/zebra-checklist-77821' },
];

/** window.Image replacement whose src assignment fires onload synchronously. */
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
    this.onload?.();
  }
}

let originalImage: typeof window.Image;

function makeCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 400;
  return canvas;
}

type Overrides = Partial<Parameters<typeof useQrGeneratorActions>[0]>;

function setup(overrides: Overrides = {}) {
  const setGenerating = vi.fn();
  const setLastGeneratedUrl = vi.fn();
  const setQrCodeGenerated = vi.fn();
  const canvas = makeCanvas();

  const props = {
    selectedId: '',
    customUrl: '',
    customUrlSelectionId: CUSTOM_URL_SELECTION_ID,
    items: ITEMS,
    drawLogo: false,
    business: undefined,
    workspaceId: '5512',
    canvasRef: { current: canvas } as React.RefObject<HTMLCanvasElement | null>,
    qrCodeGenerated: false,
    setGenerating,
    setLastGeneratedUrl,
    setQrCodeGenerated,
    ...overrides,
  };

  const { result } = renderHook(() => useQrGeneratorActions(props));
  return { result, canvas, setGenerating, setLastGeneratedUrl, setQrCodeGenerated };
}

beforeEach(() => {
  originalImage = window.Image;
  (window as any).Image = FakeImage;
  toCanvas.mockReset();
  toCanvas.mockResolvedValue(undefined);
  showFetchErrorToast.mockReset();
  showSuccessToast.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  (window as any).Image = originalImage;
  vi.restoreAllMocks();
  delete (navigator as any).clipboard;
  delete (window as any).ClipboardItem;
});

describe('useQrGeneratorActions.generateQRCode', () => {
  it('asks for a selection and never starts generating when nothing is selected', async () => {
    const { result, setGenerating, setQrCodeGenerated } = setup({ selectedId: '' });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(showFetchErrorToast).toHaveBeenCalledWith(
      'QR code',
      'Select a form, document, or Custom URL from the list.',
    );
    expect(setGenerating).not.toHaveBeenCalled();
    expect(setQrCodeGenerated).not.toHaveBeenCalled();
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it('asks for a valid link when the custom url does not normalize', async () => {
    const { result } = setup({
      selectedId: CUSTOM_URL_SELECTION_ID,
      customUrl: 'has space.com/x y',
    });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(showFetchErrorToast).toHaveBeenCalledWith(
      'QR code',
      'Enter a valid link (e.g. https://example.com).',
    );
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it('reports a missing url when the selected item has none', async () => {
    const { result } = setup({
      selectedId: '5',
      items: [{ id: '5', url: '' }],
    });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(showFetchErrorToast).toHaveBeenCalledWith('QR code', 'Selected item has no URL.');
  });

  it('renders the selected item url and records it as generated', async () => {
    const { result, canvas, setGenerating, setLastGeneratedUrl, setQrCodeGenerated } = setup({
      selectedId: '77821',
    });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(toCanvas).toHaveBeenCalledWith(
      canvas,
      'https://app.isoplus.online/p/i5512-31007/zebra-checklist-77821',
      {
        errorCorrectionLevel: 'H',
        margin: 3,
        color: { dark: '#000000', light: '#ffffff' },
        width: 400,
      },
    );
    expect(setGenerating.mock.calls).toEqual([[true], [false]]);
    expect(setLastGeneratedUrl).toHaveBeenCalledWith(
      'https://app.isoplus.online/p/i5512-31007/zebra-checklist-77821',
    );
    expect(setQrCodeGenerated).toHaveBeenCalledWith(true);
    expect(showFetchErrorToast).not.toHaveBeenCalled();
  });

  it('normalizes a schemeless custom url before rendering it', async () => {
    const { result, setLastGeneratedUrl } = setup({
      selectedId: CUSTOM_URL_SELECTION_ID,
      customUrl: '  example.com/booking  ',
    });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(toCanvas.mock.calls[0][1]).toBe('https://example.com/booking');
    expect(setLastGeneratedUrl).toHaveBeenCalledWith('https://example.com/booking');
  });

  it('reports a missing canvas and still clears the generating flag', async () => {
    const { result, setGenerating, setQrCodeGenerated } = setup({
      selectedId: '9241',
      canvasRef: { current: null } as React.RefObject<HTMLCanvasElement | null>,
    });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(showFetchErrorToast).toHaveBeenCalledWith('QR code', 'Canvas not available');
    expect(setGenerating.mock.calls).toEqual([[true], [false]]);
    expect(setQrCodeGenerated).not.toHaveBeenCalled();
  });

  it('surfaces the qrcode library error message and leaves the state untouched', async () => {
    toCanvas.mockRejectedValue(new Error('code length overflow'));
    const { result, setLastGeneratedUrl, setQrCodeGenerated, setGenerating } = setup({
      selectedId: '9241',
    });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(showFetchErrorToast).toHaveBeenCalledWith('QR code', 'code length overflow');
    expect(setLastGeneratedUrl).not.toHaveBeenCalled();
    expect(setQrCodeGenerated).not.toHaveBeenCalled();
    expect(setGenerating.mock.calls).toEqual([[true], [false]]);
  });

  it('uses a default message when the failure is not an Error', async () => {
    toCanvas.mockRejectedValue('boom');
    const { result } = setup({ selectedId: '9241' });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(showFetchErrorToast).toHaveBeenCalledWith('QR code', 'Failed to generate QR code');
  });

  it('fetches the square logo and draws it over the code when drawLogo is on', async () => {
    const logoRequests: string[] = [];
    server.use(
      http.get('https://api.isoplus.test/api/business/logo-image', ({ request }) => {
        logoRequests.push(new URL(request.url).search);
        return HttpResponse.arrayBuffer(new Uint8Array([137, 80, 78, 71]).buffer, {
          headers: { 'Content-Type': 'image/png' },
        });
      }),
    );
    const createObjectURL = vi.fn().mockReturnValue('blob:square-logo');
    const revokeObjectURL = vi.fn();
    (URL as any).createObjectURL = createObjectURL;
    (URL as any).revokeObjectURL = revokeObjectURL;

    const ctx = { fillStyle: '', beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), drawImage: vi.fn() };
    const canvas = makeCanvas();
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);

    const { result, setQrCodeGenerated } = setup({
      selectedId: '9241',
      drawLogo: true,
      business: { defaultLogo: 'business/5512/default.png', squareLogo: 'business/5512/square.png' },
      canvasRef: { current: canvas } as React.RefObject<HTMLCanvasElement | null>,
    });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(logoRequests).toEqual(['?workspaceId=5512&logoKey=squareLogo']);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 170, 170, 60, 60);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:square-logo');
    expect(setQrCodeGenerated).toHaveBeenCalledWith(true);
  });

  it('still produces a QR code when the logo request fails', async () => {
    server.use(
      http.get('https://api.isoplus.test/api/business/logo-image', () =>
        HttpResponse.json({ message: 'Logo not found' }, { status: 404 }),
      ),
    );
    const canvas = makeCanvas();
    const getContext = vi.spyOn(canvas, 'getContext');

    const { result, setQrCodeGenerated } = setup({
      selectedId: '9241',
      drawLogo: true,
      business: { squareLogo: 'business/5512/square.png' },
      canvasRef: { current: canvas } as React.RefObject<HTMLCanvasElement | null>,
    });

    await act(async () => {
      await result.current.generateQRCode();
    });

    expect(getContext).not.toHaveBeenCalled();
    expect(setQrCodeGenerated).toHaveBeenCalledWith(true);
    expect(showFetchErrorToast).not.toHaveBeenCalled();
  });
});

describe('useQrGeneratorActions.downloadQRCode', () => {
  it('does nothing before a code has been generated', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { result } = setup({ selectedId: '9241', qrCodeGenerated: false });

    act(() => {
      result.current.downloadQRCode();
    });

    expect(click).not.toHaveBeenCalled();
  });

  it('does nothing when the canvas ref is empty', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { result } = setup({
      selectedId: '9241',
      qrCodeGenerated: true,
      canvasRef: { current: null } as React.RefObject<HTMLCanvasElement | null>,
    });

    act(() => {
      result.current.downloadQRCode();
    });

    expect(click).not.toHaveBeenCalled();
  });

  it('downloads under a filename built from the selected id', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,DDDD');
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });
    const { result } = setup({ selectedId: '77821', qrCodeGenerated: true });

    act(() => {
      result.current.downloadQRCode();
    });

    expect(downloadName).toBe('qr-code-77821.png');
  });

  it('downloads the custom link under the custom-link filename', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,DDDD');
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });
    const { result } = setup({
      selectedId: CUSTOM_URL_SELECTION_ID,
      customUrl: 'https://example.com',
      qrCodeGenerated: true,
    });

    act(() => {
      result.current.downloadQRCode();
    });

    expect(downloadName).toBe('qr-code-custom-link.png');
  });
});

describe('useQrGeneratorActions.copyQRCodeToClipboard', () => {
  it('does nothing before a code has been generated', async () => {
    const write = vi.fn();
    (navigator as any).clipboard = { write };
    (window as any).ClipboardItem = class {};
    const { result } = setup({ selectedId: '9241', qrCodeGenerated: false });

    await act(async () => {
      await result.current.copyQRCodeToClipboard();
    });

    expect(write).not.toHaveBeenCalled();
    expect(showFetchErrorToast).not.toHaveBeenCalled();
  });

  it('copies the canvas as a png and reports success', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    (navigator as any).clipboard = { write };
    class FakeClipboardItem {
      types: string[];
      constructor(public readonly items: Record<string, Blob>) {
        this.types = Object.keys(items);
      }
    }
    (window as any).ClipboardItem = FakeClipboardItem;
    (globalThis as any).ClipboardItem = FakeClipboardItem;

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as any);
    const blob = new Blob(['png'], { type: 'image/png' });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(((cb: BlobCallback) => {
      cb(blob);
    }) as HTMLCanvasElement['toBlob']);

    const { result } = setup({ selectedId: '9241', qrCodeGenerated: true });

    await act(async () => {
      await result.current.copyQRCodeToClipboard();
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0][0].items['image/png']).toBe(blob);
    expect(showSuccessToast).toHaveBeenCalledWith('QR code copied to clipboard successfully!');
    delete (globalThis as any).ClipboardItem;
  });

  it('warns that the browser cannot copy images when the clipboard API is missing', async () => {
    const { result } = setup({ selectedId: '9241', qrCodeGenerated: true });

    await act(async () => {
      await result.current.copyQRCodeToClipboard();
    });

    expect(showFetchErrorToast).toHaveBeenCalledWith(
      'Clipboard',
      "Your browser doesn't support copying images to clipboard. Try downloading instead.",
    );
  });

  it('falls back to a download when the clipboard write is denied', async () => {
    (navigator as any).clipboard = {
      write: vi.fn().mockRejectedValue(new Error('NotAllowedError: write permission denied')),
    };
    (window as any).ClipboardItem = class {};
    (globalThis as any).ClipboardItem = (window as any).ClipboardItem;

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(((cb: BlobCallback) => {
      cb(new Blob(['png'], { type: 'image/png' }));
    }) as HTMLCanvasElement['toBlob']);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,EEEE');
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });

    const { result } = setup({ selectedId: '9241', qrCodeGenerated: true });

    await act(async () => {
      await result.current.copyQRCodeToClipboard();
    });

    expect(downloadName).toBe('qr-code-9241.png');
    expect(showSuccessToast).toHaveBeenCalledWith('QR code downloaded (clipboard not available)');
    delete (globalThis as any).ClipboardItem;
  });
});
