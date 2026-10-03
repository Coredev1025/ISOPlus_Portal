import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/automation-settings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/automation-settings')>(
    '@/lib/automation-settings'
  );
  return {
    ...actual,
    fetchAutomationSettings: vi.fn(),
    saveAutomationSettings: vi.fn(),
    fetchAutomationDocuments: vi.fn(),
  };
});

import { InvoiceStatementAutomationPanel } from '@/lib/invoice-statement-automation-panel';
import {
  AUTOMATION_PANEL_POLL_MS,
  DEFAULT_EMAIL_SUBJECT,
} from '@/constants/automation';
import {
  DEFAULT_BLOCK,
  fetchAutomationDocuments,
  fetchAutomationSettings,
  saveAutomationSettings,
  type AutomationBlock,
  type AutomationSettings,
} from '@/lib/automation-settings';

// jsdom ships none of these, and Radix's Select calls all of them while
// opening; ProseMirror (TipTap's engine) needs the Range geometry stubs.
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

const fetchMock = vi.mocked(fetchAutomationSettings);
const saveMock = vi.mocked(saveAutomationSettings);
const documentsMock = vi.mocked(fetchAutomationDocuments);

/** DEFAULT_BLOCK is deep-frozen, so every fixture needs its own deep copy. */
function block(overrides: Partial<AutomationBlock> = {}): AutomationBlock {
  return { ...structuredClone(DEFAULT_BLOCK), ...overrides };
}

function settings(
  invoice: Partial<AutomationBlock> = {},
  statement: Partial<AutomationBlock> = {}
): AutomationSettings {
  return { invoice: block(invoice), statement: block(statement) };
}

const invoiceSection = () =>
  screen.getByRole('region', { name: /invoice automation/i });
const statementSection = () =>
  screen.getByRole('region', { name: /statement automation/i });

async function renderPanel() {
  render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);
  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: 'Invoice Automation' })
    ).toBeInTheDocument()
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(settings());
  saveMock.mockResolvedValue(settings());
});

afterEach(() => {
  cleanup();
});

