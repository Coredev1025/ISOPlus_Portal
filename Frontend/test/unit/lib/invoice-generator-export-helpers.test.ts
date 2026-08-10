import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AxiosInstance } from 'axios';

import { exportInvoiceGeneratorCsv } from '@/lib/invoice-generator-export-helpers';

const createObjectURL = vi.fn(() => 'blob:mock-object-url');
const revokeObjectURL = vi.fn();
const clicked: Array<{ download: string; href: string }> = [];
let clickSpy: ReturnType<typeof vi.spyOn>;

function makeToasts() {
  return {
    showSuccessToast: vi.fn(),
    showErrorToast: vi.fn(),
    showWarningToast: vi.fn(),
  };
}

const baseOptions = {
  isNdisBoard: false,
  id: 'ws-1',
  boardId: 'board-9',
  participantFilter: 'all',
  scheduledServiceDateRange: undefined,
  serviceDeliveryDateRange: undefined,
  transactionStatusFilter: 'all',
  paymentStatusFilter: 'all',
  jobStatusFilter: 'all',
  sortBy: 'scheduledServiceDate',
  sortOrder: 'desc',
  businessTimezone: 'Australia/Sydney',
};

function fakeAxios(data: unknown) {
  const get = vi.fn().mockResolvedValue({ data });
  return { instance: { get } as unknown as AxiosInstance, get };
}

// jsdom's Blob exposes no text()/arrayBuffer(), so record what the code puts into it.
const writtenBlobs: Array<{ content: string; type: string | undefined }> = [];
const NativeBlob = globalThis.Blob;
class RecordingBlob extends NativeBlob {
  constructor(parts: BlobPart[] = [], options: BlobPropertyBag = {}) {
    super(parts, options);
    writtenBlobs.push({ content: parts.map(String).join(''), type: options.type });
  }
}

function lastCsv() {
  const blob = writtenBlobs.at(-1);
  if (!blob) throw new Error('no CSV blob was created');
  return blob.content.split('\n');
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  clicked.length = 0;
  writtenBlobs.length = 0;
  document.body.innerHTML = '';
  vi.stubGlobal('Blob', RecordingBlob);
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function mockClick(this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 2, 15, 10, 4, 5));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clickSpy.mockRestore();
});

const ndisRow = {
  RegistrationNumber: '4-ABC123',
  NDISNumber: '431234567',
  SupportDeliveredFrom: '2026-03-01',
  SupportDeliveredTo: '2026-03-01',
  SupportNumber: '01_011_0107_1_1',
  ClaimReference: 'REF "A"',
  Quantity: 1,
  Hours: 2.5,
  UnitPrice: 67.56,
  GSTCode: 'P2',
  ClaimType: '',
  CancellationReason: null,
  'ABN of Support Provider': '12345678901',
  internalItemId: 'item-1',
};

