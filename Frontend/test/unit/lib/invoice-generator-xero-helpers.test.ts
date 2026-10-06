import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AxiosInstance } from 'axios';

import {
  updateXeroInvoiceItemStatuses,
  finalizeXeroInvoiceGeneration,
  generateXeroInvoiceFromModal,
} from '@/lib/invoice-generator-xero-helpers';
import { validateInvoiceGenerationInputs, buildInvoiceItemIds } from '@/lib/invoice-generator-helpers';

const XERO_URL = 'https://go.xero.com/invoice/INV-1001';

let openSpy: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  openSpy.mockRestore();
  consoleError.mockRestore();
});

describe('updateXeroInvoiceItemStatuses', () => {
  it('marks the selected items invoiced and sends no file URL', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: {} });

    await updateXeroInvoiceItemStatuses({
      id: 'ws-1',
      boardId: 'board-9',
      selectedItems: new Set(['item-1:0', 'item-2:0']),
      invoiceNumber: 'INV-1001',
      axios: { post } as unknown as AxiosInstance,
    });

    expect(post).toHaveBeenCalledWith(
      'http://localhost:4001/api/items/ws-1/board-9/update-status',
      { itemIds: ['item-1:0', 'item-2:0'], invoiceNumber: 'INV-1001', status: 'invoiced' },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
    );
  });
});

function makeFinalizeHarness(post = vi.fn().mockResolvedValue({ status: 200, data: {} })) {
  const isGeneratingInvoiceRef = { current: true };
  const showErrorToast = vi.fn();
  const showInfoToast = vi.fn();
  const showSuccessToast = vi.fn();
  const setShowInvoiceModal = vi.fn();
  const handleManualRefresh = vi.fn();

  return {
    post,
    isGeneratingInvoiceRef,
    showErrorToast,
    showInfoToast,
    showSuccessToast,
    setShowInvoiceModal,
    handleManualRefresh,
    args: {
      respData: { invoiceNumber: 'INV-1001' } as { invoiceNumber?: string; message?: string },
      isNdisBoard: false,
      id: 'ws-1',
      boardId: 'board-9',
      selectedItems: new Set(['item-1:0', 'item-2:0']),
      participantName: 'Jane Doe',
      invoiceLabel: 'Invoice',
      invoiceUrl: undefined as string | undefined,
      itemCount: 2,
      axios: { post } as unknown as AxiosInstance,
      showErrorToast,
      showInfoToast,
      showSuccessToast,
      setShowInvoiceModal,
      handleManualRefresh,
      isGeneratingInvoiceRef,
    },
  };
}

