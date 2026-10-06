import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  buildInvoiceGeneratorTableColumns,
  type InvoiceGeneratorServiceRecord,
  type InvoiceGeneratorTableColumn,
} from '@/lib/invoice-generator-table-columns';

// Mirrors what `app/.../invoice-generator/page.tsx` passes in: `formatDisplayDate`
// collapses nullish to '-', `formatCurrency` is en-AU Intl currency, `stripHtml`
// drops tags and trims.
const formatDisplayDate = (value: string | null | undefined) =>
  value ? `DATE(${value})` : '-';
const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount || 0);
const stripHtml = (value?: string) => (value ?? '').replace(/<[^>]*>/g, '').trim();

function makeRecord(
  overrides: Partial<InvoiceGeneratorServiceRecord> = {},
): InvoiceGeneratorServiceRecord {
  return {
    id: 'item-1:0',
    participant: 'Jane Doe',
    scheduledServiceDate: '2026-03-10T00:00:00.000Z',
    serviceDeliveryDate: '2026-03-11T00:00:00.000Z',
    jobStatus: 'Completed',
    unit: 'Hour',
    quantity: 2,
    unitPrice: 65.5,
    totalAmount: 131,
    govSubsidy: 100,
    participantContribution: 31,
    notes: '<p>Domestic assistance</p>',
    service: 'Home Support',
    gst: 'GST Free',
    invoiceNumber: 'INV-2026-001',
    transactionStatus: 'Delivered - To be claimed and invoiced.',
    paymentStatus: 'Participant Invoiced',
    fundingSource: 'Home Support(HS) Quarterly',
    fileUrl: 'https://files.example.test/invoices/INV-2026-001.pdf',
    ...overrides,
  };
}

function buildColumns(
  overrides: Partial<Parameters<typeof buildInvoiceGeneratorTableColumns>[0]> = {},
) {
  return buildInvoiceGeneratorTableColumns({
    isNdisBoard: false,
    isLowCatBoard: false,
    ndisStatusFieldLabel: 'Job Status',
    formatDisplayDate,
    formatCurrency,
    stripHtml,
    onDownloadPdf: vi.fn(),
    ...overrides,
  });
}

function keysOf(columns: InvoiceGeneratorTableColumn[]) {
  return columns.map((column) => column.key);
}

function labelsOf(columns: InvoiceGeneratorTableColumn[]) {
  return columns.map((column) => column.label);
}

function cell(columns: InvoiceGeneratorTableColumn[], key: string, record: InvoiceGeneratorServiceRecord) {
  const column = columns.find((c) => c.key === key);
  if (!column) throw new Error(`no column named ${key}`);
  return column.render(record);
}

// Renders whatever a cell renderer returned — string, number or JSX — so the
// assertion is on what the user reads in that table cell.
function renderCell(
  columns: InvoiceGeneratorTableColumn[],
  key: string,
  record: InvoiceGeneratorServiceRecord,
) {
  return render(<div data-testid="cell">{cell(columns, key, record)}</div>);
}

function cellText(
  columns: InvoiceGeneratorTableColumn[],
  key: string,
  record: InvoiceGeneratorServiceRecord,
) {
  const { unmount } = renderCell(columns, key, record);
  const text = screen.getByTestId('cell').textContent;
  unmount();
  return text;
}

