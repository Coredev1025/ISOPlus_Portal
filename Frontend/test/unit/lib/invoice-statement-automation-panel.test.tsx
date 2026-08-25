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
  };
});

import { InvoiceStatementAutomationPanel } from '@/lib/invoice-statement-automation-panel';
import {
  DEFAULT_BLOCK,
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

    const invoice = within(invoiceSection());
    for (const label of [/send a copy to/i, /reply-to email/i, /email from/i]) {
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
