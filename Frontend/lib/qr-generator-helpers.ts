import axios from '@/app/utils/axiosConfig';
import type { LogoField } from '@/lib/business-logo';

export function normalizeUrlForQr(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  try {
    if (/^https?:\/\//i.test(t)) {
      new URL(t);
      return t;
    }
    const withScheme = `https://${t}`;
    new URL(withScheme);
    return withScheme;
  } catch {
    return null;
  }
}

export async function fetchQrGeneratorPageData(workspaceId: string, boardId: string) {
  const [boardsResponse, businessResponse, viewsResponse] = await Promise.all([
    axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/boards?workspaceId=${workspaceId}`),
    axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`, { params: { workspaceId } }),
    axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/boards/views-for-qr?workspaceId=${workspaceId}&boardId=${boardId}`),
  ]);

  const boardData = boardsResponse.data.board.find((b: { id: string }) => b.id == boardId);
  const viewsData = viewsResponse.data.views || [];
  const items = viewsData
    .map((v: { id: string; name: string; url: string; type: 'form' | 'document' }) => ({
      id: v.id,
      name: v.name,
      url: v.url,
      type: v.type,
    }))
    .sort((a: { name: string }, b: { name: string }) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
    );

  return { boardData, businessData: businessResponse.data, items };
}

export function getQrGenerationError(selectedId: string, customUrlSelectionId: string): string | null {
  if (!selectedId) {
    return 'Select a form, document, or Custom URL from the list.';
  }
  if (selectedId === customUrlSelectionId) {
    return 'Enter a valid link (e.g. https://example.com).';
  }
  return 'Selected item has no URL.';
}

export async function overlayLogoOnQrCanvas(canvas: HTMLCanvasElement, logoUrl: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas context not available'));
      return;
    }

    const logoImage = new window.Image();
    logoImage.onload = () => {
      try {
        const logoSize = Math.min(canvas.width, canvas.height) * 0.15;
        const logoX = (canvas.width - logoSize) / 2;
        const logoY = (canvas.height - logoSize) / 2;
        const padding = logoSize * 0.2;
        const bgSize = logoSize + (padding * 2);
        const bgX = logoX - padding;
        const bgY = logoY - padding;
        const borderRadius = padding * 0.5;

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(bgX + borderRadius, bgY);
        ctx.lineTo(bgX + bgSize - borderRadius, bgY);
        ctx.quadraticCurveTo(bgX + bgSize, bgY, bgX + bgSize, bgY + borderRadius);
        ctx.lineTo(bgX + bgSize, bgY + bgSize - borderRadius);
        ctx.quadraticCurveTo(bgX + bgSize, bgY + bgSize, bgX + bgSize - borderRadius, bgY + bgSize);
        ctx.lineTo(bgX + borderRadius, bgY + bgSize);
        ctx.quadraticCurveTo(bgX, bgY + bgSize, bgX, bgY + bgSize - borderRadius);
        ctx.lineTo(bgX, bgY + borderRadius);
        ctx.quadraticCurveTo(bgX, bgY, bgX + borderRadius, bgY);
        ctx.closePath();
        ctx.fill();

        ctx.drawImage(logoImage, logoX, logoY, logoSize, logoSize);

        resolve();
      } catch (error) {
        console.error('Error drawing logo:', error);
        resolve();
      }
    };

    logoImage.onerror = () => {
      console.warn('Failed to load logo, using QR code without logo');
      resolve();
    };

    logoImage.onabort = () => {
      console.warn('Logo loading aborted, using QR code without logo');
      resolve();
    };

    logoImage.src = logoUrl;
  });
}

export async function renderQrCodeOnCanvas(
  canvas: HTMLCanvasElement,
  targetUrl: string,
  options: {
    drawLogo: boolean;
    business?: { defaultLogo?: string; squareLogo?: string; wideLogo?: string };
    workspaceId: string;
    fetchBusinessLogoBlobUrl: (workspaceId: string, field?: LogoField) => Promise<string | null>;
    hasBusinessLogo: (business?: { defaultLogo?: string; squareLogo?: string; wideLogo?: string }) => boolean;
    resolveQrLogoField: (business?: { defaultLogo?: string; squareLogo?: string; wideLogo?: string }) => LogoField | undefined;
    revokeBlobUrl: (url: string) => void;
    QRCode: { toCanvas: (canvas: HTMLCanvasElement, text: string, options: object) => Promise<void> };
  },
): Promise<void> {
  canvas.width = 400;
  canvas.height = 400;

  await options.QRCode.toCanvas(canvas, targetUrl, {
    errorCorrectionLevel: 'H',
    margin: 3,
    color: { dark: '#000000', light: '#ffffff' },
    width: 400,
  });

  if (!options.drawLogo || !options.hasBusinessLogo(options.business)) {
    return;
  }

  const logoField = options.resolveQrLogoField(options.business);
  const logoBlobUrl = logoField
    ? await options.fetchBusinessLogoBlobUrl(options.workspaceId, logoField)
    : await options.fetchBusinessLogoBlobUrl(options.workspaceId);

  if (!logoBlobUrl) return;

  try {
    await overlayLogoOnQrCanvas(canvas, logoBlobUrl);
  } finally {
    options.revokeBlobUrl(logoBlobUrl);
  }
}

export function filterFormDocumentRows(
  value: string,
  search: string,
  customUrlSelectionId: string,
  items: Array<{ id: string; name: string; url: string; type: string }>,
): number {
  if (String(value) === customUrlSelectionId) {
    return 1;
  }
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const row = items.find((i) => String(i.id) === value);
  if (!row) return 0;
  const haystack = [row.name, String(row.id), row.url, row.type].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q) ? 1 : 0;
}

export function getQrDownloadFilename(selectedId: string, customUrlSelectionId: string): string {
  const suffix = !selectedId || selectedId === customUrlSelectionId ? 'custom-link' : selectedId;
  return `qr-code-${suffix}.png`;
}

export function downloadQrCanvas(
  canvas: HTMLCanvasElement,
  filename: string,
  showFetchErrorToast: (title: string, message: string) => void,
) {
  try {
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (error) {
    console.error('Error downloading QR code:', error);
    if (error instanceof Error && error.message.includes('tainted')) {
      showFetchErrorToast('QR code', 'Cannot download QR code with logo due to security restrictions. Try taking a screenshot instead.');
      return;
    }
    showFetchErrorToast('QR code', 'Failed to download QR code due to security restrictions');
  }
}

export async function copyQrCanvasWithFallbacks(
  canvas: HTMLCanvasElement,
  filename: string,
  helpers: {
    canvasToPngBlob: (canvas: HTMLCanvasElement) => Promise<Blob>;
    writePngBlobToClipboard: (blob: Blob) => Promise<void>;
    downloadCanvasPng: (canvas: HTMLCanvasElement, filename: string) => void;
    openCanvasInNewTab: (canvas: HTMLCanvasElement) => boolean;
    isTaintedCanvasError: (error: unknown) => boolean;
    showFetchErrorToast: (title: string, message: string) => void;
    showSuccessToast: (message: string) => void;
  },
) {
  if (!navigator.clipboard || !window.ClipboardItem) {
    helpers.showFetchErrorToast("Clipboard", "Your browser doesn't support copying images to clipboard. Try downloading instead.");
    return;
  }

  try {
    const blob = await helpers.canvasToPngBlob(canvas);
    await helpers.writePngBlobToClipboard(blob);
    helpers.showSuccessToast('QR code copied to clipboard successfully!');
  } catch (error) {
    console.error('Error copying QR code to clipboard:', error);
    if (helpers.isTaintedCanvasError(error)) {
      helpers.showFetchErrorToast('QR code', 'Cannot copy QR code with logo due to security restrictions. Try regenerating without logo or downloading instead.');
      return;
    }

    try {
      helpers.downloadCanvasPng(canvas, filename);
      helpers.showSuccessToast('QR code downloaded (clipboard not available)');
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError);
      try {
        if (helpers.openCanvasInNewTab(canvas)) {
          helpers.showSuccessToast('QR code opened in a new tab');
        }
      } catch (secondFallbackError) {
        console.error('Second fallback also failed:', secondFallbackError);
        helpers.showFetchErrorToast('QR code', 'Unable to export QR code. Please try taking a screenshot or regenerating without logo.');
      }
    }
  }
}

export function resolveQrTargetUrl(
  selectedId: string,
  customUrl: string,
  customUrlSelectionId: string,
  items: Array<{ id: string; url: string }>,
): string | null {
  if (selectedId === customUrlSelectionId) {
    return normalizeUrlForQr(customUrl);
  }
  if (selectedId) {
    const item = items.find((f) => String(f.id) === String(selectedId));
    return item?.url ?? null;
  }
  return null;
}
