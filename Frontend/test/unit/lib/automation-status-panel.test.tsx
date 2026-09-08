import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

/** Renders the panel with a health block, for the 6.6 signals. */
function renderPanelWithHealth(health: {
  queueBacklogged: boolean;
  queueAvailable: boolean;
  accounting: string;
}) {
  render(
    <AutomationStatusPanel
      invoice={block({ enabled: true })}
      statement={block()}
      recentDocuments={[]}
      health={health}
    />
  );
  return within(screen.getByRole("region", { name: /automation status/i }));
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

/**
 * Epic 5: "a short list (last 10) of generated invoices/statements with
 * recipient, sent time, and delivery state". That name was the one part never
 * rendered — the backend now sends `participant`, so the row has to show it,
 * rather than silently reusing it as the link label the way
 * `recentDocumentLabel` does for an unnumbered statement.
 *
 * Rendered "For <name>", not as the recipient, and the distinction is not
 * pedantry. `participant` is the client the document was raised for. With
 * Recipient set to Billing Contact the mail goes to that profile's Billing
 * Email, which can belong to somebody else entirely — so a row labelled as the
 * recipient would assert something the stored data does not know. Nothing
 * records the mailbox actually written to; until something does, the row says
 * only what it can stand behind.
 */
describe('the client on a recent document', () => {
  it('names the client the document was raised for', () => {
    const status = renderPanel([doc({ participant: 'Samuel Rivers' })]);

    expect(rowFor(status, /INV-1004/).getByText(/for samuel rivers/i)).toBeInTheDocument();
  });

  it('does not present that name as the address it was sent to', () => {
    const status = renderPanel([doc({ participant: 'Samuel Rivers' })]);

    // The guard on the claim itself: with Recipient = Billing Contact the mail
    // may have gone to a different person, so the row must not say otherwise.
    expect(rowFor(status, /INV-1004/).queryByText(/recipient/i)).not.toBeInTheDocument();
  });

  it('says so plainly when no client was recorded', () => {
    const status = renderPanel([doc({ participant: null })]);

    // Silence would read as "raised for nobody in particular"; the panel exists
    // to stop the client guessing.
    expect(rowFor(status, /INV-1004/).getByText(/no client recorded/i)).toBeInTheDocument();
  });

  it('does not repeat the name when it is already the row label', () => {
    // An unnumbered statement falls back to the participant as its link text.
    const status = renderPanel([
      doc({ type: 'Monthly Statement', invoiceNumber: null, participant: 'Jane Smith' }),
    ]);

    expect(rowFor(status, 'Jane Smith').getAllByText(/jane smith/i)).toHaveLength(1);
  });
});

/**
 * 6.6 asks for queue depth and accounting connection status on BOTH the admin
 * screens and the client panel. They reached only the admin screens, so a
 * client whose run was stuck behind a backlog, or whose Xero token had
 * expired, saw a panel that said "On track".
 *
 * The queue signal is a boolean by design — the depth is global, and the count
 * would leak other tenants' volume.
 */
describe("automation health on the client panel", () => {
  it("warns when the run may be delayed by a backlog", () => {
    const status = renderPanelWithHealth({ queueBacklogged: true, queueAvailable: true, accounting: "connected" });

    expect(status.getByText(/busy|backlog|delayed/i)).toBeInTheDocument();
  });

  it("says nothing about the queue when it is clear", () => {
    const status = renderPanelWithHealth({ queueBacklogged: false, queueAvailable: true, accounting: "connected" });

    expect(status.queryByText(/backlog/i)).not.toBeInTheDocument();
  });

  it("tells the client when Xero needs re-authorising", () => {
    // The client is the only party who can fix this.
    const status = renderPanelWithHealth({ queueBacklogged: false, queueAvailable: true, accounting: "needs_reauth" });

    expect(status.getByText(/reconnect|re-authorise|reauthorise/i)).toBeInTheDocument();
  });

  it("stays quiet when accounting is simply not in use", () => {
    const status = renderPanelWithHealth({ queueBacklogged: false, queueAvailable: true, accounting: "disconnected" });

    // Not every workspace uses Xero; "disconnected" is not a fault to nag about.
    expect(status.queryByText(/reconnect/i)).not.toBeInTheDocument();
  });
});

/** `count` documents, newest first, each with its own link so rows are distinct. */
function docs(count: number): AutomationRecentDocument[] {
  return Array.from({ length: count }, (_, i) =>
    doc({
      invoiceNumber: `INV-${2000 + i}`,
      pdfUrl: `https://files.test/inv-${2000 + i}.pdf`,
    })
  );
}

describe('AutomationStatusPanel recent-document history', () => {
  it('shows only the five most recent to begin with', () => {
    const status = renderPanel(docs(12));
    expect(status.getAllByRole('listitem')).toHaveLength(5);
    expect(status.getByRole('link', { name: /INV-2000/ })).toBeTruthy();
    expect(status.queryByRole('link', { name: /INV-2005/ })).toBeNull();
  });

  it('reveals the rest when the history is expanded', async () => {
    const status = renderPanel(docs(12));
    await userEvent.click(status.getByRole('button', { name: /show \d+ more/i }));
    expect(status.getAllByRole('listitem')).toHaveLength(12);
  });

  it('collapses back to five', async () => {
    const status = renderPanel(docs(12));
    await userEvent.click(status.getByRole('button', { name: /show \d+ more/i }));
    await userEvent.click(status.getByRole('button', { name: /show fewer/i }));
    expect(status.getAllByRole('listitem')).toHaveLength(5);
  });

  // Five or fewer is the whole history, so there is nothing to expand and a
  // button that reveals nothing is worse than no button.
  it('offers no expander when everything already fits', () => {
    const status = renderPanel(docs(4));
    expect(status.queryByRole('button', { name: /show \d+ more/i })).toBeNull();
  });
});
