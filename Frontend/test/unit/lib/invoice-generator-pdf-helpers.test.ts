import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AxiosInstance } from 'axios';

import {
  downloadInvoicePdf,
  updateLegacyInvoiceStatuses,
  finalizePdfInvoiceGeneration,
} from '@/lib/invoice-generator-pdf-helpers';

const PDF_URL = 'https://files.test/invoices/INV-1001.pdf';

const createObjectURL = vi.fn(() => 'blob:mock-pdf-url');
const revokeObjectURL = vi.fn();
const clicked: Array<{ download: string; href: string }> = [];
let clickSpy: ReturnType<typeof vi.spyOn>;
let openSpy: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;

function makeDownloadPost(ok = true) {
  if (!ok) {
    return vi.fn().mockRejectedValue(new Error('Network Error'));
  }
  return vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes('/pdf-links/file')) {
      return {
        data: new Blob(['%PDF-1.4 fake invoice'], { type: 'application/pdf' }),
        status: 200,
      };
    }
    return { status: 200, data: {} };
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  clicked.length = 0;
  document.body.innerHTML = '';
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function mockClick(this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  clickSpy.mockRestore();
  openSpy.mockRestore();
  consoleError.mockRestore();
});

describe('downloadInvoicePdf', () => {
  it('downloads the PDF under an Invoice_<number>_<participant> file name', async () => {
    const post = makeDownloadPost(true);

    await downloadInvoicePdf(PDF_URL, 'INV-1001', 'Jane  Marie Doe', 'ws-1', {
      post,
    } as unknown as AxiosInstance);

    expect(post).toHaveBeenCalledWith(
      'http://localhost:4001/api/pdf-links/file',
      {
        fileUrl: PDF_URL,
        workspaceId: 'ws-1',
        filename: 'Invoice_INV-1001_Jane_Marie_Doe.pdf',
      },
      { responseType: 'blob', headers: { Accept: 'application/pdf' } },
    );
    expect(clicked).toEqual([{ download: 'Invoice_INV-1001_Jane_Marie_Doe.pdf', href: 'blob:mock-pdf-url' }]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as unknown as Blob;
    expect(blob.size).toBe('%PDF-1.4 fake invoice'.length);
  });

  it('detaches the link and revokes the object URL after the download settles', async () => {
    const post = makeDownloadPost(true);

    await downloadInvoicePdf(PDF_URL, 'INV-1001', 'Jane Doe', 'ws-1', {
      post,
    } as unknown as AxiosInstance);
    expect(document.body.querySelectorAll('a[download]')).toHaveLength(1);

    vi.advanceTimersByTime(100);

    expect(document.body.querySelectorAll('a[download]')).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-pdf-url');
  });

  it('rejects when the file cannot be fetched', async () => {
    const post = makeDownloadPost(false);
    await expect(
      downloadInvoicePdf(PDF_URL, 'INV-1001', 'Jane Doe', 'ws-1', {
        post,
      } as unknown as AxiosInstance),
    ).rejects.toThrow();
    expect(clicked).toHaveLength(0);
  });
});

describe('updateLegacyInvoiceStatuses', () => {
  it('marks the selected items invoiced against the board update-status route', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: {} });

    await updateLegacyInvoiceStatuses({
      id: 'ws-1',
      boardId: 'board-9',
      selectedItems: new Set(['item-1:0', 'item-2:0']),
      invoiceNumber: 'INV-1001',
      fileUrl: PDF_URL,
      axios: { post } as unknown as AxiosInstance,
    });

    expect(post).toHaveBeenCalledWith(
      'http://localhost:4001/api/items/ws-1/board-9/update-status',
      {
        itemIds: ['item-1:0', 'item-2:0'],
        invoiceNumber: 'INV-1001',
        status: 'invoiced',
        fileUrl: PDF_URL,
      },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
    );
  });

  it('sends an undefined fileUrl when no PDF was produced', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: {} });

    await updateLegacyInvoiceStatuses({
      id: 'ws-1',
      boardId: 'board-9',
      selectedItems: new Set(['item-1:0']),
      invoiceNumber: 'INV-1001',
      axios: { post } as unknown as AxiosInstance,
    });

    expect(post.mock.calls[0][1]).toEqual({
      itemIds: ['item-1:0'],
      invoiceNumber: 'INV-1001',
      status: 'invoiced',
      fileUrl: undefined,
    });
  });
});

