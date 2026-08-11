import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('html-to-image', () => ({
  toJpeg: vi.fn(async () => 'data:image/jpeg;base64,CHART'),
}));

import { toJpeg } from 'html-to-image';
import {
  waitForFontsAndNextPaint,
  captureChartAsLightPng,
  compositeChartImages,
} from '@/lib/monthly-statement-chart-capture';

const toJpegMock = vi.mocked(toJpeg);

/** Stubs the browser's image decoder: layout maths under test stays real. */
type FakeSize = { width: number; height: number };
const imageSizes = new Map<string, FakeSize>();

class FakeImage {
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  #src = '';

  get src() {
    return this.#src;
  }

  set src(value: string) {
    this.#src = value;
    const size = imageSizes.get(value);
    queueMicrotask(() => {
      if (!size) {
        this.onerror?.(new Error(`no fake image registered for ${value}`));
        return;
      }
      this.width = size.width;
      this.height = size.height;
      this.onload?.();
    });
  }
}

function registerImage(src: string, width: number, height: number) {
  imageSizes.set(src, { width, height });
  return src;
}

type DrawCall = [unknown, number, number, number, number];
type FillRectCall = [number, number, number, number];

let drawImageCalls: DrawCall[];
let fillRectCalls: FillRectCall[];
let fillStyles: string[];
let toDataURLCalls: Array<[string | undefined, number | undefined]>;
let createdCanvases: HTMLCanvasElement[];
let fakeCtx: Record<string, unknown> | null;

function installCanvasStubs() {
  drawImageCalls = [];
  fillRectCalls = [];
  fillStyles = [];
  toDataURLCalls = [];
  createdCanvases = [];

  fakeCtx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    set fillStyle(value: string) {
      fillStyles.push(value);
    },
    get fillStyle() {
      return fillStyles[fillStyles.length - 1] ?? '';
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      fillRectCalls.push([x, y, w, h]);
    },
    drawImage: (img: unknown, x: number, y: number, w: number, h: number) => {
      drawImageCalls.push([img, x, y, w, h]);
    },
  };

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeCtx as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation((type?: string, quality?: number) => {
    toDataURLCalls.push([type, quality]);
    return 'data:image/jpeg;base64,COMPOSITE';
  });

  const nativeCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const el = nativeCreateElement(tag, options);
    if (tag === 'canvas') createdCanvases.push(el as HTMLCanvasElement);
    return el;
  }) as typeof document.createElement);
}

beforeEach(() => {
  imageSizes.clear();
  toJpegMock.mockClear();
  toJpegMock.mockResolvedValue('data:image/jpeg;base64,CHART');
  vi.stubGlobal('Image', FakeImage);
  installCanvasStubs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('waitForFontsAndNextPaint', () => {
  it('waits for font readiness and then two animation frames', async () => {
    let fontsAwaited = false;
    const readyPromise = Promise.resolve().then(() => {
      fontsAwaited = true;
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: readyPromise },
    });

    const frames: number[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(((cb: FrameRequestCallback) => {
      frames.push(frames.length);
      cb(frames.length);
      return frames.length;
    }) as typeof requestAnimationFrame);

    await waitForFontsAndNextPaint();

    expect(fontsAwaited).toBe(true);
    expect(frames).toHaveLength(2);
  });

  it('still resolves after two frames when font readiness rejects', async () => {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      get() {
        throw new Error('FontFaceSet unavailable');
      },
    });

    let frameCount = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(((cb: FrameRequestCallback) => {
      frameCount += 1;
      cb(frameCount);
      return frameCount;
    }) as typeof requestAnimationFrame);

    await expect(waitForFontsAndNextPaint()).resolves.toBeUndefined();
    expect(frameCount).toBe(2);
  });
});