describe('InvoiceStatementAutomationPanel', () => {
  it('renders an invoice block and a statement block', async () => {
    await renderPanel();

    expect(
      screen.getByRole('heading', { name: 'Invoice Automation' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Statement Automation' })
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('ws-1');
  });

  it('shows Next Run read-only, with an em dash when there is no next run', async () => {
    fetchMock.mockResolvedValue(
      settings({ enabled: true, nextRun: '2026-09-01T12:00:00.000Z' }, { enabled: true })
    );
    await renderPanel();

    expect(within(invoiceSection()).getByLabelText(/next run/i)).toHaveAttribute(
      'readonly'
    );

    const statementNextRun = within(statementSection()).getByLabelText(/next run/i);
    expect(statementNextRun).toHaveAttribute('readonly');
    expect(statementNextRun).toHaveValue('—');
  });

  it('renders a server ISO startDate as a yyyy-mm-dd date input value', async () => {
    // Mongoose stores startDate as a Date, so a GET returns a full ISO
    // instant. <input type="date"> silently blanks anything but yyyy-mm-dd.
    fetchMock.mockResolvedValue(
      settings({ enabled: true, startDate: '2026-03-01T00:00:00.000Z' })
    );
    await renderPanel();

    expect(within(invoiceSection()).getByLabelText(/start date/i)).toHaveValue(
      '2026-03-01'
    );
  });

  it('does not render the excluded fields', async () => {
    await renderPanel();

    for (const excluded of [
      /invoice scope/i,
      /eligible billing items/i,
      /statement type/i,
      /statement period/i,
      /transaction types/i,
    ]) {
      expect(screen.queryByText(excluded)).not.toBeInTheDocument();
    }
  });

  it('keeps the invoice and statement blocks independent', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderPanel();

    const invoiceSwitch = within(invoiceSection()).getByRole('switch');
    const statementSwitch = within(statementSection()).getByRole('switch');
    await user.click(invoiceSwitch);

    expect(invoiceSwitch).toBeChecked();
    expect(statementSwitch).not.toBeChecked();
  });

  it('saves both blocks together under the workspace id', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderPanel();

    await user.click(within(invoiceSection()).getByRole('switch'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          invoice: expect.objectContaining({ enabled: true }),
          statement: expect.objectContaining({ enabled: false }),
        })
      )
    );
  });

  it('restores defaults without saving', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(settings({ enabled: true }, { enabled: true }));
    await renderPanel();

    await waitFor(() =>
      expect(within(invoiceSection()).getByRole('switch')).toBeChecked()
    );
    await user.click(screen.getByRole('button', { name: /restore defaults/i }));

    expect(within(invoiceSection()).getByRole('switch')).not.toBeChecked();
    expect(within(statementSection()).getByRole('switch')).not.toBeChecked();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('resets Run On to the new unit default when the unit changes', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(settings({ enabled: true }));
    await renderPanel();

    const invoice = within(invoiceSection());
    // The month default is day-of-month 1.
    expect(invoice.getByRole('combobox', { name: /run on/i })).toHaveTextContent('1');

    await user.click(invoice.getByRole('combobox', { name: /generate every unit/i }));
    await user.click(await screen.findByRole('option', { name: 'Week(s)' }));

    // A weekly schedule cannot keep a day-of-month; it must fall back to Monday.
    expect(
      within(invoiceSection()).getByRole('combobox', { name: /run on/i })
    ).toHaveTextContent('Monday');
  });

  it('hides Run On entirely for a daily schedule', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(settings({ enabled: true }));
    await renderPanel();

    await user.click(
      within(invoiceSection()).getByRole('combobox', { name: /generate every unit/i })
    );
    await user.click(await screen.findByRole('option', { name: 'Day(s)' }));

    expect(
      within(invoiceSection()).queryByRole('combobox', { name: /run on/i })
    ).not.toBeInTheDocument();
  });

  it('offers a month and a day for a yearly schedule', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(settings({ enabled: true }));
    await renderPanel();

    await user.click(
      within(invoiceSection()).getByRole('combobox', { name: /generate every unit/i })
    );
    await user.click(await screen.findByRole('option', { name: 'Year(s)' }));

    const invoice = within(invoiceSection());
    expect(
      invoice.getByRole('combobox', { name: /run on month/i })
    ).toHaveTextContent('January');
    expect(invoice.getByRole('combobox', { name: /run on day/i })).toHaveTextContent(
      '1'
    );
  });

  it('flags an invalid email address inline and clears the flag when fixed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(settings({ enabled: true }));
    await renderPanel();

    const replyTo = within(invoiceSection()).getByLabelText(/reply-to email/i);
    await user.type(replyTo, 'not-an-email');

    expect(
      within(invoiceSection()).getByText(/enter a valid email address/i)
    ).toBeInTheDocument();

    await user.clear(replyTo);
    await user.type(replyTo, 'billing@example.com');

    expect(
      within(invoiceSection()).queryByText(/enter a valid email address/i)
    ).not.toBeInTheDocument();
  });

  it('leaves an empty email field unflagged', async () => {
    await renderPanel();

    expect(
      screen.queryByText(/enter a valid email address/i)
    ).not.toBeInTheDocument();
  });

  it('reports a load failure instead of rendering stale settings silently', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not load automation settings/i
    );
  });

  it('offers no Save while the settings are still loading', async () => {
    // Saving the defaults over live configuration disables both schedules and
    // erases their email settings, from a form that never showed the user what
    // it was replacing. Nothing is safe to save until the GET has resolved.
    let resolveFetch: (value: AutomationSettings) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<AutomationSettings>((resolve) => {
        resolveFetch = resolve;
      })
    );
    render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);

    expect(
      screen.queryByRole('button', { name: /save changes/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Invoice Automation' })
    ).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(
      /loading automation settings/i
    );

    resolveFetch(settings({ enabled: true }));

    expect(
      await screen.findByRole('button', { name: /save changes/i })
    ).toBeEnabled();
  });

  it('offers no Save when the settings could not be loaded', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);

    await screen.findByRole('alert');

    expect(
      screen.queryByRole('button', { name: /save changes/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Invoice Automation' })
    ).not.toBeInTheDocument();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('saves a legacy plain-text message exactly as it was stored', async () => {
    // Email Message was a textarea two commits ago. Opening the tab must not
    // normalise a stored plain-text value into <p>…</p> and persist that on the
    // next Save — the user never asked for it and never saw it happen.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(
      settings({ enabled: true, emailMessage: 'Hello plain text' })
    );
    await renderPanel();

    await waitFor(() =>
      expect(within(invoiceSection()).getByLabelText(/email message/i)).toHaveTextContent(
        'Hello plain text'
      )
    );
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          invoice: expect.objectContaining({ emailMessage: 'Hello plain text' }),
        })
      )
    );
  });

  it('announces a successful save and clears it on the next change', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderPanel();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const success = await screen.findByRole('status');
    expect(success).toHaveTextContent(/saved successfully/i);

    // A stale "saved" banner sitting above unsaved edits is a lie.
    await user.click(within(invoiceSection()).getByRole('switch'));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('blocks Save while an email field is flagged as malformed', async () => {
    // The backend rejects the whole PUT with one message that does not say
    // which of six fields is wrong, so the form has to say it first.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(settings({ enabled: true }));
    await renderPanel();

    const replyTo = within(invoiceSection()).getByLabelText(/reply-to email/i);
    await user.type(replyTo, 'not-an-email');

    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();

    await user.clear(replyTo);
    await user.type(replyTo, 'billing@example.com');

    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  it('reports the server message when saving fails', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    saveMock.mockRejectedValue({
      response: { data: { message: 'Sender identity is not verified' } },
    });
    await renderPanel();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sender identity is not verified'
    );
  });

  it('renders Email Message as a rich text editor with formatting controls', async () => {
    // The spec calls Email Message a rich-text field; a plain textarea cannot
    // carry the formatting the composed email will send. This supersedes the
    // earlier textarea expectation.
    fetchMock.mockResolvedValue(
      settings({ enabled: true, emailMessage: '<p>Hello <strong>world</strong></p>' })
    );
    await renderPanel();

    const invoice = within(invoiceSection());
    const editor = await waitFor(() => {
      const el = invoice.getByLabelText(/email message/i);
      expect(el).toHaveAttribute('contenteditable', 'true');
      return el;
    });
    // Stored HTML renders as formatting, not as escaped markup.
    expect(editor.innerHTML).toContain('<strong>world</strong>');
    expect(editor.closest('.md\\:col-span-3')).not.toBeNull();
    for (const name of [/^bold$/i, /^italic$/i, /bullet list/i, /numbered list/i]) {
      expect(invoice.getByRole('button', { name })).toBeInTheDocument();
    }
    // The other email fields stay plain inputs.
    expect(invoice.getByLabelText(/email subject/i).tagName).toBe('INPUT');
  });

  it('renders the address-valued fields as type=email inputs', async () => {
    fetchMock.mockResolvedValue(settings({ enabled: true }));
    await renderPanel();

    // Email From was removed (KAN-269): it becomes an application-level
    // setting rather than a per-workspace field.
    const invoice = within(invoiceSection());
    for (const label of [/send a copy to/i, /reply-to email/i]) {
      expect(invoice.getByLabelText(label)).toHaveAttribute('type', 'email');
    }
    // The non-address fields stay plain text.
    expect(invoice.getByLabelText(/email subject/i)).not.toHaveAttribute(
      'type',
      'email'
    );
  });

  it('shows the status panel with badges, runs, and recent documents', async () => {
    fetchMock.mockResolvedValue({
      ...settings(
        {
          enabled: true,
          nextRun: '2026-09-01T12:00:00.000Z',
          lastRunAt: '2026-08-01T12:00:00.000Z',
        },
        { enabled: false }
      ),
      recentDocuments: [
        {
          type: 'NDIS Invoice',
          invoiceNumber: 'INV-1004 (ISO+™)',
          periodKey: '20250201-0900',
          pdfUrl: 'https://files.test/inv-1004.pdf',
          createdAt: '2026-08-01T12:00:00.000Z',
        },
        {
          type: 'Monthly Statement',
          invoiceNumber: null,
          periodKey: '20250201-0900',
          pdfUrl:
            'https://files.test/Jane-Smith_January_2025_Statement.pdf',
          createdAt: '2026-08-01T12:00:00.000Z',
        },
      ],
    });
    await renderPanel();

    const status = within(
      screen.getByRole('region', { name: /automation status/i })
    );
    // Badges mirror the enable switches: enabled and clean → On track;
    // disabled → Paused.
    expect(status.getByText(/on track/i)).toBeInTheDocument();
    expect(status.getByText(/paused/i)).toBeInTheDocument();
    // The recent document links to its PDF.
    expect(status.getByRole('link', { name: /INV-1004/i })).toHaveAttribute(
      'href',
      'https://files.test/inv-1004.pdf'
    );
    // A statement has no number, so its label comes from the file name —
    // which carries the participant and period — not a repeat of the type.
    expect(
      status.getByRole('link', { name: 'Jane-Smith_January_2025_Statement' })
    ).toBeInTheDocument();
  });

  it('flags a block whose last run failed as needing attention', async () => {
    fetchMock.mockResolvedValue(
      settings({
        enabled: true,
        lastRunAt: '2026-08-01T12:00:00.000Z',
        lastRunError: 'generator exploded',
      })
    );
    await renderPanel();

    const status = within(
      screen.getByRole('region', { name: /automation status/i })
    );
    expect(status.getByText(/attention needed/i)).toBeInTheDocument();
    expect(status.getByText(/failed/i)).toBeInTheDocument();
  });

  /**
   * KAN-44 and KAN-299. Only invoices can be sent from the accounting platform.
   * A statement is always sent from ISO+, so its block has no Send Method control
   * at all (it used to be a dropdown with the one option). The invoice block
   * keeps both.
   */
  it('offers the accounting platform as a send method for invoices only, and no Send Method on statements', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(settings({ enabled: true }, { enabled: true }));
    await renderPanel();

    await user.click(within(invoiceSection()).getByLabelText('Send Method'));
    expect(
      screen.getByRole('option', { name: /accounting platform/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /send from iso\+/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // The statement block is enabled, so its email fields are shown, and the
    // Send Method control is not one of them.
    expect(within(statementSection()).getByLabelText(/reply-to email/i)).toBeInTheDocument();
    expect(within(statementSection()).queryByLabelText('Send Method')).not.toBeInTheDocument();
    expect(within(statementSection()).queryByText('Send Method')).not.toBeInTheDocument();
  });

  it('shows the same email fields on a statement as before, minus Send Method', async () => {
    fetchMock.mockResolvedValue(settings({ enabled: true }, { enabled: true }));
    await renderPanel();

    for (const label of [/send a copy to/i, /reply-to email/i, /email subject/i]) {
      expect(within(statementSection()).getByLabelText(label)).toBeInTheDocument();
      expect(within(invoiceSection()).getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('still saves a statement as sent from ISO+, with no control to choose it', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(settings({}, { enabled: true }));
    await renderPanel();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          statement: expect.objectContaining({ enabled: true, sendMethod: 'isoplus' }),
        })
      )
    );
  });

  it('leaves the invoice send method as saved when a statement is edited', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(
      settings({ enabled: true, sendMethod: 'accounting' }, { enabled: true })
    );
    await renderPanel();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          invoice: expect.objectContaining({ sendMethod: 'accounting' }),
          statement: expect.objectContaining({ sendMethod: 'isoplus' }),
        })
      )
    );
  });

  it('hides the schedule and email fields until automatic generation is enabled', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderPanel();

    const section = invoiceSection();
    expect(within(section).queryByLabelText(/run on/i)).not.toBeInTheDocument();
    expect(
      within(section).queryByLabelText(/reply-to email/i)
    ).not.toBeInTheDocument();

    await user.click(within(section).getByRole('switch'));

    expect(within(section).getByLabelText(/run on/i)).toBeInTheDocument();
    expect(within(section).getByLabelText(/reply-to email/i)).toBeInTheDocument();
  });

  /**
   * The reproduction for the defect this replaced.
   *
   * The status panel answers "whether your automation is healthy" — a fact
   * about the scheduler, held on the server. It was being fed the working
   * draft, so editing the form rewrote it: flipping the switch off reported
   * "Paused" while the schedule was still armed, and it erased Last run, which
   * is history no form can change.
   */
  describe('the status panel reports saved state, not the working draft', () => {
    const armed = () =>
      settings({
        enabled: true,
        nextRun: '2027-08-20T09:02:00.000Z',
        lastRunAt: '2026-08-20T09:02:42.820Z',
      });

    const statusRegion = () =>
      within(screen.getByRole('region', { name: /automation status/i }));

    it('keeps reporting the armed schedule while the switch is toggled off', async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      fetchMock.mockResolvedValue(armed());
      await renderPanel();

      // Scoped to the Invoices row: the Statements row is legitimately Paused
      // in this fixture, so a panel-wide /paused/i matcher proves nothing.
      const invoiceRow = () => statusRegion().getByText('Invoices').parentElement!;

      expect(within(invoiceRow()).getByText(/on track/i)).toBeInTheDocument();

      await user.click(within(invoiceSection()).getByRole('switch'));

      // The form is now off; the schedule on the server is not.
      expect(
        within(invoiceSection()).getByRole('switch')
      ).toHaveAttribute('aria-checked', 'false');
      expect(within(invoiceRow()).getByText(/on track/i)).toBeInTheDocument();
      expect(within(invoiceRow()).queryByText(/paused/i)).not.toBeInTheDocument();
    });

    it('does not let Restore Defaults erase the last run', async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      fetchMock.mockResolvedValue(armed());
      await renderPanel();

      await user.click(screen.getByRole('button', { name: /restore defaults/i }));

      // Restore Defaults writes nothing, so every word here is still true.
      expect(statusRegion().getByText(/on track/i)).toBeInTheDocument();
      expect(statusRegion().getByText(/succeeded/i)).toBeInTheDocument();
    });

    it('adopts the server echo once a save succeeds', async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      fetchMock.mockResolvedValue(armed());
      // What the server made of the save: the block is now paused.
      saveMock.mockResolvedValue(settings({ enabled: false }));
      await renderPanel();

      await user.click(within(invoiceSection()).getByRole('switch'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() =>
        expect(statusRegion().getAllByText(/paused/i).length).toBeGreaterThan(0)
      );
      expect(statusRegion().queryByText(/on track/i)).not.toBeInTheDocument();
    });
  });
});