function makeFinalizeHarness(post = makeDownloadPost(true)) {
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
      fileUrl: undefined as string | undefined,
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

describe('finalizePdfInvoiceGeneration', () => {
  it('aborts with the server message when no invoice number came back', async () => {
    const h = makeFinalizeHarness();

    await finalizePdfInvoiceGeneration({
      ...h.args,
      respData: { message: 'Participant has no active plan' },
    });

    expect(h.showErrorToast).toHaveBeenCalledWith('Failed to generate Invoice', {
      description: 'Participant has no active plan',
    });
    expect(h.isGeneratingInvoiceRef.current).toBe(false);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.setShowInvoiceModal).not.toHaveBeenCalled();
    expect(h.showSuccessToast).not.toHaveBeenCalled();
  });

  it('falls back to a generic reason when the server gave none', async () => {
    const h = makeFinalizeHarness();
    await finalizePdfInvoiceGeneration({ ...h.args, respData: {}, invoiceLabel: 'Quote' });
    expect(h.showErrorToast).toHaveBeenCalledWith('Failed to generate Quote', {
      description: 'Invoice could not be generated.',
    });
  });

  it('marks the items invoiced, closes the modal and reports success on a standard board', async () => {
    const h = makeFinalizeHarness();

    await finalizePdfInvoiceGeneration(h.args);

    expect(h.post).toHaveBeenCalledWith(
      'http://localhost:4001/api/items/ws-1/board-9/update-status',
      expect.objectContaining({ itemIds: ['item-1:0', 'item-2:0'], status: 'invoiced', invoiceNumber: 'INV-1001' }),
      expect.any(Object),
    );
    expect(h.setShowInvoiceModal).toHaveBeenCalledWith(false);
    expect(h.showSuccessToast).toHaveBeenCalledWith('Invoice generated', {
      description:
        'Invoice INV-1001 for Jane Doe (2 items) created. You can download it from the PDF Download column in the Service Records table.',
    });
  });

  it('uses the singular noun for a one-item invoice', async () => {
    const h = makeFinalizeHarness();
    await finalizePdfInvoiceGeneration({ ...h.args, itemCount: 1 });
    expect(h.showSuccessToast).toHaveBeenCalledWith(
      'Invoice generated',
      expect.objectContaining({
        description: expect.stringContaining('(1 item) created'),
      }),
    );
  });

  it('skips the legacy status update on an NDIS board', async () => {
    const h = makeFinalizeHarness();
    await finalizePdfInvoiceGeneration({ ...h.args, isNdisBoard: true });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.showSuccessToast).toHaveBeenCalled();
  });

  it('still reports success when the status update fails, warning that a refresh is needed', async () => {
    const h = makeFinalizeHarness(vi.fn().mockRejectedValue(new Error('Request failed with status code 500')));

    await finalizePdfInvoiceGeneration(h.args);

    expect(h.showInfoToast).toHaveBeenCalledWith('Invoice generated but status update failed', {
      description:
        'The invoice was created but item statuses could not be updated. Please refresh the page.',
    });
    expect(h.showSuccessToast).toHaveBeenCalled();
    expect(h.setShowInvoiceModal).toHaveBeenCalledWith(false);
  });

  it('downloads the PDF when the response carried a file URL', async () => {
    const h = makeFinalizeHarness();

    await finalizePdfInvoiceGeneration({ ...h.args, fileUrl: PDF_URL });

    expect(clicked).toEqual([{ download: 'Invoice_INV-1001_Jane_Doe.pdf', href: 'blob:mock-pdf-url' }]);
    expect(openSpy).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledWith(
      'http://localhost:4001/api/pdf-links/file',
      expect.objectContaining({ fileUrl: PDF_URL, workspaceId: 'ws-1' }),
      expect.any(Object),
    );
  });

  it('opens the PDF in a new tab when the download fails', async () => {
    const h = makeFinalizeHarness(makeDownloadPost(false));

    await finalizePdfInvoiceGeneration({ ...h.args, fileUrl: PDF_URL });

    expect(openSpy).toHaveBeenCalledWith(PDF_URL, '_blank');
    expect(h.showInfoToast).toHaveBeenCalledWith('PDF opened in new tab', {
      description: 'Download failed, opened PDF in new tab instead.',
    });
    expect(h.showSuccessToast).toHaveBeenCalled();
    expect(h.setShowInvoiceModal).toHaveBeenCalledWith(false);
  });

  it('neither downloads nor opens anything when there is no file URL', async () => {
    const h = makeFinalizeHarness();
    await finalizePdfInvoiceGeneration(h.args);
    expect(clicked).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('refreshes silently a second later and releases the generating flag two seconds after that', async () => {
    const h = makeFinalizeHarness();

    await finalizePdfInvoiceGeneration(h.args);
    expect(h.handleManualRefresh).not.toHaveBeenCalled();
    expect(h.isGeneratingInvoiceRef.current).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(h.handleManualRefresh).toHaveBeenCalledWith(true);
    expect(h.isGeneratingInvoiceRef.current).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(h.isGeneratingInvoiceRef.current).toBe(false);
  });
});
