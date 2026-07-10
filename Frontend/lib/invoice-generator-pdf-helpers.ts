import type { AxiosInstance } from 'axios';

export async function downloadInvoicePdf(fileUrl: string, invoiceNumber: string, participantName: string) {
  const pdfResponse = await fetch(fileUrl);
  const pdfBlob = await pdfResponse.blob();
  const pdfUrl = URL.createObjectURL(pdfBlob);
  const link = document.createElement('a');
  link.href = pdfUrl;
  link.download = `Invoice_${invoiceNumber}_${participantName.replace(/\s+/g, '_')}.pdf`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();

  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(pdfUrl);
  }, 100);
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
      await downloadInvoicePdf(fileUrl, invoiceNumber, participantName);
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
