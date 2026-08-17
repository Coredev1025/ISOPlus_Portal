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

// jsdom ships none of these, and Radix's Select calls all of them while opening.
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

  it('renders a populated Next Run formatted, not as a raw ISO string', async () => {
    fetchMock.mockResolvedValue(
      settings({ enabled: true, nextRun: '2026-09-01T12:00:00.000Z' })
    );
    await renderPanel();

    const nextRun = within(invoiceSection()).getByLabelText(
      /next run/i
    ) as HTMLInputElement;

    // Asserted by shape, not by an exact string: date-fns formats in the
    // runner's local zone and the value must not depend on it.
    expect(nextRun.value).toMatch(
      /^\d{2}\/\d{2}\/\d{4} at \d{1,2}:\d{2} (AM|PM)$/
    );
    expect(nextRun.value).not.toContain('T');
    expect(nextRun.value).not.toContain('Z');
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

  it('leaves the date input empty when there is no start date', async () => {
    fetchMock.mockResolvedValue(settings({ enabled: true }));
    await renderPanel();

    expect(within(invoiceSection()).getByLabelText(/start date/i)).toHaveValue('');
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

  it('renders Email Message as a full-width multiline textarea', async () => {
    fetchMock.mockResolvedValue(settings({ enabled: true }, { enabled: true }));
    await renderPanel();

    for (const section of [invoiceSection(), statementSection()]) {
      const message = within(section).getByLabelText(/email message/i);
      // A one-line third-width input truncates any real message; the field is
      // a textarea spanning the grid so the text stays readable while editing.
      expect(message.tagName).toBe('TEXTAREA');
      expect(message.closest('.md\\:col-span-3')).not.toBeNull();
    }
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
});