describe('buildInvoiceGeneratorTableColumns — which columns each board gets', () => {
  it('gives an NDIS board exactly the twelve NDIS columns in order', () => {
    const columns = buildColumns({ isNdisBoard: true });

    expect(keysOf(columns)).toEqual([
      'participant',
      'service',
      'scheduledServiceDate',
      'serviceDeliveryDate',
      'jobStatus',
      'unit',
      'quantity',
      'unitPrice',
      'gst',
      'totalAmount',
      'fileUrl',
      'paymentStatus',
    ]);
    expect(labelsOf(columns)).toEqual([
      'Participant Name',
      'Service',
      'Scheduled Service Date',
      'Service Delivery Date',
      'Job Status',
      'Unit',
      'Quantity',
      'Unit Price',
      'GST',
      'Total Amount',
      'PDF Download',
      'Payment Status',
    ]);
  });

  it('titles the NDIS job-status column with the board-supplied field label', () => {
    const columns = buildColumns({ isNdisBoard: true, ndisStatusFieldLabel: 'Service Status' });

    expect(columns.find((c) => c.key === 'jobStatus')?.label).toBe('Service Status');
    expect(labelsOf(columns)).not.toContain('Job Status');
  });

  it('ignores the NDIS status label on a non-NDIS board, which has no job-status column', () => {
    const lowCat = buildColumns({ isLowCatBoard: true, ndisStatusFieldLabel: 'Service Status' });
    const fallback = buildColumns({ ndisStatusFieldLabel: 'Service Status' });

    expect(keysOf(lowCat)).not.toContain('jobStatus');
    expect(keysOf(fallback)).not.toContain('jobStatus');
    expect(labelsOf(lowCat)).not.toContain('Service Status');
  });

  it('gives a Low Cat board exactly the thirteen Low Cat columns in order', () => {
    const columns = buildColumns({ isLowCatBoard: true });

    expect(keysOf(columns)).toEqual([
      'participant',
      'service',
      'scheduledServiceDate',
      'serviceDeliveryDate',
      'transactionStatus',
      'unit',
      'quantity',
      'unitPrice',
      'totalAmount',
      'fundingSource',
      'notes',
      'fileUrl',
      'paymentStatus',
    ]);
    expect(labelsOf(columns)).toEqual([
      'Participant Name',
      'Service',
      'Scheduled Service Date',
      'Service Delivery Date',
      'Transaction Status',
      'Unit',
      'Quantity',
      'Unit Price',
      'Total Amount',
      'Funding Source',
      'Notes',
      'PDF Download',
      'Payment Status',
    ]);
  });

  it('gives every other board the fifteen default columns, the only set with the subsidy split', () => {
    const columns = buildColumns();

    expect(keysOf(columns)).toEqual([
      'participant',
      'service',
      'scheduledServiceDate',
      'serviceDeliveryDate',
      'transactionStatus',
      'unit',
      'quantity',
      'unitPrice',
      'totalAmount',
      'govSubsidy',
      'participantContribution',
      'fundingSource',
      'notes',
      'fileUrl',
      'paymentStatus',
    ]);
    expect(labelsOf(columns)).toEqual([
      'Participant',
      'Service',
      'Scheduled Service Date',
      'Service Delivery Date',
      'Transaction Status',
      'Unit',
      'Quantity',
      'Unit Price',
      'Total Amount',
      'Government Subsidy',
      'Participant Contribution',
      'Funding Source',
      'Notes',
      'PDF Download',
      'Payment Status',
    ]);
  });

  it('names the first column "Participant Name" on NDIS and Low Cat but bare "Participant" by default', () => {
    expect(buildColumns({ isNdisBoard: true })[0].label).toBe('Participant Name');
    expect(buildColumns({ isLowCatBoard: true })[0].label).toBe('Participant Name');
    expect(buildColumns()[0].label).toBe('Participant');
  });

  it('prefers the NDIS column set when a board is flagged both NDIS and Low Cat', () => {
    const columns = buildColumns({ isNdisBoard: true, isLowCatBoard: true });

    expect(keysOf(columns)).toContain('gst');
    expect(keysOf(columns)).not.toContain('transactionStatus');
    expect(keysOf(columns)).not.toContain('notes');
  });

  it('carries the same GST and subsidy columns nowhere else — NDIS has GST, only default has the subsidy split', () => {
    expect(keysOf(buildColumns({ isNdisBoard: true }))).toContain('gst');
    expect(keysOf(buildColumns({ isLowCatBoard: true }))).not.toContain('gst');
    expect(keysOf(buildColumns())).not.toContain('gst');

    expect(keysOf(buildColumns({ isNdisBoard: true }))).not.toContain('govSubsidy');
    expect(keysOf(buildColumns({ isLowCatBoard: true }))).not.toContain('govSubsidy');
    expect(keysOf(buildColumns())).toContain('govSubsidy');
  });
});

