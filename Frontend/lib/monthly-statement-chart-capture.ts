import { toJpeg } from "html-to-image";

function stripDarkVariantClasses(el: Element) {
  const classList = (el as HTMLElement).classList;
  if (!classList) return;
  const toRemove: string[] = [];
  for (let i = 0; i < classList.length; i++) {
    const cls = classList[i];
    if (cls.startsWith("dark:")) toRemove.push(cls);
  }
  for (const cls of toRemove) {
    classList.remove(cls);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function drawImagesOnGrid(
  ctx: CanvasRenderingContext2D,
  images: HTMLImageElement[],
  cols: number,
  cellW: number,
  cellH: number,
  gap: number,
  background: string,
  fit: "contain" | "cover",
) {
  const rows = Math.ceil(images.length / cols);
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * (cellW + gap);
    const y = row * (cellH + gap);
    ctx.fillStyle = background;
    ctx.fillRect(x, y, cellW, cellH);
    const scale = fit === "cover"
      ? Math.max(cellW / img.width, cellH / img.height)
      : Math.min(cellW / img.width, cellH / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
  }
}

export async function waitForFontsAndNextPaint() {
  try {
    if (typeof document !== "undefined" && document.fonts) {
      await document.fonts.ready;
    }
  } catch {
    // Ignore font readiness failures and continue with capture.
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export async function captureChartAsLightPng(captureEl: HTMLElement) {
  const rect = captureEl.getBoundingClientRect();
  const clone = captureEl.cloneNode(true) as HTMLElement;

  stripDarkVariantClasses(clone);
  const descendants = clone.querySelectorAll("*");
  for (let i = 0; i < descendants.length; i++) {
    stripDarkVariantClasses(descendants[i]);
  }

  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;

  clone.style.backgroundColor = "#ffffff";
  clone.style.color = "#000000";
  clone.style.setProperty("--background", "0 0% 100%");
  clone.style.setProperty("--foreground", "0 0% 0%");
  clone.style.setProperty("--card", "0 0% 100%");
  clone.style.setProperty("--card-foreground", "0 0% 0%");
  clone.style.setProperty("--popover", "0 0% 100%");
  clone.style.setProperty("--popover-foreground", "0 0% 0%");
  clone.style.setProperty("--muted", "0 0% 96%");
  clone.style.setProperty("--muted-foreground", "0 0% 45%");
  clone.style.setProperty("--border", "0 0% 90%");

  const styleEl = document.createElement("style");
  styleEl.textContent = `
      svg text, svg tspan { fill: hsl(var(--foreground)) !important; }
    `;
  clone.prepend(styleEl);

  const wrapper = document.createElement("div");
  wrapper.style.position = "fixed";
  wrapper.style.left = "-100000px";
  wrapper.style.top = "0";
  wrapper.style.width = `${width}px`;
  wrapper.style.height = `${height}px`;
  wrapper.style.pointerEvents = "none";
  wrapper.style.zIndex = "-1";
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);

  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return await toJpeg(clone, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: "white",
      quality: 0.85,
    });
  } finally {
    document.body.removeChild(wrapper);
  }
}

export async function compositeChartImages(
  dataUrls: string[],
  cols: number,
  cellSize?: { width: number; height: number },
  options?: {
    targetAspect?: number;
    gap?: number;
    background?: string;
    fit?: "contain" | "cover";
  },
): Promise<string> {
  if (dataUrls.length === 0) return "";
  const gap = options?.gap ?? 0;
  const background = options?.background ?? "white";
  const fit = options?.fit ?? "contain";
  const images = await Promise.all(dataUrls.map((src) => loadImage(src)));
  const maxW = cellSize?.width ?? Math.max(...images.map((img) => img.width));
  const maxH = cellSize?.height ?? Math.max(...images.map((img) => img.height));
  const rows = Math.ceil(images.length / cols);

  const targetAspect = options?.targetAspect;
  const validTargetAspect = !!targetAspect && Number.isFinite(targetAspect) && targetAspect > 0;
  if (!validTargetAspect) {
    const gridW = cols * maxW + (cols - 1) * gap;
    const gridH = rows * maxH + (rows - 1) * gap;
    const canvas = document.createElement("canvas");
    canvas.width = gridW;
    canvas.height = gridH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrls[0];
    ctx.imageSmoothingEnabled = true;
    (ctx as unknown as { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawImagesOnGrid(ctx, images, cols, maxW, maxH, gap, background, fit);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  const target = targetAspect as number;
  const candA_W = Math.max(1, Math.round(cols * maxW + (cols - 1) * gap));
  const candA_H = Math.max(1, Math.round(candA_W / target));
  const candA_cellW = (candA_W - (cols - 1) * gap) / cols;
  const candA_cellH = (candA_H - (rows - 1) * gap) / rows;
  const candA_scale = Math.min(candA_cellW / maxW, candA_cellH / maxH);

  const candB_H = Math.max(1, Math.round(rows * maxH + (rows - 1) * gap));
  const candB_W = Math.max(1, Math.round(candB_H * target));
  const candB_cellW = (candB_W - (cols - 1) * gap) / cols;
  const candB_cellH = (candB_H - (rows - 1) * gap) / rows;
  const candB_scale = Math.min(candB_cellW / maxW, candB_cellH / maxH);

  const canvasW = candB_scale > candA_scale ? candB_W : candA_W;
  const canvasH = candB_scale > candA_scale ? candB_H : candA_H;
  const cellW = (canvasW - (cols - 1) * gap) / cols;
  const cellH = (canvasH - (rows - 1) * gap) / rows;

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrls[0];
  ctx.imageSmoothingEnabled = true;
  (ctx as unknown as { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawImagesOnGrid(ctx, images, cols, cellW, cellH, gap, background, fit);
  return canvas.toDataURL("image/jpeg", 0.82);
}
