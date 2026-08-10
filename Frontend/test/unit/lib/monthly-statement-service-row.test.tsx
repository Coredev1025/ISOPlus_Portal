import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  MonthlyStatementServiceRow,
  type MonthlyStatementServiceRecord,
} from '@/lib/monthly-statement-service-row';

/**
 * The row is a <tr>, so it has to be mounted inside a table for jsdom to keep
 * the cells. Everything else the row needs is injected, which is what makes the
 * collaborator calls assertable.
 */
function renderRow(service: MonthlyStatementServiceRecord, overrides: Partial<Collaborators> = {}) {
  const collaborators = makeCollaborators(overrides);
  const view = render(
    <table>
      <tbody>
        <MonthlyStatementServiceRow service={service} {...collaborators} />
      </tbody>
    </table>
  );
  return { ...view, ...collaborators };
}

type Collaborators = {
  formatDate: ReturnType<typeof vi.fn>;
  formatCurrency: ReturnType<typeof vi.fn>;
  getServiceProviderLabel: ReturnType<typeof vi.fn>;
  sanitizeNotesHtml: ReturnType<typeof vi.fn>;
};

function makeCollaborators(overrides: Partial<Collaborators> = {}): Collaborators {
  return {
    // Deliberately marks the value it was handed so a swapped date field is visible.
    formatDate: vi.fn((value: string) => `D(${value})`),
    formatCurrency: vi.fn((amount?: number | null) => `$${Number(amount ?? 0).toFixed(2)}`),
    getServiceProviderLabel: vi.fn(() => 'Sunrise Care Pty Ltd'),
    sanitizeNotesHtml: vi.fn((html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, '')),
    ...overrides,
  };
}

function cellTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('td')).map((td) => (td.textContent ?? '').trim());
}

const fullRecord: MonthlyStatementServiceRecord = {
  id: 'svc-1',
  participant: 'Margaret Chen',
  participantName: 'Chen, Margaret',
  service: 'Personal Care - Weekday Daytime',
  taskName: 'PC Weekday',
  scheduledServiceDate: '2026-03-04',
  scheduledShiftStart: '2026-03-04T09:00:00+11:00',
  serviceDeliveryDate: '2026-03-04',
  actualShiftEndDateTime: '2026-03-04T11:00:00+11:00',
  transactionStatus: 'Delivered',
  committedAtHmForDelivery: 1,
  unit: 'Hour',
  quantity: 2,
  unitPrice: 78.5,
  totalAmount: 157,
  govSubsidy: 141.3,
  participantContribution: 15.7,
  fundingSource: 'Home Support Quarterly Budget',
  notes: '<p>Client requested a later start.</p>',
};