describe('finalizeXeroInvoiceGeneration', () => {
  it('aborts with the Xero error message when no invoice number came back', async () => {
    const h = makeFinalizeHarness();

    await finalizeXeroInvoiceGeneration({
      ...h.args,
      respData: { message: 'Contact not found in Xero' },
    });

    expect(h.showErrorToast).toHaveBeenCalledWith('Failed to generate Xero Invoice', {
      description: 'Contact not found in Xero',
    });
    expect(h.isGeneratingInvoiceRef.current).toBe(false);
    expect(h.post).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(h.setShowInvoiceModal).not.toHaveBeenCalled();
  });

  it('falls back to a generic Xero reason', async () => {
    const h = makeFinalizeHarness();
    await finalizeXeroInvoiceGeneration({ ...h.args, respData: {}, invoiceLabel: 'Quote' });
    expect(h.showErrorToast).toHaveBeenCalledWith('Failed to generate Xero Quote', {
      description: 'Invoice could not be created in Xero.',
    });
  });

  it('marks the items invoiced, opens Xero and reports success on a standard board', async () => {
    const h = makeFinalizeHarness();

    await finalizeXeroInvoiceGeneration({ ...h.args, invoiceUrl: XERO_URL });

    expect(h.post).toHaveBeenCalledWith(
      'http://localhost:4001/api/items/ws-1/board-9/update-status',
      { itemIds: ['item-1:0', 'item-2:0'], invoiceNumber: 'INV-1001', status: 'invoiced' },
      expect.any(Object),
    );
    expect(openSpy).toHaveBeenCalledWith(XERO_URL, '_blank');
    expect(h.setShowInvoiceModal).toHaveBeenCalledWith(false);
    expect(h.showSuccessToast).toHaveBeenCalledWith('Xero Invoice generated', {
      description: 'Invoice INV-1001 for Jane Doe (2 items) created in Xero.',
    });
  });

  it('uses the singular noun for a one-item invoice', async () => {
    const h = makeFinalizeHarness();
    await finalizeXeroInvoiceGeneration({ ...h.args, itemCount: 1 });
    expect(h.showSuccessToast).toHaveBeenCalledWith('Xero Invoice generated', {
      description: 'Invoice INV-1001 for Jane Doe (1 item) created in Xero.',
    });
  });

  it('skips the status update on an NDIS board', async () => {
    const h = makeFinalizeHarness();
    await finalizeXeroInvoiceGeneration({ ...h.args, isNdisBoard: true });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.showSuccessToast).toHaveBeenCalled();
  });

  it('still reports success when the status update fails', async () => {
    const h = makeFinalizeHarness(vi.fn().mockRejectedValue(new Error('Request failed with status code 500')));

    await finalizeXeroInvoiceGeneration(h.args);

    expect(h.showInfoToast).toHaveBeenCalledWith('Xero invoice created but status update failed', {
      description:
        'The invoice was created in Xero but item statuses could not be updated. Please refresh the page.',
    });
    expect(h.showSuccessToast).toHaveBeenCalled();
  });

  it('opens nothing when Xero returned no invoice URL', async () => {
    const h = makeFinalizeHarness();
    await finalizeXeroInvoiceGeneration(h.args);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('refreshes a second later and releases the generating flag two seconds after that', async () => {
    const h = makeFinalizeHarness();

    await finalizeXeroInvoiceGeneration(h.args);
    expect(h.handleManualRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(h.handleManualRefresh).toHaveBeenCalledWith(true);
    expect(h.isGeneratingInvoiceRef.current).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(h.isGeneratingInvoiceRef.current).toBe(false);
  });
});

const eligibleRecords = [
  { id: 'item-1:0', sourceItemId: 'item-1', participant: 'Jane Doe' },
  { id: 'item-1:1', sourceItemId: 'item-1', participant: 'Jane Doe' },
  { id: 'item-2:0', sourceItemId: 'item-2', participant: 'Jane Doe' },
  { id: 'item-3:0', sourceItemId: 'item-3', participant: 'John Smith' },
];

function makeGenerateHarness(post: ReturnType<typeof vi.fn>) {
  const isGeneratingInvoiceRef = { current: false };
  const generating: boolean[] = [];
  const showErrorToast = vi.fn();
  const showInfoToast = vi.fn();
  const showSuccessToast = vi.fn();
  const setShowInvoiceModal = vi.fn();
  const handleManualRefresh = vi.fn();

  return {
    post,
    isGeneratingInvoiceRef,
    generating,
    showErrorToast,
    showInfoToast,
    showSuccessToast,
    setShowInvoiceModal,
    handleManualRefresh,
    args: {
      selectedItems: new Set(['item-1:0', 'item-1:1', 'item-2:0']),
      invoiceDate: '2026-03-01',
      dueDate: '2026-03-31',
      eligibleRecords,
      isNdisBoard: false,
      isLowCatBoard: false,
      id: 'ws-1',
      boardId: 'board-9',
      invoiceLabel: 'Invoice',
      axios: { post } as unknown as AxiosInstance,
      showErrorToast,
      showInfoToast,
      showSuccessToast,
      setShowInvoiceModal,
      handleManualRefresh,
      isGeneratingInvoiceRef,
      setGeneratingXero: (value: boolean) => generating.push(value),
      validateInvoiceGenerationInputs,
      buildInvoiceItemIds,
    },
  };
}

describe('generateXeroInvoiceFromModal', () => {
  it('refuses to call Xero when the inputs are incomplete', async () => {
    const h = makeGenerateHarness(vi.fn());

    await generateXeroInvoiceFromModal({ ...h.args, invoiceDate: '' });

    expect(h.showErrorToast).toHaveBeenCalledWith('Please enter an invoice date.');
    expect(h.post).not.toHaveBeenCalled();
    expect(h.generating).toEqual([]);
    expect(h.isGeneratingInvoiceRef.current).toBe(false);
  });

  it('refuses when nothing is selected', async () => {
    const h = makeGenerateHarness(vi.fn());
    await generateXeroInvoiceFromModal({ ...h.args, selectedItems: new Set() });
    expect(h.showErrorToast).toHaveBeenCalledWith('Please select at least one item to include in the invoice.');
    expect(h.post).not.toHaveBeenCalled();
  });

  it('refuses when the selection matches none of the eligible records', async () => {
    const h = makeGenerateHarness(vi.fn());

    await generateXeroInvoiceFromModal({ ...h.args, selectedItems: new Set(['item-99:0']) });

    expect(h.showErrorToast).toHaveBeenCalledWith('No items selected for invoice generation.');
    expect(h.post).not.toHaveBeenCalled();
    expect(h.generating).toEqual([]);
  });

  it('posts the selected records to the participant-tax route on a standard board', async () => {
    const post = vi.fn().mockResolvedValue({
      status: 200,
      data: { invoiceNumber: 'INV-1001', invoiceUrl: XERO_URL, itemCount: 3 },
    });
    const h = makeGenerateHarness(post);

    await generateXeroInvoiceFromModal(h.args);

    expect(post).toHaveBeenNthCalledWith(
      1,
      'http://localhost:4001/api/xero/ws-1/board-9/invoiceparticipanttax',
      {
        itemIds: ['item-1:0', 'item-1:1', 'item-2:0'],
        items: [eligibleRecords[0], eligibleRecords[1], eligibleRecords[2]],
        participantName: 'Jane Doe',
        invoiceDate: '2026-03-01',
        dueDate: '2026-03-31',
        isLowCat: false,
      },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
    );
    expect(h.generating).toEqual([true, false]);
  });

  it('collapses the NDIS selection to parent item ids and posts to the NDIS route', async () => {
    const post = vi.fn().mockResolvedValue({
      status: 200,
      data: { invoiceNumber: 'INV-1001', itemCount: 3 },
    });
    const h = makeGenerateHarness(post);

    await generateXeroInvoiceFromModal({ ...h.args, isNdisBoard: true, isLowCatBoard: true });

    expect(post.mock.calls[0][0]).toBe('http://localhost:4001/api/xero/ws-1/board-9/invoicendis-invoice-generator');
    expect(post.mock.calls[0][1]).toMatchObject({
      itemIds: ['item-1', 'item-2'],
      participantName: 'Jane Doe',
      isLowCat: true,
    });
    // NDIS boards do not get the follow-up status update.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('takes the participant name from the first selected record and tolerates it being absent', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: { invoiceNumber: 'INV-1001', itemCount: 1 } });
    const h = makeGenerateHarness(post);

    await generateXeroInvoiceFromModal({
      ...h.args,
      eligibleRecords: [{ id: 'item-7:0' }, { id: 'item-8:0', participant: 'John Smith' }],
      selectedItems: new Set(['item-7:0', 'item-8:0']),
    });

    expect(post.mock.calls[0][1].participantName).toBe('');
  });

  it('finalizes the invoice on a 200 response, updating statuses and reporting success', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, data: { invoiceNumber: 'INV-1001', invoiceUrl: XERO_URL, itemCount: 3 } })
      .mockResolvedValueOnce({ status: 200, data: {} });
    const h = makeGenerateHarness(post);

    await generateXeroInvoiceFromModal(h.args);

    expect(post).toHaveBeenNthCalledWith(
      2,
      'http://localhost:4001/api/items/ws-1/board-9/update-status',
      { itemIds: ['item-1:0', 'item-1:1', 'item-2:0'], invoiceNumber: 'INV-1001', status: 'invoiced' },
      expect.any(Object),
    );
    expect(openSpy).toHaveBeenCalledWith(XERO_URL, '_blank');
    expect(h.showSuccessToast).toHaveBeenCalledWith('Xero Invoice generated', {
      description: 'Invoice INV-1001 for Jane Doe (3 items) created in Xero.',
    });
    expect(h.setShowInvoiceModal).toHaveBeenCalledWith(false);
  });

  it('clears the generating flag when Xero answered with a non-200 status', async () => {
    const post = vi.fn().mockResolvedValue({ status: 202, data: { invoiceNumber: 'INV-1001' } });
    const h = makeGenerateHarness(post);

    await generateXeroInvoiceFromModal(h.args);

    expect(h.showErrorToast).toHaveBeenCalledWith('Unexpected response while generating Xero invoice');
    expect(h.isGeneratingInvoiceRef.current).toBe(false);
    expect(h.showSuccessToast).not.toHaveBeenCalled();
    expect(h.generating).toEqual([true, false]);
  });

  it('clears the generating flag when the 200 response carried no body', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: null });
    const h = makeGenerateHarness(post);

    await generateXeroInvoiceFromModal(h.args);

    expect(h.showErrorToast).toHaveBeenCalledWith('Unexpected response while generating Xero invoice');
    expect(h.setShowInvoiceModal).not.toHaveBeenCalled();
  });

  it('surfaces the API error message from a rejected request', async () => {
    const post = vi.fn().mockRejectedValue({ response: { data: { message: 'Xero token expired' } } });
    const h = makeGenerateHarness(post);

    await generateXeroInvoiceFromModal(h.args);

    expect(h.showErrorToast).toHaveBeenCalledWith('Failed to generate Xero invoice', {
      description: 'Xero token expired',
    });
    expect(h.isGeneratingInvoiceRef.current).toBe(false);
    expect(h.generating).toEqual([true, false]);
  });

  it('falls back to the thrown error message, then to a generic description', async () => {
    const plain = makeGenerateHarness(vi.fn().mockRejectedValue(new Error('Network Error')));
    await generateXeroInvoiceFromModal(plain.args);
    expect(plain.showErrorToast).toHaveBeenCalledWith('Failed to generate Xero invoice', {
      description: 'Network Error',
    });

    const opaque = makeGenerateHarness(vi.fn().mockRejectedValue({ status: 500 }));
    await generateXeroInvoiceFromModal(opaque.args);
    expect(opaque.showErrorToast).toHaveBeenCalledWith('Failed to generate Xero invoice', {
      description: 'Unknown error occurred',
    });
  });

  it('reports the failure from the Xero response body without touching item statuses', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: { message: 'Contact not found in Xero' } });
    const h = makeGenerateHarness(post);

    await generateXeroInvoiceFromModal(h.args);

    expect(h.showErrorToast).toHaveBeenCalledWith('Failed to generate Xero Invoice', {
      description: 'Contact not found in Xero',
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(h.isGeneratingInvoiceRef.current).toBe(false);
  });
});