/**
 * 6.2 puts bounce and delivery failures on the client panel, but the panel
 * fetched once on mount and never again. SES publishes a bounce minutes after
 * the send, so a client sitting on the tab watched "Sent" indefinitely and the
 * failure only appeared if they happened to reload.
 *
 * The code already assumed otherwise: the status panel justifies its
 * role="status" with "when a poll turns a 'Sent' row into a bounce". That poll
 * did not exist.
 */
describe("delivery states arrive without a reload", () => {
  it("refetches on an interval", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(settings());
      render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(AUTOMATION_PANEL_POLL_MS);

      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once the panel goes away", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(settings());
      const { unmount } = render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      unmount();
      const afterUnmount = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(AUTOMATION_PANEL_POLL_MS * 3);

      // A timer left running against an unmounted panel is a request nobody
      // reads, forever.
      expect(fetchMock.mock.calls.length).toBe(afterUnmount);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Paging back through document history has to survive the 60-second poll.
 *
 * The poll re-reads the whole panel, including `recentDocumentsCursor` — the
 * boundary after page ONE. Adopting that while a client has paged back throws
 * away where they had got to: the next Load more refetches an already-merged
 * page, `mergeRecentDocuments` dedupes it away, and the button silently does
 * nothing. It then happens again every minute.
 */
describe('Load more survives a poll', () => {
  const doc = (id: string) => ({
    type: 'NDIS Invoice',
    invoiceNumber: id,
    periodKey: '20260801-2300',
    pdfUrl: `https://s3.example/${id}.pdf`,
    createdAt: '2026-08-05T00:00:00.000Z',
  });

  it('keeps the client\'s paging position when a poll lands', async () => {
    vi.useFakeTimers();
    try {
      // Load more only appears once the in-memory list is fully expanded, and
      // the list only collapses above COLLAPSED_RECENT_DOCUMENTS rows.
      fetchMock.mockResolvedValue({
        ...settings(),
        recentDocuments: Array.from({ length: 6 }, (_, i) => doc(`INV-${i + 1}`)),
        recentDocumentsCursor: 'cursor-page-2',
      });
      documentsMock.mockResolvedValue({
        documents: [doc('INV-7')],
        nextCursor: 'cursor-page-3',
      });

      render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      (
        await vi.waitFor(() => screen.getByRole('button', { name: /show 1 more/i }))
      ).click();

      const loadMore = await vi.waitFor(() =>
        screen.getByRole('button', { name: /load more/i })
      );
      loadMore.click();
      await vi.waitFor(() => expect(documentsMock).toHaveBeenCalledTimes(1));

      // The poll lands while the client is on page two.
      await vi.advanceTimersByTimeAsync(AUTOMATION_PANEL_POLL_MS);
      await vi.waitFor(() =>
        expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
      );

      screen.getByRole('button', { name: /load more/i }).click();
      await vi.waitFor(() => expect(documentsMock).toHaveBeenCalledTimes(2));

      // Page three, not page one again.
      expect(documentsMock.mock.calls[0][1]).toBe('cursor-page-2');
      expect(documentsMock.mock.calls[1][1]).toBe('cursor-page-3');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The `[workspaceId]` effect re-runs whenever a caller passes a different
 * workspace — the component's own contract treats workspaceId as changeable
 * without a remount. But `pagedBackRef`, `olderDocuments` and
 * `documentsCursor` are only ever written by the Load More flow, never reset
 * on that switch: workspace B inherits workspace A's paging position.
 */
describe('Load more resets when the workspace changes', () => {
  const docFor = (workspace: string, id: string) => ({
    type: 'NDIS Invoice',
    invoiceNumber: `${workspace}-${id}`,
    periodKey: '20260801-2300',
    pdfUrl: `https://s3.example/${workspace}-${id}.pdf`,
    createdAt: '2026-08-05T00:00:00.000Z',
  });

  it("does not carry workspace A's paging position into workspace B", async () => {
    fetchMock.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === 'ws-B') {
        return {
          ...settings(),
          recentDocuments: [docFor('B', '1')],
          recentDocumentsCursor: 'cursor-B-page-2',
        };
      }
      return {
        ...settings(),
        recentDocuments: Array.from({ length: 6 }, (_, i) => docFor('A', `${i + 1}`)),
        recentDocumentsCursor: 'cursor-A-page-2',
      };
    });
    documentsMock.mockResolvedValue({
      documents: [docFor('A', '7')],
      nextCursor: 'cursor-A-page-3',
    });

    const { rerender } = render(
      <InvoiceStatementAutomationPanel workspaceId="ws-A" />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    (
      await screen.findByRole('button', { name: /show 1 more/i })
    ).click();
    const loadMore = await screen.findByRole('button', { name: /load more/i });
    loadMore.click();
    await waitFor(() => expect(documentsMock).toHaveBeenCalledTimes(1));
    // The older page landed before the switch.
    await screen.findByRole('link', { name: 'A-7' });

    rerender(<InvoiceStatementAutomationPanel workspaceId="ws-B" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // (1) B's newest page only — none of A's older-page rows remain.
    await screen.findByRole('link', { name: 'B-1' });
    expect(screen.queryByRole('link', { name: /^A-/ })).not.toBeInTheDocument();

    // (2) Load more on B requests B's own page-one cursor, not the cursor
    // A's paging had advanced to.
    documentsMock.mockResolvedValue({
      documents: [docFor('B', '2')],
      nextCursor: null,
    });
    screen.getByRole('button', { name: /load more/i }).click();
    await waitFor(() => expect(documentsMock).toHaveBeenCalledTimes(2));
    expect(documentsMock.mock.calls[1][1]).toBe('cursor-B-page-2');
  });
});

/**
 * KAN-265. The Email Subject and Email Message arrive pre-filled with copy the
 * client specified, the guide under the editor names the one variable the
 * block can resolve, and "Reset to default" puts the copy back.
 */
describe('the email template defaults', () => {
  const enabled = () => settings({ enabled: true }, { enabled: true });

  it('pre-fills the invoice subject on a workspace that never set one', async () => {
    fetchMock.mockResolvedValue(enabled());
    await renderPanel();

    expect(
      within(invoiceSection()).getByLabelText(/email subject/i),
    ).toHaveValue(DEFAULT_EMAIL_SUBJECT.invoice);
  });

  it('pre-fills the statement subject with its own copy', async () => {
    fetchMock.mockResolvedValue(enabled());
    await renderPanel();

    expect(
      within(statementSection()).getByLabelText(/email subject/i),
    ).toHaveValue(DEFAULT_EMAIL_SUBJECT.statement);
  });

  // The rule that protects a client's own wording: a stored subject is theirs.
  it('never overwrites a subject the client has written', async () => {
    fetchMock.mockResolvedValue(
      settings({ enabled: true, emailSubject: 'Your bill is ready' }, { enabled: true }),
    );
    await renderPanel();

    expect(
      within(invoiceSection()).getByLabelText(/email subject/i),
    ).toHaveValue('Your bill is ready');
  });

  // Matched on the guide's own wording, not on the token alone: the default
  // body carries the same token, so a bare token matcher finds two nodes and
  // proves nothing about the guide.
  it('explains the invoice variable under the editor', async () => {
    fetchMock.mockResolvedValue(enabled());
    await renderPanel();

    const guide = within(invoiceSection()).getByText(
      /replaced with the invoice number when the email is sent/i,
    );
    expect(guide).toHaveTextContent('{{invoice_number}}');
  });

  it('explains the statement variable under its own editor', async () => {
    fetchMock.mockResolvedValue(enabled());
    await renderPanel();

    const guide = within(statementSection()).getByText(
      /replaced with the statement number when the email is sent/i,
    );
    expect(guide).toHaveTextContent('{{statement_number}}');
  });

  // Each block offers only the variable it can resolve. An invoice run never
  // produces a statement number, so a statement token anywhere in the invoice
  // block would reach a client as literal braces.
  it('never shows the other block\'s variable', async () => {
    fetchMock.mockResolvedValue(enabled());
    await renderPanel();

    expect(invoiceSection()).not.toHaveTextContent('{{statement_number}}');
    expect(statementSection()).not.toHaveTextContent('{{invoice_number}}');
  });

  it('offers a reset control on each enabled block', async () => {
    fetchMock.mockResolvedValue(enabled());
    await renderPanel();

    expect(
      within(invoiceSection()).getByRole('button', { name: /reset to default/i }),
    ).toBeInTheDocument();
    expect(
      within(statementSection()).getByRole('button', { name: /reset to default/i }),
    ).toBeInTheDocument();
  });

  // The point of the button: a client who has rewritten the body can get the
  // supplied copy back without retyping it.
  it('puts the default copy back when reset is clicked', async () => {
    fetchMock.mockResolvedValue(
      settings({ enabled: true, emailMessage: '<p>my own words</p>' }, {}),
    );
    const user = userEvent.setup();
    await renderPanel();

    await user.click(
      within(invoiceSection()).getByRole('button', { name: /reset to default/i }),
    );

    await waitFor(() =>
      expect(within(invoiceSection()).getByText(/please find attached invoice/i))
        .toBeInTheDocument(),
    );
  });

  // The defaults must survive the round trip, or an automation enabled and
  // saved would send the blank body this ticket exists to replace.
  it('saves the pre-filled copy rather than a blank field', async () => {
    fetchMock.mockResolvedValue(enabled());
    const user = userEvent.setup();
    await renderPanel();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.invoice.emailSubject).toBe(DEFAULT_EMAIL_SUBJECT.invoice);
    expect(payload.statement.emailSubject).toBe(DEFAULT_EMAIL_SUBJECT.statement);
    expect(payload.invoice.emailMessage).toContain('Please find attached invoice');
  });
});

/**
 * KAN-269. Email From becomes an application-level configuration (KAN-270),
 * not a per-workspace field, so it is removed from both automation sections.
 * Email Subject takes its place in the array-driven layout and gains its own
 * reset control, distinct from Email Message's.
 */
describe('the Email From removal (KAN-269)', () => {
  const enabled = () => settings({ enabled: true }, { enabled: true });

  it('does not render an Email From field on either section', async () => {
    fetchMock.mockResolvedValue(enabled());
    await renderPanel();

    expect(screen.queryByLabelText(/email from/i)).not.toBeInTheDocument();
  });

  it('offers a distinct reset control for the email subject on each block', async () => {
    fetchMock.mockResolvedValue(enabled());
    await renderPanel();

    expect(
      within(invoiceSection()).getByRole('button', { name: /reset subject to default/i }),
    ).toBeInTheDocument();
    expect(
      within(statementSection()).getByRole('button', { name: /reset subject to default/i }),
    ).toBeInTheDocument();

    // Still exactly one "reset to default" match per section: the message
    // reset button. The subject's own reset has a distinct accessible name so
    // the two never collide.
    expect(
      within(invoiceSection()).getByRole('button', { name: /^reset to default$/i }),
    ).toBeInTheDocument();
  });

  it('resets the email subject to its own default without touching the message', async () => {
    fetchMock.mockResolvedValue(
      settings(
        { enabled: true, emailSubject: 'Custom subject line', emailMessage: '<p>my own words</p>' },
        {},
      ),
    );
    const user = userEvent.setup();
    await renderPanel();

    await user.click(
      within(invoiceSection()).getByRole('button', { name: /reset subject to default/i }),
    );

    expect(
      within(invoiceSection()).getByLabelText(/email subject/i),
    ).toHaveValue(DEFAULT_EMAIL_SUBJECT.invoice);
    // The message reset is a separate control; resetting the subject must not
    // also revert the message.
    expect(within(invoiceSection()).getByText(/my own words/i)).toBeInTheDocument();
  });
});
