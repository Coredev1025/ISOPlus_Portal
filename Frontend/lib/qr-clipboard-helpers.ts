export function isTaintedCanvasError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('tainted') ||
    message.includes('security') ||
    message.includes('cors')
  );
}

export async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) {
    throw new Error('Failed to get canvas context');
  }

  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  tempCtx.drawImage(canvas, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    tempCanvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to create blob from canvas'));
    }, 'image/png');
  });
}

export async function writePngBlobToClipboard(blob: Blob): Promise<void> {
  if (!navigator.clipboard || !window.ClipboardItem) {
    throw new Error('Clipboard API not available');
  }
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': blob }),
  ]);
}

export function openCanvasInNewTab(canvas: HTMLCanvasElement): boolean {
  const dataUrl = canvas.toDataURL('image/png');
  const newWindow = window.open();
  if (!newWindow) return false;
  newWindow.document.write(`<img src="${dataUrl}" alt="QR Code">`);
  return true;
}

export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