describe('exportInvoiceGeneratorCsv — NDIS board', () => {
  it('writes the fixed NDIS claim header and one quoted row per item', async () => {
    const { instance } = fakeAxios({ items: [ndisRow], skippedCount: 0 });
    const toasts = makeToasts();

    const result = await exportInvoiceGeneratorCsv({
      ...baseOptions,
      isNdisBoard: true,
      axios: instance,
      toasts,
    });

    expect(result).toEqual({ exported: true });
    const rows = lastCsv();
    expect(rows[0]).toBe(
      'RegistrationNumber,NDISNumber,SupportDeliveredFrom,SupportDeliveredTo,SupportNumber,ClaimReference,Quantity,Hours,UnitPrice,GSTCode,ClaimType,CancellationReason,ABN of Support Provider',
    );
    // Empty, null and absent values collapse to an unquoted empty cell; quotes are doubled.
    expect(rows[1]).toBe(
      '"4-ABC123","431234567","2026-03-01","2026-03-01","01_011_0107_1_1","REF ""A""","1","2.5","67.56","P2",,,"12345678901"',
    );
    expect(rows).toHaveLength(2);
    expect(writtenBlobs.at(-1)?.type).toBe('text/csv;charset=utf-8;');
  });

  it('calls the NDIS export endpoint with the payment and job status filters', async () => {
    const { instance, get } = fakeAxios({ items: [ndisRow] });

    await exportInvoiceGeneratorCsv({
      ...baseOptions,
      isNdisBoard: true,
      participantFilter: 'Jane Doe',
      paymentStatusFilter: 'Unpaid',
      jobStatusFilter: 'Completed',
      transactionStatusFilter: 'delivered',
      scheduledServiceDateRange: {
        from: new Date('2026-03-01T05:00:00.000Z'),
        to: new Date('2026-03-31T05:00:00.000Z'),
      },
      businessTimezone: 'UTC',
      axios: instance,
      toasts: makeToasts(),
    });

    expect(get).toHaveBeenCalledWith('http://localhost:4001/api/export/ws-1/board-9/invoice-csv-ndis', {
      params: {
        participant: 'Jane Doe',
        startDate: '2026-03-01T00:00:00.000Z',
        endDate: '2026-03-31T23:59:59.999Z',
        paymentStatus: 'Unpaid',
        jobStatus: 'Completed',
        sortBy: 'scheduledServiceDate',
        sortOrder: 'desc',
        limit: 'all',
      },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
  });

  it('omits the filters that are still at their defaults', async () => {
    const { instance, get } = fakeAxios({ items: [ndisRow] });

    await exportInvoiceGeneratorCsv({ ...baseOptions, isNdisBoard: true, axios: instance, toasts: makeToasts() });

    expect(get.mock.calls[0][1].params).toEqual({
      sortBy: 'scheduledServiceDate',
      sortOrder: 'desc',
      limit: 'all',
    });
  });

  it('warns about skipped records, pluralising on the count', async () => {
    const many = fakeAxios({ items: [ndisRow], skippedCount: 3 });
    const manyToasts = makeToasts();
    await exportInvoiceGeneratorCsv({ ...baseOptions, isNdisBoard: true, axios: many.instance, toasts: manyToasts });
    expect(manyToasts.showWarningToast).toHaveBeenCalledWith(
      '3 records were skipped because required data was missing.',
    );

    const one = fakeAxios({ items: [ndisRow], skippedCount: 1 });
    const oneToasts = makeToasts();
    await exportInvoiceGeneratorCsv({ ...baseOptions, isNdisBoard: true, axios: one.instance, toasts: oneToasts });
    expect(oneToasts.showWarningToast).toHaveBeenCalledWith(
      // Note the production copy says "record ... were", singular noun with a plural verb.
      '1 record were skipped because required data was missing.',
    );
  });

  it('does not warn when nothing was skipped', async () => {
    const { instance } = fakeAxios({ items: [ndisRow], skippedCount: 0 });
    const toasts = makeToasts();
    await exportInvoiceGeneratorCsv({ ...baseOptions, isNdisBoard: true, axios: instance, toasts });
    expect(toasts.showWarningToast).not.toHaveBeenCalled();
  });

  it('reports an empty export and downloads nothing', async () => {
    const { instance } = fakeAxios({ items: [], skippedCount: 2 });
    const toasts = makeToasts();

    const result = await exportInvoiceGeneratorCsv({
      ...baseOptions,
      isNdisBoard: true,
      axios: instance,
      toasts,
    });

    expect(result).toEqual({ exported: false });
    expect(toasts.showErrorToast).toHaveBeenCalledWith('No records to export.');
    expect(toasts.showWarningToast).toHaveBeenCalledWith('2 records were skipped because required data was missing.');
    expect(toasts.showSuccessToast).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(0);
  });

  it('treats a missing items array as an empty export', async () => {
    const { instance } = fakeAxios({});
    const toasts = makeToasts();
    const result = await exportInvoiceGeneratorCsv({
      ...baseOptions,
      isNdisBoard: true,
      axios: instance,
      toasts,
    });
    expect(result).toEqual({ exported: false });
    expect(toasts.showErrorToast).toHaveBeenCalledWith('No records to export.');
  });

  it('names the NDIS file from the clock, the participant and a random suffix', async () => {
    const { instance } = fakeAxios({ items: [ndisRow] });
    await exportInvoiceGeneratorCsv({
      ...baseOptions,
      isNdisBoard: true,
      participantFilter: 'Jane Doe',
      axios: instance,
      toasts: makeToasts(),
    });

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toMatch(/^NDIS_CLAIM~260315100405~Jane Doe~[A-Z0-9]{5}\.csv$/);
    expect(clicked[0].href).toBe('blob:mock-object-url');
  });

  it('labels the file "(Multiple)" when no single participant is filtered', async () => {
    const { instance } = fakeAxios({ items: [ndisRow] });
    await exportInvoiceGeneratorCsv({ ...baseOptions, isNdisBoard: true, axios: instance, toasts: makeToasts() });
    expect(clicked[0].download).toMatch(/^NDIS_CLAIM~260315100405~\(Multiple\)~[A-Z0-9]{5}\.csv$/);
  });

  it('revokes the object URL and detaches the link a tick after the click', async () => {
    const { instance } = fakeAxios({ items: [ndisRow] });
    await exportInvoiceGeneratorCsv({ ...baseOptions, isNdisBoard: true, axios: instance, toasts: makeToasts() });

    expect(document.body.querySelector('a[download]')).not.toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(document.body.querySelector('a[download]')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-object-url');
  });

  it('appends the export duration in seconds to the success toast', async () => {
    const timed = fakeAxios({ items: [ndisRow], exportDurationMs: 1234 });
    const timedToasts = makeToasts();
    await exportInvoiceGeneratorCsv({ ...baseOptions, isNdisBoard: true, axios: timed.instance, toasts: timedToasts });
    expect(timedToasts.showSuccessToast).toHaveBeenCalledWith('Successfully exported 1 records to CSV (1.2s).');

    const untimed = fakeAxios({ items: [ndisRow] });
    const untimedToasts = makeToasts();
    await exportInvoiceGeneratorCsv({
      ...baseOptions,
      isNdisBoard: true,
      axios: untimed.instance,
      toasts: untimedToasts,
    });
    expect(untimedToasts.showSuccessToast).toHaveBeenCalledWith('Successfully exported 1 records to CSV.');
  });
});

const standardHeader = [
  'Item External Reference Identifier',
  'Care Recipient Identifier',
  'Service Identifier',
  'Delivery Date',
  'Unit Type',
  'Quantity',
  'Price Per Unit',
  'Funding Source',
  'Delivered By Third Party',
  'Item or Wraparound',
  'Item Description Code',
  'Item Description',
  'Wraparound Description Code',
  'Wraparound Description',
  'Prescribed Item',
  'Purchased Method Type',
  'Loaned by Organisation Name',
  'Loaned By Invoice Number',
  'Health Professional Type Code',
  'Health Professional Type Other',
  'Item First Payment',
].join(',');

describe('exportInvoiceGeneratorCsv — standard board', () => {
  it('writes the Support at Home header row', async () => {
    const { instance } = fakeAxios({ items: [{ id: 'ITEM-1' }] });
    await exportInvoiceGeneratorCsv({ ...baseOptions, axios: instance, toasts: makeToasts() });
    expect((lastCsv())[0]).toBe(standardHeader);
  });

  it('maps an "Item" row, trims the service identifier and keeps the loaned fields', async () => {
    const { instance } = fakeAxios({
      items: [
        {
          id: 'ITEM-REF-001',
          careRecipientIdentifier: 'AC12345678',
          serviceIdentifier: 'SVC-001 / Domestic Assistance',
          serviceDeliveryDate: '2026-03-14T14:00:00.000Z',
          unit: 'Hour',
          quantity: 2,
          unitPrice: 65.5,
          fundingSource: 'Home Support(HS) Quarterly',
          deliveredByThirdParty: 'N',
          itemOrWraparound: 'Item',
          itemDescriptionCode: 'IDC-1',
          itemDescription: 'Cleaning',
          wraparoundDescriptionCode: 'WDC-9',
          wraparoundDescription: 'Should not be exported',
          prescribedItem: 'Y',
          itemPurchasedMethod: 'LOANED',
          loanedByOrganisationName: 'Acme Equipment',
          loanedByInvoiceNumber: 'INV-77',
          healthProfessionalTypeCode: 'OT',
          healthProfessionalTypeOther: '',
          itemFirstPayment: 'True',
        },
      ],
    });

    await exportInvoiceGeneratorCsv({ ...baseOptions, axios: instance, toasts: makeToasts() });

    // 2026-03-14T14:00Z is 2026-03-15 in Sydney; the wraparound columns stay blank for an Item row.
    expect((lastCsv())[1]).toBe(
      [
        '"ITEM-REF-001"',
        '"AC12345678"',
        '"SVC-001"',
        '"2026-03-15"',
        '"Hour"',
        '"2"',
        '"65.50"',
        '"ON"',
        '"N"',
        '"Item"',
        '"IDC-1"',
        '"Cleaning"',
        '',
        '',
        '"Y"',
        '"LOANED"',
        '"Acme Equipment"',
        '"INV-77"',
        '"OT"',
        '',
        '"True"',
      ].join(','),
    );
  });

  it('maps a "Wraparound" row, blanks the loaned fields and keeps zero and negative amounts', async () => {
    const { instance } = fakeAxios({
      items: [
        {
          id: 'ITEM-3',
          serviceIdentifier: 'SVC-003',
          serviceDeliveryDate: null,
          quantity: 0,
          unitPrice: -12.5,
          fundingSource: 'Mystery Fund',
          itemOrWraparound: 'Wraparound',
          itemDescriptionCode: 'IDC-X',
          itemDescription: 'Should not be exported',
          wraparoundDescriptionCode: 'WDC-9',
          wraparoundDescription: 'Care Management',
          itemPurchasedMethod: 'PURCHASED',
          loanedByOrganisationName: 'Ignored Org',
          loanedByInvoiceNumber: 'Ignored-2',
        },
      ],
    });

    await exportInvoiceGeneratorCsv({ ...baseOptions, axios: instance, toasts: makeToasts() });

    expect((lastCsv())[1]).toBe(
      [
        '"ITEM-3"',
        '',
        '"SVC-003"',
        '',
        '',
        '"0"',
        '"-12.50"',
        '"MYST"',
        '',
        '"Wraparound"',
        '',
        '',
        '"WDC-9"',
        '"Care Management"',
        '"N"',
        '"PURCHASED"',
        '',
        '',
        '',
        '',
        '"False"',
      ].join(','),
    );
  });

  it('blanks both description pairs when the row is neither Item nor Wraparound, and defaults the flags', async () => {
    const { instance } = fakeAxios({ items: [{ id: 'ITEM-2' }] });

    await exportInvoiceGeneratorCsv({ ...baseOptions, axios: instance, toasts: makeToasts() });

    expect((lastCsv())[1]).toBe(
      [
        '"ITEM-2"',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '"N"',
        '',
        '',
        '',
        '',
        '',
        '"False"',
      ].join(','),
    );
  });

  it('writes one row per item', async () => {
    const { instance } = fakeAxios({ items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] });
    const toasts = makeToasts();
    await exportInvoiceGeneratorCsv({ ...baseOptions, axios: instance, toasts });
    expect(lastCsv()).toHaveLength(4);
    expect(toasts.showSuccessToast).toHaveBeenCalledWith('Successfully exported 3 records to CSV.');
  });

  it('calls the standard export endpoint with the transaction status filter and no jobStatus', async () => {
    const { instance, get } = fakeAxios({ items: [{ id: 'A' }] });

    await exportInvoiceGeneratorCsv({
      ...baseOptions,
      participantFilter: 'Jane Doe',
      transactionStatusFilter: 'delivered',
      paymentStatusFilter: 'Paid',
      jobStatusFilter: 'Completed',
      serviceDeliveryDateRange: { from: new Date('2026-02-01T05:00:00.000Z'), to: undefined },
      businessTimezone: 'UTC',
      axios: instance,
      toasts: makeToasts(),
    });

    expect(get).toHaveBeenCalledWith('http://localhost:4001/api/export/ws-1/board-9/invoice-csv', {
      params: {
        participant: 'Jane Doe',
        serviceDeliveryStart: '2026-02-01T00:00:00.000Z',
        serviceDeliveryEnd: '2026-02-01T23:59:59.999Z',
        transactionStatus: 'Delivered - To be claimed and invoiced.',
        paymentStatus: 'Paid',
        sortBy: 'scheduledServiceDate',
        sortOrder: 'desc',
        limit: 'all',
      },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
  });

  it('reports an empty export without downloading anything', async () => {
    const { instance } = fakeAxios({ items: [] });
    const toasts = makeToasts();

    const result = await exportInvoiceGeneratorCsv({ ...baseOptions, axios: instance, toasts });

    expect(result).toEqual({ exported: false });
    expect(toasts.showErrorToast).toHaveBeenCalledWith('No records to export.');
    expect(clicked).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('names the standard file with the CLAIM prefix', async () => {
    const { instance } = fakeAxios({ items: [{ id: 'A' }] });
    await exportInvoiceGeneratorCsv({
      ...baseOptions,
      participantFilter: 'John Smith',
      axios: instance,
      toasts: makeToasts(),
    });
    expect(clicked[0].download).toMatch(/^CLAIM~260315100405~John Smith~[A-Z0-9]{5}\.csv$/);
  });

  it('appends the export duration to the success toast', async () => {
    const { instance } = fakeAxios({ items: [{ id: 'A' }], exportDurationMs: 9550 });
    const toasts = makeToasts();
    await exportInvoiceGeneratorCsv({ ...baseOptions, axios: instance, toasts });
    expect(toasts.showSuccessToast).toHaveBeenCalledWith('Successfully exported 1 records to CSV (9.6s).');
  });
});