describe('invoice generator cell renderers — plain text cells', () => {
  const columns = buildColumns();

  it('shows the stored text for the plain text columns', () => {
    const record = makeRecord();

    expect(cellText(columns, 'participant', record)).toBe('Jane Doe');
    expect(cellText(columns, 'service', record)).toBe('Home Support');
    expect(cellText(columns, 'unit', record)).toBe('Hour');
    expect(cellText(columns, 'transactionStatus', record)).toBe('Delivered - To be claimed and invoiced.');
    expect(cellText(columns, 'fundingSource', record)).toBe('Home Support(HS) Quarterly');
    expect(cellText(columns, 'paymentStatus', record)).toBe('Participant Invoiced');
  });

  it('falls back to a dash for every empty-string text column', () => {
    const record = makeRecord({
      participant: '',
      service: '',
      unit: '',
      transactionStatus: '',
      fundingSource: '',
      paymentStatus: '',
    });

    expect(cellText(columns, 'participant', record)).toBe('-');
    expect(cellText(columns, 'service', record)).toBe('-');
    expect(cellText(columns, 'unit', record)).toBe('-');
    expect(cellText(columns, 'transactionStatus', record)).toBe('-');
    expect(cellText(columns, 'fundingSource', record)).toBe('-');
    expect(cellText(columns, 'paymentStatus', record)).toBe('-');
  });

  it('falls back to a dash for the optional text columns when the field is absent', () => {
    const record = makeRecord({
      transactionStatus: undefined,
      fundingSource: undefined,
      paymentStatus: undefined,
    });

    expect(cellText(columns, 'transactionStatus', record)).toBe('-');
    expect(cellText(columns, 'fundingSource', record)).toBe('-');
    expect(cellText(columns, 'paymentStatus', record)).toBe('-');
  });

  it('shows the NDIS job status, or a dash when the record has none', () => {
    const ndisColumns = buildColumns({ isNdisBoard: true });

    expect(cellText(ndisColumns, 'jobStatus', makeRecord({ jobStatus: 'Scheduled' }))).toBe('Scheduled');
    expect(cellText(ndisColumns, 'jobStatus', makeRecord({ jobStatus: undefined }))).toBe('-');
  });

  it('labels a record with no GST value "GST Free" rather than dashing it out', () => {
    const ndisColumns = buildColumns({ isNdisBoard: true });

    expect(cellText(ndisColumns, 'gst', makeRecord({ gst: 'GST 10%' }))).toBe('GST 10%');
    expect(cellText(ndisColumns, 'gst', makeRecord({ gst: undefined }))).toBe('GST Free');
    expect(cellText(ndisColumns, 'gst', makeRecord({ gst: '' }))).toBe('GST Free');
  });
});

describe('invoice generator cell renderers — dates, quantities and money', () => {
  const columns = buildColumns();

  it('routes both date columns through the supplied formatter', () => {
    const record = makeRecord();

    expect(cellText(columns, 'scheduledServiceDate', record)).toBe('DATE(2026-03-10T00:00:00.000Z)');
    expect(cellText(columns, 'serviceDeliveryDate', record)).toBe('DATE(2026-03-11T00:00:00.000Z)');
  });

  it('lets the formatter dash out a null or missing date', () => {
    const record = makeRecord({ scheduledServiceDate: null, serviceDeliveryDate: undefined });

    expect(cellText(columns, 'scheduledServiceDate', record)).toBe('-');
    expect(cellText(columns, 'serviceDeliveryDate', record)).toBe('-');
  });

  it('prints a zero quantity as 0 rather than treating it as missing', () => {
    expect(cellText(columns, 'quantity', makeRecord({ quantity: 0 }))).toBe('0');
    expect(cellText(columns, 'quantity', makeRecord({ quantity: 2.5 }))).toBe('2.5');
  });

  it('dashes out a quantity that is not a number at all', () => {
    expect(cellText(columns, 'quantity', makeRecord({ quantity: undefined as unknown as number }))).toBe('-');
    expect(cellText(columns, 'quantity', makeRecord({ quantity: null as unknown as number }))).toBe('-');
  });

  it('formats the money columns as en-AU currency, zero included', () => {
    const record = makeRecord({
      unitPrice: 65.5,
      totalAmount: 131,
      govSubsidy: 100,
      participantContribution: 31,
    });

    expect(cellText(columns, 'unitPrice', record)).toBe('$65.50');
    expect(cellText(columns, 'totalAmount', record)).toBe('$131.00');
    expect(cellText(columns, 'govSubsidy', record)).toBe('$100.00');
    expect(cellText(columns, 'participantContribution', record)).toBe('$31.00');

    const zeroed = makeRecord({ unitPrice: 0, totalAmount: 0, govSubsidy: 0, participantContribution: 0 });
    expect(cellText(columns, 'unitPrice', zeroed)).toBe('$0.00');
    expect(cellText(columns, 'totalAmount', zeroed)).toBe('$0.00');
    expect(cellText(columns, 'govSubsidy', zeroed)).toBe('$0.00');
    expect(cellText(columns, 'participantContribution', zeroed)).toBe('$0.00');
  });
});

