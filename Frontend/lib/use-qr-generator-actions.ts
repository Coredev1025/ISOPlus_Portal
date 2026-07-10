import { useCallback } from 'react';
import axios from '@/app/utils/axiosConfig';
import QRCode from 'qrcode';
import {
  fetchBusinessLogoBlobUrl,
  hasBusinessLogo,
  resolveQrLogoField,
  revokeBlobUrl,
} from '@/lib/business-logo';
import {
  canvasToPngBlob,
  downloadCanvasPng,
  isTaintedCanvasError,
  openCanvasInNewTab,
  writePngBlobToClipboard,
} from '@/lib/qr-clipboard-helpers';
import {
  getQrGenerationError,
  renderQrCodeOnCanvas,
  resolveQrTargetUrl,
  getQrDownloadFilename,
  downloadQrCanvas,
  copyQrCanvasWithFallbacks,
} from '@/lib/qr-generator-helpers';
import { showFetchErrorToast, showSuccessToast } from '@/lib/toast-utils';

export function useQrGeneratorActions({
  selectedId,
  customUrl,
  customUrlSelectionId,
  items,
  drawLogo,
  business,
  workspaceId,
  canvasRef,
  qrCodeGenerated,
  setGenerating,
  setLastGeneratedUrl,
  setQrCodeGenerated,
}: {
  selectedId: string;
  customUrl: string;
  customUrlSelectionId: string;
  items: Array<{ id: string; url: string }>;
  drawLogo: boolean;
  business?: { defaultLogo?: string; squareLogo?: string; wideLogo?: string };
  workspaceId: string;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  qrCodeGenerated: boolean;
  setGenerating: (value: boolean) => void;
  setLastGeneratedUrl: (value: string) => void;
  setQrCodeGenerated: (value: boolean) => void;
}) {
  const generateQRCode = useCallback(async () => {
    const targetUrl = resolveQrTargetUrl(selectedId, customUrl, customUrlSelectionId, items);
    if (!targetUrl) {
      const message = getQrGenerationError(selectedId, customUrlSelectionId);
      if (message) showFetchErrorToast('QR code', message);
      return;
    }

    try {
      setGenerating(true);
      const canvas = canvasRef.current;
      if (!canvas) throw new Error('Canvas not available');

      await renderQrCodeOnCanvas(canvas, targetUrl, {
        drawLogo,
        business,
        workspaceId,
        fetchBusinessLogoBlobUrl,
        hasBusinessLogo,
        resolveQrLogoField,
        revokeBlobUrl,
        QRCode,
      });

      setLastGeneratedUrl(targetUrl);
      setQrCodeGenerated(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to generate QR code';
      console.error('Error generating QR code:', error);
      showFetchErrorToast('QR code', message);
    } finally {
      setGenerating(false);
    }
  }, [selectedId, customUrl, customUrlSelectionId, items, drawLogo, business, workspaceId, canvasRef, setGenerating, setLastGeneratedUrl, setQrCodeGenerated]);

  const downloadQRCode = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !qrCodeGenerated) return;
    downloadQrCanvas(canvas, getQrDownloadFilename(selectedId, customUrlSelectionId), showFetchErrorToast);
  }, [canvasRef, qrCodeGenerated, selectedId, customUrlSelectionId]);

  const copyQRCodeToClipboard = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || !qrCodeGenerated) return;
    await copyQrCanvasWithFallbacks(canvas, getQrDownloadFilename(selectedId, customUrlSelectionId), {
      canvasToPngBlob,
      writePngBlobToClipboard,
      downloadCanvasPng,
      openCanvasInNewTab,
      isTaintedCanvasError,
      showFetchErrorToast,
      showSuccessToast,
    });
  }, [canvasRef, qrCodeGenerated, selectedId, customUrlSelectionId]);

  return { generateQRCode, downloadQRCode, copyQRCodeToClipboard };
}
