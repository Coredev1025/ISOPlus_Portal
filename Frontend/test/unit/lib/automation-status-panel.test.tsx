import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { AutomationStatusPanel } from '@/lib/automation-status-panel';
import {
  DEFAULT_BLOCK,
  type AutomationBlock,
  type AutomationRecentDocument,
} from '@/lib/automation-settings';

// jsdom ships none of these, and Radix calls them while opening; the Range
// geometry stubs are what ProseMirror needs. Copied from the panel suite so
// this file stands alone.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  const emptyRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
  Range.prototype.getBoundingClientRect ??= emptyRect;
  Range.prototype.getClientRects ??= () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint ??= () => null;
});

afterEach(cleanup);

/** DEFAULT_BLOCK is deep-frozen, so every fixture needs its own deep copy. */
function block(overrides: Partial<AutomationBlock> = {}): AutomationBlock {
  return { ...structuredClone(DEFAULT_BLOCK), ...overrides };
}

function doc(
  overrides: Partial<AutomationRecentDocument> = {}
): AutomationRecentDocument {
  return {
    type: 'NDIS Invoice',
    invoiceNumber: 'INV-1004',
    periodKey: '20250201-0900',
    pdfUrl: 'https://files.test/inv-1004.pdf',
    createdAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(recentDocuments: AutomationRecentDocument[]) {
  render(
    <AutomationStatusPanel
      invoice={block({ enabled: true })}
      statement={block()}
      recentDocuments={recentDocuments}
    />
  );
  return within(screen.getByRole('region', { name: /automation status/i }));
}

/** The list item for one document, found by its link. */
function rowFor(status: ReturnType<typeof renderPanel>, name: RegExp | string) {
  const link = status.getByRole('link', { name });
  const row = link.closest('li');
  if (!row) throw new Error('recent document row not found');
  return within(row);
}

describe('AutomationStatusPanel recent-document delivery state', () => {
  it('shows a delivered send as Delivered', () => {
    const status = renderPanel([doc({ deliveryState: 'delivered' })]);

    expect(rowFor(status, /INV-1004/).getByText('Delivered')).toBeInTheDocument();
  });

  it('shows a bounce with its plain-English reason inline against that send', () => {
    const status = renderPanel([
      doc({
        deliveryState: 'bounced',
        deliveryDetail: "Email address doesn't exist.",
      }),
    ]);

    const row = rowFor(status, /INV-1004/);
    expect(row.getByText('Bounced')).toBeInTheDocument();
    // The reason has to be on the same row as the send it explains, so the
    // client knows which document to chase.
    expect(row.getByText("Email address doesn't exist.")).toBeInTheDocument();
  });

  it('shows a rejected send as Failed to send', () => {
    const status = renderPanel([doc({ deliveryState: 'failed' })]);

    expect(rowFor(status, /INV-1004/).getByText('Failed to send')).toBeInTheDocument();
  });

  it('still says Generated for a document no email has carried yet', () => {
    const status = renderPanel([doc()]);

    const row = rowFor(status, /INV-1004/);
    expect(row.getByText('Generated')).toBeInTheDocument();
    expect(row.queryByText(/bounced|failed/i)).not.toBeInTheDocument();
  });

  it('labels the state for a screen reader rather than leaving a bare word', () => {
    const status = renderPanel([
      doc({ deliveryState: 'bounced', deliveryDetail: "Email address doesn't exist." }),
    ]);

    expect(
      rowFor(status, /INV-1004/).getByLabelText(/delivery status/i)
    ).toHaveTextContent('Bounced');
  });

  it('announces a bounce, so a state change is not silent for a screen reader', () => {
    const status = renderPanel([
      doc({ deliveryState: 'bounced', deliveryDetail: "Email address doesn't exist." }),
    ]);

    const alert = rowFor(status, /INV-1004/).getByRole('status');
    expect(alert).toHaveTextContent("Email address doesn't exist.");
  });

  it('keeps each row independent when states differ', () => {
    const status = renderPanel([
      doc({ deliveryState: 'delivered' }),
      doc({
        invoiceNumber: 'INV-1005',
        pdfUrl: 'https://files.test/inv-1005.pdf',
        deliveryState: 'bounced',
        deliveryDetail: "Email address doesn't exist.",
      }),
      doc({ invoiceNumber: 'INV-1006', pdfUrl: 'https://files.test/inv-1006.pdf' }),
    ]);

    expect(rowFor(status, /INV-1004/).getByText('Delivered')).toBeInTheDocument();
    expect(rowFor(status, /INV-1005/).getByText('Bounced')).toBeInTheDocument();
    expect(rowFor(status, /INV-1006/).getByText('Generated')).toBeInTheDocument();
    expect(
      rowFor(status, /INV-1004/).queryByText("Email address doesn't exist.")
    ).not.toBeInTheDocument();
  });

  it('keeps the panel heading and its region label intact', () => {
    renderPanel([doc({ deliveryState: 'delivered' })]);

    expect(
      screen.getByRole('heading', { name: /automation status/i })
    ).toBeInTheDocument();
  });
});
