import type { AxiosInstance } from 'axios';
import { downloadGeneratedPdfViaBackend } from '@/lib/pdf-download-helpers';

const ISO_TRADEMARK = 'ISO+\u2122';

/**
 * Download name for an invoice PDF.
 *
 * Prefer the stored S3 object name (last path segment). That is the name the
 * browser saved when it opened the bucket URL directly:
 * `INV-1109-ISO+™-Jane-Smith.pdf`. The ™ stays in `link.download`; the proxy
 * puts only an ASCII fallback in the `filename=` header.
 *
 * When the URL has no `.pdf` name, build the same shape from the invoice
 * number and participant (spaces become hyphens, matching the stored key).
 */
export function invoicePdfDownloadFilename({
  fileUrl,
  invoiceNumber,
  participantName,
}: {
  fileUrl?: string;
  invoiceNumber?: string;
  participantName?: string;
}): string {
  const fromKey = pdfNameFromFileUrl(fileUrl);
  if (fromKey) return fromKey;

  const raw = String(invoiceNumber || 'INV').trim();
  const suffix = ` (${ISO_TRADEMARK})`;
  const base = (raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw).trim() || 'INV';
  const participant = String(participantName || 'Participant').trim().replace(/\s+/g, '-') || 'Participant';
  return `${base}-${ISO_TRADEMARK}-${participant}.pdf`;
}

function pdfNameFromFileUrl(fileUrl?: string): string | null {
  if (!fileUrl) return null;
  const last = String(fileUrl).split(/[?#]/)[0].split('/').pop() || '';
  if (!last || !/\.pdf$/i.test(last)) return null;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded.includes('..')) return null;
  return decoded;
}

export async function downloadInvoicePdf(
  fileUrl: string,
  invoiceNumber: string,
  participantName: string,
  workspaceId: string,
  axios: AxiosInstance,
) {
  await downloadGeneratedPdfViaBackend({
    fileUrl,
    filename: invoicePdfDownloadFilename({ fileUrl, invoiceNumber, participantName }),
    workspaceId,
    axios,
  });
}

export async function updateLegacyInvoiceStatuses({
  id,
  boardId,
  selectedItems,
  invoiceNumber,
  fileUrl,
  axios,
}: {
  id: string;
  boardId: string;
  selectedItems: Set<string>;
  invoiceNumber: string;
  fileUrl?: string;
  axios: AxiosInstance;
}) {
  const updateUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/update-status`;
  await axios.post(updateUrl, {
    itemIds: Array.from(selectedItems),
    invoiceNumber,
    status: 'invoiced',
    fileUrl,
  }, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });
}

export async function finalizePdfInvoiceGeneration({
  respData,
  isNdisBoard,
  id,
  boardId,
  selectedItems,
  participantName,
  invoiceLabel,
  fileUrl,
  itemCount,
  axios,
  showErrorToast,
  showInfoToast,
  showSuccessToast,
  setShowInvoiceModal,
  handleManualRefresh,
  isGeneratingInvoiceRef,
}: {
  respData: { invoiceNumber?: string; message?: string };
  isNdisBoard: boolean;
  id: string;
  boardId: string;
  selectedItems: Set<string>;
  participantName: string;
  invoiceLabel: string;
  fileUrl?: string;
  itemCount: number;
  axios: AxiosInstance;
  showErrorToast: (message: string, options?: { description?: string }) => void;
  showInfoToast: (message: string, options?: { description?: string }) => void;
  showSuccessToast: (message: string, options?: { description?: string }) => void;
  setShowInvoiceModal: (open: boolean) => void;
  handleManualRefresh: (silent?: boolean) => void;
  isGeneratingInvoiceRef: { current: boolean };
}) {
  const { invoiceNumber } = respData;
  if (!invoiceNumber) {
    isGeneratingInvoiceRef.current = false;
    const reason = respData.message || 'Invoice could not be generated.';
    showErrorToast(`Failed to generate ${invoiceLabel}`, { description: reason });
    return;
  }

  if (!isNdisBoard) {
    try {
      await updateLegacyInvoiceStatuses({ id, boardId, selectedItems, invoiceNumber, fileUrl, axios });
    } catch (updateErr) {
      console.error('Error updating item statuses:', updateErr);
      showInfoToast('Invoice generated but status update failed', {
        description: 'The invoice was created but item statuses could not be updated. Please refresh the page.',
      });
    }
  }

  if (fileUrl) {
    try {
      await downloadInvoicePdf(fileUrl, invoiceNumber, participantName, id, axios);
    } catch (downloadErr) {
      console.error('Error downloading PDF:', downloadErr);
      window.open(fileUrl, '_blank');
      showInfoToast('PDF opened in new tab', {
        description: 'Download failed, opened PDF in new tab instead.',
      });
    }
  }

  setShowInvoiceModal(false);
  showSuccessToast(`${invoiceLabel} generated`, {
    description: `Invoice ${invoiceNumber} for ${participantName} (${itemCount} item${itemCount === 1 ? '' : 's'}) created. You can download it from the PDF Download column in the Service Records table.`,
  });
  setTimeout(() => {
    handleManualRefresh(true);
    setTimeout(() => {
      isGeneratingInvoiceRef.current = false;
    }, 2000);
  }, 1000);
}