describe('captureChartAsLightPng', () => {
  function buildChartCard() {
    const card = document.createElement('div');
    card.className = 'rounded-lg border bg-card dark:bg-slate-900 dark:border-slate-700';
    card.innerHTML = `
      <h3 class="text-sm font-medium text-foreground dark:text-white">Home Support Quarterly Budget</h3>
      <svg class="recharts-surface dark:opacity-90"><text class="fill-foreground dark:fill-white">$1,200.00</text></svg>
    `;
    document.body.appendChild(card);
    return card;
  }

  it('renders a detached light-mode clone and returns the encoder output', async () => {
    const card = buildChartCard();
    const result = await captureChartAsLightPng(card);

    expect(result).toBe('data:image/jpeg;base64,CHART');
    expect(toJpegMock).toHaveBeenCalledTimes(1);

    const captured = toJpegMock.mock.calls[0][0] as HTMLElement;
    expect(captured).not.toBe(card);
    expect(captured.querySelector('h3')?.textContent).toBe('Home Support Quarterly Budget');
  });

  it('strips dark: variants from the clone and its descendants, leaving the original untouched', async () => {
    const card = buildChartCard();
    await captureChartAsLightPng(card);

    const captured = toJpegMock.mock.calls[0][0] as HTMLElement;
    expect(Array.from(captured.classList)).toEqual(['rounded-lg', 'border', 'bg-card']);
    expect(Array.from(captured.querySelector('h3')!.classList)).toEqual(['text-sm', 'font-medium', 'text-foreground']);
    expect(Array.from(captured.querySelector('text')!.classList)).toEqual(['fill-foreground']);

    expect(card.classList.contains('dark:bg-slate-900')).toBe(true);
    expect(card.querySelector('h3')!.classList.contains('dark:text-white')).toBe(true);
  });

  it('pins the clone to the rounded-up measured size', async () => {
    const card = buildChartCard();
    card.getBoundingClientRect = () =>
      ({ width: 300.2, height: 150.7, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    await captureChartAsLightPng(card);

    const captured = toJpegMock.mock.calls[0][0] as HTMLElement;
    expect(captured.style.width).toBe('301px');
    expect(captured.style.height).toBe('151px');
  });

  it('falls back to 1px when the element measures zero', async () => {
    const card = buildChartCard();
    await captureChartAsLightPng(card);

    const captured = toJpegMock.mock.calls[0][0] as HTMLElement;
    expect(captured.style.width).toBe('1px');
    expect(captured.style.height).toBe('1px');
  });

  it('forces the light theme tokens and prepends the svg text colour override', async () => {
    const card = buildChartCard();
    await captureChartAsLightPng(card);

    const captured = toJpegMock.mock.calls[0][0] as HTMLElement;
    expect(captured.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(captured.style.color).toBe('rgb(0, 0, 0)');
    expect(captured.style.getPropertyValue('--background')).toBe('0 0% 100%');
    expect(captured.style.getPropertyValue('--foreground')).toBe('0 0% 0%');
    expect(captured.style.getPropertyValue('--card')).toBe('0 0% 100%');
    expect(captured.style.getPropertyValue('--card-foreground')).toBe('0 0% 0%');
    expect(captured.style.getPropertyValue('--popover')).toBe('0 0% 100%');
    expect(captured.style.getPropertyValue('--popover-foreground')).toBe('0 0% 0%');
    expect(captured.style.getPropertyValue('--muted')).toBe('0 0% 96%');
    expect(captured.style.getPropertyValue('--muted-foreground')).toBe('0 0% 45%');
    expect(captured.style.getPropertyValue('--border')).toBe('0 0% 90%');

    const firstChild = captured.firstElementChild!;
    expect(firstChild.tagName).toBe('STYLE');
    expect(firstChild.textContent).toContain('svg text, svg tspan { fill: hsl(var(--foreground)) !important; }');
  });

  it('has the clone attached off-screen while the encoder runs', async () => {
    const card = buildChartCard();
    let connectedDuringCapture: boolean | null = null;
    let wrapperLeft: string | null = null;
    toJpegMock.mockImplementationOnce(async (el: HTMLElement) => {
      connectedDuringCapture = el.isConnected;
      wrapperLeft = (el.parentElement as HTMLElement).style.left;
      return 'data:image/jpeg;base64,CHART';
    });

    await captureChartAsLightPng(card);

    expect(connectedDuringCapture).toBe(true);
    expect(wrapperLeft).toBe('-100000px');
  });

  it('removes the off-screen wrapper once capture succeeds', async () => {
    const card = buildChartCard();
    await captureChartAsLightPng(card);

    expect(document.body.childElementCount).toBe(1);
    expect(document.body.firstElementChild).toBe(card);
  });

  it('removes the off-screen wrapper and rethrows when the encoder fails', async () => {
    const card = buildChartCard();
    toJpegMock.mockRejectedValueOnce(new Error('canvas tainted'));

    await expect(captureChartAsLightPng(card)).rejects.toThrow('canvas tainted');
    expect(document.body.childElementCount).toBe(1);
    expect(document.body.firstElementChild).toBe(card);
  });

  it('asks the encoder for a 2x white JPEG with cache busting', async () => {
    const card = buildChartCard();
    await captureChartAsLightPng(card);

    expect(toJpegMock.mock.calls[0][1]).toEqual({
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: 'white',
      quality: 0.85,
    });
  });
});

describe('compositeChartImages', () => {
  it('returns an empty string and creates no canvas when there is nothing to composite', async () => {
    await expect(compositeChartImages([], 2)).resolves.toBe('');
    expect(createdCanvases).toHaveLength(0);
  });

  it('rejects when one of the images fails to load', async () => {
    const good = registerImage('data:image/jpeg;base64,GOOD', 100, 100);
    await expect(compositeChartImages([good, 'data:image/jpeg;base64,BROKEN'], 2)).rejects.toThrow(
      'no fake image registered for data:image/jpeg;base64,BROKEN',
    );
  });

  it('lays a gapped grid out at the largest image size when no target aspect is given', async () => {
    const a = registerImage('data:a', 100, 50);
    const b = registerImage('data:b', 80, 60);
    const c = registerImage('data:c', 40, 40);

    const result = await compositeChartImages([a, b, c], 2, undefined, { gap: 10, background: '#eeeeee' });

    // maxW=100, maxH=60, rows=ceil(3/2)=2 -> 2*100+1*10 by 2*60+1*10
    expect(createdCanvases).toHaveLength(1);
    expect([createdCanvases[0].width, createdCanvases[0].height]).toEqual([210, 130]);
    expect(fillRectCalls[0]).toEqual([0, 0, 210, 130]);
    expect(fillStyles[0]).toBe('#eeeeee');

    // contain scales: a min(100/100, 60/50)=1; b min(100/80, 60/60)=1; c min(100/40, 60/40)=1.5
    expect(drawImageCalls.map((call) => call.slice(1))).toEqual([
      [0, 5, 100, 50],
      [120, 0, 80, 60],
      [20, 70, 60, 60],
    ]);
    expect(result).toBe('data:image/jpeg;base64,COMPOSITE');
    expect(toDataURLCalls).toEqual([['image/jpeg', 0.82]]);
  });

  it('uses the supplied cell size instead of the largest image size', async () => {
    const a = registerImage('data:a', 100, 50);
    const b = registerImage('data:b', 80, 60);

    await compositeChartImages([a, b], 2, { width: 400, height: 300 });

    expect([createdCanvases[0].width, createdCanvases[0].height]).toEqual([800, 300]);
    // contain scales: a min(400/100, 300/50)=4 -> 400x200; b min(400/80, 300/60)=5 -> 400x300
    expect(drawImageCalls.map((call) => call.slice(1))).toEqual([
      [0, 50, 400, 200],
      [400, 0, 400, 300],
    ]);
  });

  it('crops to fill each cell when fit is cover', async () => {
    const a = registerImage('data:a', 100, 50);

    await compositeChartImages([a], 1, { width: 100, height: 60 }, { fit: 'cover' });

    // cover scale = max(100/100, 60/50) = 1.2 -> 120x60, centred horizontally
    expect(drawImageCalls.map((call) => call.slice(1))).toEqual([[-10, 0, 120, 60]]);
  });

  it('defaults the background to white and the gap to zero', async () => {
    const a = registerImage('data:a', 100, 100);
    const b = registerImage('data:b', 100, 100);

    await compositeChartImages([a, b], 2);

    expect([createdCanvases[0].width, createdCanvases[0].height]).toEqual([200, 100]);
    expect(fillStyles[0]).toBe('white');
  });

  it('returns the first source image when the canvas has no 2d context', async () => {
    const a = registerImage('data:a', 100, 100);
    const b = registerImage('data:b', 100, 100);
    fakeCtx = null;

    await expect(compositeChartImages([a, b], 2)).resolves.toBe('data:a');
    expect(drawImageCalls).toHaveLength(0);
  });

  it('widens the canvas to the target aspect and centres each chart vertically', async () => {
    const a = registerImage('data:a', 200, 100);
    const b = registerImage('data:b', 200, 100);
    const c = registerImage('data:c', 200, 100);

    await compositeChartImages([a, b, c], 3, undefined, { targetAspect: 1 });

    // candA: W=600, H=600, cell 200x600 -> scale min(1, 6)=1
    // candB: H=100, W=100, cell 33.33x100 -> scale min(0.1667, 1)=0.1667 -> candA wins
    expect([createdCanvases[0].width, createdCanvases[0].height]).toEqual([600, 600]);
    expect(drawImageCalls.map((call) => call.slice(1))).toEqual([
      [0, 250, 200, 100],
      [200, 250, 200, 100],
      [400, 250, 200, 100],
    ]);
  });

  it('picks the taller-derived candidate when it scales the charts up more', async () => {
    const a = registerImage('data:a', 100, 200);
    const b = registerImage('data:b', 100, 200);

    await compositeChartImages([a, b], 2, undefined, { targetAspect: 4 });

    // candA: W=200, H=50, cell 100x50 -> scale min(1, 0.25)=0.25
    // candB: H=200, W=800, cell 400x200 -> scale min(4, 1)=1 -> candB wins
    expect([createdCanvases[0].width, createdCanvases[0].height]).toEqual([800, 200]);
    expect(drawImageCalls.map((call) => call.slice(1))).toEqual([
      [150, 0, 100, 200],
      [550, 0, 100, 200],
    ]);
  });

  it('paints a background rectangle behind every cell, not just the whole canvas', async () => {
    const a = registerImage('data:a', 100, 100);
    const b = registerImage('data:b', 100, 100);

    await compositeChartImages([a, b], 2, undefined, { targetAspect: 2 });

    // candA: W=200, H=100, cell 100x100, scale 1; candB identical, so candA is kept
    expect([createdCanvases[0].width, createdCanvases[0].height]).toEqual([200, 100]);
    expect(fillRectCalls).toEqual([
      [0, 0, 200, 100],
      [0, 0, 100, 100],
      [100, 0, 100, 100],
    ]);
  });

  it.each([
    ['zero', 0],
    ['negative', -2],
    ['not finite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('ignores a %s target aspect and falls back to the plain grid', async (_label, targetAspect) => {
    const a = registerImage('data:a', 200, 100);
    const b = registerImage('data:b', 200, 100);

    await compositeChartImages([a, b], 2, undefined, { targetAspect });

    expect([createdCanvases[0].width, createdCanvases[0].height]).toEqual([400, 100]);
  });

  it('enables high-quality smoothing before drawing', async () => {
    const a = registerImage('data:a', 100, 100);
    await compositeChartImages([a], 1);

    expect(fakeCtx!.imageSmoothingEnabled).toBe(true);
    expect(fakeCtx!.imageSmoothingQuality).toBe('high');
  });
});