describe('invoice generator cell renderers — notes', () => {
  const columns = buildColumns();

  it('shows the notes with their HTML stripped and repeats them as a hover title', () => {
    renderCell(columns, 'notes', makeRecord({ notes: '<p>Domestic <b>assistance</b></p>' }));

    const note = screen.getByTitle('Domestic assistance');
    expect(note).toHaveTextContent('Domestic assistance');
  });

  it('dashes out notes that are empty once the markup is removed', () => {
    expect(cellText(columns, 'notes', makeRecord({ notes: '<p></p>' }))).toBe('-');
    expect(cellText(columns, 'notes', makeRecord({ notes: '' }))).toBe('-');
    expect(cellText(columns, 'notes', makeRecord({ notes: undefined as unknown as string }))).toBe('-');
  });
});

describe('invoice generator cell renderers — PDF download', () => {
  it('dashes out the cell when the record has no file, and offers nothing to click', () => {
    const onDownloadPdf = vi.fn();
    const columns = buildColumns({ onDownloadPdf });

    renderCell(columns, 'fileUrl', makeRecord({ fileUrl: undefined }));

    expect(screen.getByTestId('cell')).toHaveTextContent('-');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(onDownloadPdf).not.toHaveBeenCalled();
  });

  it('dashes out the cell for an empty file url too', () => {
    const columns = buildColumns();

    renderCell(columns, 'fileUrl', makeRecord({ fileUrl: '' }));

    expect(screen.getByTestId('cell')).toHaveTextContent('-');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('labels the download button with the invoice number and passes both url and number on click', async () => {
    const user = userEvent.setup();
    const onDownloadPdf = vi.fn();
    const columns = buildColumns({ onDownloadPdf });

    renderCell(
      columns,
      'fileUrl',
      makeRecord({
        fileUrl: 'https://files.example.test/invoices/INV-2026-001.pdf',
        invoiceNumber: 'INV-2026-001',
      }),
    );

    const button = screen.getByRole('button', { name: 'Invoice #INV-2026-001' });
    expect(button).toHaveAttribute('title', 'Download PDF Invoice');

    await user.click(button);

    expect(onDownloadPdf).toHaveBeenCalledTimes(1);
    expect(onDownloadPdf).toHaveBeenCalledWith(
      'https://files.example.test/invoices/INV-2026-001.pdf',
      'INV-2026-001',
      'Jane Doe',
    );
  });

  it('falls back to a plain "Download" label and passes no invoice number when the record has none', async () => {
    const user = userEvent.setup();
    const onDownloadPdf = vi.fn();
    const columns = buildColumns({ onDownloadPdf });

    renderCell(
      columns,
      'fileUrl',
      makeRecord({
        fileUrl: 'https://files.example.test/invoices/loose.pdf',
        invoiceNumber: undefined,
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(onDownloadPdf).toHaveBeenCalledWith(
      'https://files.example.test/invoices/loose.pdf',
      undefined,
      'Jane Doe',
    );
  });

  it('treats an empty invoice number as no invoice number', async () => {
    const user = userEvent.setup();
    const onDownloadPdf = vi.fn();
    const columns = buildColumns({ onDownloadPdf });

    renderCell(
      columns,
      'fileUrl',
      makeRecord({ fileUrl: 'https://files.example.test/invoices/loose.pdf', invoiceNumber: '' }),
    );

    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(onDownloadPdf).toHaveBeenCalledWith(
      'https://files.example.test/invoices/loose.pdf',
      '',
      'Jane Doe',
    );
  });

  it('offers the same download button on every board variant', () => {
    for (const columns of [
      buildColumns({ isNdisBoard: true }),
      buildColumns({ isLowCatBoard: true }),
      buildColumns(),
    ]) {
      const { unmount } = renderCell(columns, 'fileUrl', makeRecord({ invoiceNumber: 'INV-9' }));
      expect(screen.getByRole('button', { name: 'Invoice #INV-9' })).toBeInTheDocument();
      unmount();
    }
  });
});
