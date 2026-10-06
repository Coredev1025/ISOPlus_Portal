import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isTaintedCanvasError,
  canvasToPngBlob,
  writePngBlobToClipboard,
  openCanvasInNewTab,
  downloadCanvasPng,
} from '@/lib/qr-clipboard-helpers';

/** jsdom has no ClipboardItem; the real browser one wraps a {mime: Blob} record. */
class FakeClipboardItem {
  types: string[];
  constructor(public readonly items: Record<string, Blob>) {
    this.types = Object.keys(items);
  }
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).ClipboardItem;
  delete (globalThis as any).ClipboardItem;
  delete (navigator as any).clipboard;
});

describe('isTaintedCanvasError', () => {
  it('returns false for values that are not Error instances', () => {
    expect(isTaintedCanvasError('tainted canvas')).toBe(false);
    expect(isTaintedCanvasError({ message: 'tainted' })).toBe(false);
    expect(isTaintedCanvasError(null)).toBe(false);
    expect(isTaintedCanvasError(undefined)).toBe(false);
  });

  it('recognises tainted, security and cors errors regardless of case', () => {
    expect(
      isTaintedCanvasError(new Error('Tainted canvases may not be exported.')),
    ).toBe(true);
    expect(isTaintedCanvasError(new Error('SecurityError: blocked'))).toBe(true);
    expect(isTaintedCanvasError(new Error('CORS policy blocked the request'))).toBe(true);
  });

  it('returns false for an unrelated Error', () => {
    expect(isTaintedCanvasError(new Error('Failed to create blob from canvas'))).toBe(false);
  });
});

describe('canvasToPngBlob', () => {
  it('rejects when the temporary canvas has no 2d context', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    await expect(canvasToPngBlob(makeCanvas(400, 400))).rejects.toThrow(
      'Failed to get canvas context',
    );
  });

  it('copies the source canvas onto a same-sized temp canvas and resolves the png blob', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as any);

    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    let tempCanvas: HTMLCanvasElement | undefined;
    let requestedType: string | undefined;
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type?: string,
    ) {
      tempCanvas = this;
      requestedType = type;
      callback(blob);
    } as HTMLCanvasElement['toBlob']);

    const source = makeCanvas(400, 250);
    await expect(canvasToPngBlob(source)).resolves.toBe(blob);

    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);
    expect(tempCanvas).not.toBe(source);
    expect(tempCanvas!.width).toBe(400);
    expect(tempCanvas!.height).toBe(250);
    expect(requestedType).toBe('image/png');
  });

  it('rejects when toBlob yields null', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(((
      callback: BlobCallback,
    ) => {
      callback(null);
    }) as HTMLCanvasElement['toBlob']);

    await expect(canvasToPngBlob(makeCanvas(400, 400))).rejects.toThrow(
      'Failed to create blob from canvas',
    );
  });
});

describe('writePngBlobToClipboard', () => {
  it('throws when navigator.clipboard is missing', async () => {
    (window as any).ClipboardItem = FakeClipboardItem;

    await expect(
      writePngBlobToClipboard(new Blob([], { type: 'image/png' })),
    ).rejects.toThrow('Clipboard API not available');
  });

  it('throws when ClipboardItem is missing', async () => {
    (navigator as any).clipboard = { write: vi.fn() };

    await expect(
      writePngBlobToClipboard(new Blob([], { type: 'image/png' })),
    ).rejects.toThrow('Clipboard API not available');
    expect((navigator as any).clipboard.write).not.toHaveBeenCalled();
  });

  it('writes a single image/png clipboard item', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    (navigator as any).clipboard = { write };
    (window as any).ClipboardItem = FakeClipboardItem;
    (globalThis as any).ClipboardItem = FakeClipboardItem;

    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    await writePngBlobToClipboard(blob);

    expect(write).toHaveBeenCalledTimes(1);
    const [items] = write.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].types).toEqual(['image/png']);
    expect(items[0].items['image/png']).toBe(blob);
  });

  it('propagates a clipboard permission failure', async () => {
    (navigator as any).clipboard = {
      write: vi.fn().mockRejectedValue(new Error('NotAllowedError: write permission denied')),
    };
    (window as any).ClipboardItem = FakeClipboardItem;
    (globalThis as any).ClipboardItem = FakeClipboardItem;

    await expect(
      writePngBlobToClipboard(new Blob([], { type: 'image/png' })),
    ).rejects.toThrow('NotAllowedError: write permission denied');
  });
});

describe('openCanvasInNewTab', () => {
  it('returns false and writes nothing when the popup is blocked', () => {
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,AAAA');
    vi.spyOn(window, 'open').mockReturnValue(null);

    expect(openCanvasInNewTab(makeCanvas(400, 400))).toBe(false);
    expect(toDataURL).toHaveBeenCalledWith('image/png');
  });

  it('writes an img tag with the png data url into the new window', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,AAAA',
    );
    const write = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({ document: { write } } as any);

    expect(openCanvasInNewTab(makeCanvas(400, 400))).toBe(true);
    expect(write).toHaveBeenCalledWith(
      '<img src="data:image/png;base64,AAAA" alt="QR Code">',
    );
  });

  it('lets a tainted-canvas toDataURL failure escape', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      throw new Error('Tainted canvases may not be exported.');
    });
    const open = vi.spyOn(window, 'open');

    expect(() => openCanvasInNewTab(makeCanvas(400, 400))).toThrow('Tainted canvases');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('downloadCanvasPng', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,BBBB',
    );
  });

  it('clicks an anchor that is attached to the document, then removes it', () => {
    let attachedAtClickTime = false;
    let downloadAtClickTime = '';
    let hrefAtClickTime = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        attachedAtClickTime = document.body.contains(this);
        downloadAtClickTime = this.download;
        hrefAtClickTime = this.getAttribute('href') ?? '';
      });

    downloadCanvasPng(makeCanvas(400, 400), 'qr-code-77821.png');

    expect(click).toHaveBeenCalledTimes(1);
    expect(attachedAtClickTime).toBe(true);
    expect(downloadAtClickTime).toBe('qr-code-77821.png');
    expect(hrefAtClickTime).toBe('data:image/png;base64,BBBB');
    expect(document.body.querySelector('a')).toBeNull();
  });
});
