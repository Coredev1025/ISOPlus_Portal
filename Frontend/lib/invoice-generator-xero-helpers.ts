import type { AxiosInstance } from 'axios';

export async function updateXeroInvoiceItemStatuses({
  id,
  boardId,
  selectedItems,
  invoiceNumber,
  axios,
}: {
  id: string;
  boardId: string;
  selectedItems: Set<string>;
  invoiceNumber: string;
  axios: AxiosInstance;
}) {
  const updateUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/update-status`;
  await axios.post(updateUrl, {
    itemIds: Array.from(selectedItems),
    invoiceNumber,
    status: 'invoiced',
  }, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });
}

export async function finalizeXeroInvoiceGeneration({
  respData,
  isNdisBoard,
  id,
  boardId,
  selectedItems,
  participantName,
  invoiceLabel,
  invoiceUrl,
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
  invoiceUrl?: string;
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
    const reason = respData.message || 'Invoice could not be created in Xero.';
    showErrorToast(`Failed to generate Xero ${invoiceLabel}`, { description: reason });
    return;
  }

  if (!isNdisBoard) {
    try {
      await updateXeroInvoiceItemStatuses({ id, boardId, selectedItems, invoiceNumber, axios });
    } catch (updateErr) {
      console.error('Error updating item statuses:', updateErr);
      showInfoToast('Xero invoice created but status update failed', {
        description: 'The invoice was created in Xero but item statuses could not be updated. Please refresh the page.',
      });
    }
  }

  if (invoiceUrl) {
    window.open(invoiceUrl, '_blank');
  }

  setShowInvoiceModal(false);
  showSuccessToast(`Xero ${invoiceLabel} generated`, {
    description: `Invoice ${invoiceNumber} for ${participantName} (${itemCount} item${itemCount === 1 ? '' : 's'}) created in Xero.`,
  });

  setTimeout(() => {
    handleManualRefresh(true);
    setTimeout(() => {
      isGeneratingInvoiceRef.current = false;
    }, 2000);
  }, 1000);
}

export async function generateXeroInvoiceFromModal({
  selectedItems,
  invoiceDate,
  dueDate,
  eligibleRecords,
  isNdisBoard,
  isLowCatBoard,
  id,
  boardId,
  invoiceLabel,
  axios,
  showErrorToast,
  showInfoToast,
  showSuccessToast,
  setShowInvoiceModal,
  handleManualRefresh,
  isGeneratingInvoiceRef,
  setGeneratingXero,
  validateInvoiceGenerationInputs,
  buildInvoiceItemIds,
}: {
  selectedItems: Set<string>;
  invoiceDate: string;
  dueDate: string;
  eligibleRecords: Array<{ id: string; participant?: string; sourceItemId?: string }>;
  isNdisBoard: boolean;
  isLowCatBoard: boolean;
  id: string;
  boardId: string;
  invoiceLabel: string;
  axios: AxiosInstance;
  showErrorToast: (message: string, options?: { description?: string }) => void;
  showInfoToast: (message: string, options?: { description?: string }) => void;
  showSuccessToast: (message: string, options?: { description?: string }) => void;
  setShowInvoiceModal: (open: boolean) => void;
  handleManualRefresh: (silent?: boolean) => void;
  isGeneratingInvoiceRef: { current: boolean };
  setGeneratingXero: (value: boolean) => void;
  validateInvoiceGenerationInputs: (selectedCount: number, invoiceDate: string, dueDate: string) => string | null;
  buildInvoiceItemIds: <T extends { id: string; sourceItemId?: string }>(records: T[], isNdis: boolean) => string[];
}) {
  const validationError = validateInvoiceGenerationInputs(selectedItems.size, invoiceDate, dueDate);
  if (validationError) {
    showErrorToast(validationError);
    return;
  }

  const selectedRecords = eligibleRecords.filter((record) => selectedItems.has(record.id));
  if (!selectedRecords.length) {
    showErrorToast('No items selected for invoice generation.');
    return;
  }

  const participantName = selectedRecords[0]?.participant || '';

  setGeneratingXero(true);
  isGeneratingInvoiceRef.current = true;

  try {
    const apiUrl = isNdisBoard
      ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/xero/${id}/${boardId}/invoicendis-invoice-generator`
      : `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/xero/${id}/${boardId}/invoiceparticipanttax`;

    const payload = {
      itemIds: buildInvoiceItemIds(selectedRecords, isNdisBoard),
      items: selectedRecords,
      participantName,
      invoiceDate,
      dueDate,
      isLowCat: isLowCatBoard,
    };

    const resp = await axios.post(apiUrl, payload, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    if (resp.status === 200 && resp.data) {
      await finalizeXeroInvoiceGeneration({
        respData: resp.data,
        isNdisBoard,
        id,
        boardId,
        selectedItems,
        participantName,
        invoiceLabel,
        invoiceUrl: resp.data.invoiceUrl,
        itemCount: resp.data.itemCount,
        axios,
        showErrorToast,
        showInfoToast,
        showSuccessToast,
        setShowInvoiceModal,
        handleManualRefresh,
        isGeneratingInvoiceRef,
      });
      return;
    }

    isGeneratingInvoiceRef.current = false;
    showErrorToast('Unexpected response while generating Xero invoice');
  } catch (err: any) {
    console.error('Error generating Xero invoice', err);
    isGeneratingInvoiceRef.current = false;
    const errorMessage = err.response?.data?.message || err.message || 'Unknown error occurred';
    showErrorToast('Failed to generate Xero invoice', { description: errorMessage });
  } finally {
    setGeneratingXero(false);
  }
}