describe('MonthlyStatementServiceRow', () => {
  it('lays every field of a complete record out in the fifteen table columns', () => {
    const { container } = renderRow(fullRecord);

    // 2 x 78.50 = 157.00; 141.30 + 15.70 = 157.00.
    expect(cellTexts(container)).toEqual([
      'Margaret Chen',
      'Personal Care - Weekday Daytime',
      'Sunrise Care Pty Ltd',
      'D(2026-03-04)',
      'D(2026-03-04)',
      'Delivered',
      'Yes',
      'Hour',
      '2.00',
      '$78.50',
      '$157.00',
      '$141.30',
      '$15.70',
      'Home Support Quarterly Budget',
      'Client requested a later start.',
    ]);
  });

  it('passes the whole service record to the provider-label resolver', () => {
    const { getServiceProviderLabel } = renderRow(fullRecord);

    expect(getServiceProviderLabel).toHaveBeenCalledTimes(1);
    expect(getServiceProviderLabel).toHaveBeenCalledWith(fullRecord);
  });

  it('falls back to participantName and taskName when the primary fields are absent', () => {
    const { container } = renderRow({
      ...fullRecord,
      participant: undefined,
      service: undefined,
    });

    const cells = cellTexts(container);
    expect(cells[0]).toBe('Chen, Margaret');
    expect(cells[1]).toBe('PC Weekday');
  });

  it('shows a dash for participant and service when every candidate field is missing', () => {
    const { container } = renderRow({ id: 'svc-empty' });

    const cells = cellTexts(container);
    expect(cells[0]).toBe('-');
    expect(cells[1]).toBe('-');
    expect(cells[7]).toBe('-');
  });

  it('formats the shift timestamps when the date-only fields are missing', () => {
    const { container, formatDate } = renderRow({
      ...fullRecord,
      scheduledServiceDate: null,
      serviceDeliveryDate: null,
    });

    const cells = cellTexts(container);
    expect(cells[3]).toBe('D(2026-03-04T09:00:00+11:00)');
    expect(cells[4]).toBe('D(2026-03-04T11:00:00+11:00)');
    expect(formatDate).toHaveBeenCalledTimes(2);
  });

  it('shows N/A for both dates and never calls the formatter when no date is present', () => {
    const { container, formatDate } = renderRow({
      ...fullRecord,
      scheduledServiceDate: null,
      scheduledShiftStart: null,
      serviceDeliveryDate: null,
      actualShiftEndDateTime: null,
    });

    const cells = cellTexts(container);
    expect(cells[3]).toBe('N/A');
    expect(cells[4]).toBe('N/A');
    expect(formatDate).not.toHaveBeenCalled();
  });

  it.each([
    ['Cancelled by participant', 'bg-destructive'],
    ['CANCELLED - late notice', 'bg-destructive'],
    ['Delivered', 'bg-primary'],
    ['delivered (adjusted)', 'bg-primary'],
    ['Scheduled', 'bg-secondary'],
    ['Pending approval', 'bg-secondary'],
  ])('badges the transaction status %s with %s', (transactionStatus, expectedClass) => {
    const { container } = renderRow({ ...fullRecord, transactionStatus });

    const badge = within(container.querySelectorAll('td')[5]).getByText(transactionStatus);
    expect(badge).toHaveClass(expectedClass);
  });

  it('prefers the cancelled badge when a status mentions both cancelled and delivered', () => {
    const { container } = renderRow({
      ...fullRecord,
      transactionStatus: 'Cancelled after delivered',
    });

    expect(screen.getByText('Cancelled after delivered')).toHaveClass('bg-destructive');
    expect(container.querySelectorAll('td')[5].textContent).toBe('Cancelled after delivered');
  });

  it.each([undefined, '', '   '])('shows a plain N/A instead of a badge for status %p', (transactionStatus) => {
    const { container } = renderRow({ ...fullRecord, transactionStatus });

    const statusCell = container.querySelectorAll('td')[5];
    expect(statusCell.textContent).toBe('N/A');
    expect(statusCell.querySelector('.rounded-full')).toBeNull();
  });

  it.each([
    [3, 'Yes'],
    [0.5, 'Yes'],
    [0, 'No'],
    [-2, 'No'],
    [undefined, 'No'],
  ])('reports committed AT-HM %p as %s', (committedAtHmForDelivery, expected) => {
    const { container } = renderRow({ ...fullRecord, committedAtHmForDelivery });

    expect(container.querySelectorAll('td')[6].textContent).toBe(expected);
  });

  it.each([
    [2.5, '2.50'],
    [0, '0.00'],
    [-1.5, '-1.50'],
    [undefined, '0.00'],
  ])('prints quantity %p to two decimals as %s', (quantity, expected) => {
    const { container } = renderRow({ ...fullRecord, quantity });

    expect(container.querySelectorAll('td')[8].textContent).toBe(expected);
  });

  it('substitutes zero for every missing money field before formatting', () => {
    const { container, formatCurrency } = renderRow({
      id: 'svc-no-money',
      transactionStatus: 'Scheduled',
    });

    expect(formatCurrency.mock.calls).toEqual([[0], [0], [0], [0]]);
    expect(cellTexts(container).slice(9, 13)).toEqual(['$0.00', '$0.00', '$0.00', '$0.00']);
  });

  it('renders negative money amounts as the formatter returns them', () => {
    const { container, formatCurrency } = renderRow({
      ...fullRecord,
      unitPrice: -78.5,
      totalAmount: -157,
      govSubsidy: -141.3,
      participantContribution: -15.7,
    });

    expect(formatCurrency.mock.calls).toEqual([[-78.5], [-157], [-141.3], [-15.7]]);
    expect(cellTexts(container).slice(9, 13)).toEqual([
      '$-78.50',
      '$-157.00',
      '$-141.30',
      '$-15.70',
    ]);
  });

  it('shows N/A when no funding source is set', () => {
    const { container } = renderRow({ ...fullRecord, fundingSource: '' });

    expect(container.querySelectorAll('td')[13].textContent).toBe('N/A');
  });

  it('injects the sanitized notes markup rather than the raw html', () => {
    const raw = '<p>Fell <strong>ill</strong></p><script>alert(1)</script>';
    const { container, sanitizeNotesHtml } = renderRow({ ...fullRecord, notes: raw });

    expect(sanitizeNotesHtml).toHaveBeenCalledWith(raw);
    const notesCell = container.querySelectorAll('td')[14];
    expect(notesCell.querySelector('.notes-cell')?.innerHTML).toBe('<p>Fell <strong>ill</strong></p>');
    expect(notesCell.querySelector('script')).toBeNull();
    expect(screen.getByText('ill').tagName).toBe('STRONG');
  });

  it.each([undefined, '', '   '])('shows N/A and never sanitizes for notes %p', (notes) => {
    const { container, sanitizeNotesHtml } = renderRow({ ...fullRecord, notes });

    expect(container.querySelectorAll('td')[14].textContent).toBe('N/A');
    expect(sanitizeNotesHtml).not.toHaveBeenCalled();
  });
});
