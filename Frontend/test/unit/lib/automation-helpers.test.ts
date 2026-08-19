import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  blockNeedsAttention,
  deliveryStatus,
  formatNextRun,
  hasInvalidEmail,
  documentHref,
  recentDocumentLabel,
  toDateInputValue,
} from '@/lib/automation-helpers';
import {
  DEFAULT_BLOCK,
  type AutomationBlock,
  type AutomationRecentDocument,
  type AutomationSettings,
} from '@/lib/automation-settings';

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

function document(
  overrides: Partial<AutomationRecentDocument> = {}
): AutomationRecentDocument {
  return {
    type: 'Monthly Statement',
    invoiceNumber: null,
    periodKey: '20250201-0900',
    pdfUrl: 'https://files.test/Jane-Smith_January_2025_Statement.pdf',
    createdAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('formatNextRun', () => {
  it('renders an em dash for null, undefined and unparseable values', () => {
    expect(formatNextRun(null)).toBe('—');
    expect(formatNextRun(undefined)).toBe('—');
    expect(formatNextRun('not-a-date')).toBe('—');
  });

  it('formats an instant in the reader local time, not as raw ISO', () => {
    const formatted = formatNextRun('2026-09-01T12:00:00.000Z');
    // Asserted by shape: date-fns formats in the runner's zone, and the value
    // must not depend on it.
    expect(formatted).toMatch(/^\d{2}\/\d{2}\/\d{4} at \d{1,2}:\d{2} (AM|PM)$/);
    expect(formatted).not.toContain('T');
  });
});

describe('toDateInputValue', () => {
  it('is empty for a missing start date', () => {
    expect(toDateInputValue(null)).toBe('');
  });

  it('slices the date portion out of a server ISO instant', () => {
    // Sliced rather than parsed on purpose: the stored value is midnight UTC,
    // and parsing into local time rolls the day back west of Greenwich.
    expect(toDateInputValue('2026-03-01T00:00:00.000Z')).toBe('2026-03-01');
  });

  it('is empty for anything that is not yyyy-mm-dd', () => {
    expect(toDateInputValue('01/03/2026')).toBe('');
  });
});

describe('recentDocumentLabel', () => {
  it('prefers the invoice number when there is one', () => {
    expect(
      recentDocumentLabel(document({ invoiceNumber: 'INV-1004 (ISO+™)' }))
    ).toBe('INV-1004 (ISO+™)');
  });

  it('prefers the structured participant over the file name', () => {
    // The file name is an S3 convention; a backend rename must not silently
    // degrade every label, so a structured field wins whenever it is sent.
    expect(recentDocumentLabel(document({ participant: 'Jane Smith' }))).toBe(
      'Jane Smith'
    );
  });

  it('falls back to the file name when no structured field is sent', () => {
    expect(recentDocumentLabel(document())).toBe(
      'Jane-Smith_January_2025_Statement'
    );
  });

  it('falls back to the type when the URL has no basename', () => {
    // A link whose accessible name is '' is unusable, so an empty basename
    // must never reach the DOM.
    expect(recentDocumentLabel(document({ pdfUrl: 'https://files.test/' }))).toBe(
      'Monthly Statement'
    );
  });

  it('falls back to the type when the basename is not decodable', () => {
    expect(
      recentDocumentLabel(document({ pdfUrl: 'https://files.test/%E0%A4%A.pdf' }))
    ).toBe('Monthly Statement');
  });

  // pdfUrl is now a link to the backend's re-signing route, whose last segment
  // is a Mongo id. Labelling a document '6a84f789c9d48680d19276c1' is worse
  // than labelling it by its type, so only a URL that actually names a file is
  // allowed to supply one.
  it('does not label a document with the id in a download link', () => {
    expect(
      recentDocumentLabel(
        document({ pdfUrl: '/api/pdf-links/download/6a84f789c9d48680d19276c1' })
      )
    ).toBe('Monthly Statement');
  });
});

/**
 * The panel links to the backend, which returns a PATH: it does not reliably
 * know its own public origin, and the frontend already prefixes
 * NEXT_PUBLIC_BACKEND_URL for every other call.
 */
describe('documentHref', () => {
  const saved = process.env.NEXT_PUBLIC_BACKEND_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_BACKEND_URL = 'https://api.test';
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_BACKEND_URL;
    else process.env.NEXT_PUBLIC_BACKEND_URL = saved;
  });

  it('prefixes the backend origin onto a path', () => {
    expect(documentHref('/api/pdf-links/download/abc')).toBe(
      'https://api.test/api/pdf-links/download/abc'
    );
  });

  // Older rows, and anything a future backend sends absolute, must still work.
  it('leaves an absolute URL alone', () => {
    expect(documentHref('https://files.test/a.pdf')).toBe(
      'https://files.test/a.pdf'
    );
  });

  it('leaves an empty value alone rather than linking to the backend root', () => {
    expect(documentHref('')).toBe('');
  });
});

describe('blockNeedsAttention', () => {
  it('is false for a clean block', () => {
    expect(blockNeedsAttention(block({ enabled: true }))).toBe(false);
  });

  it('is true when the server sends a last-run error message', () => {
    expect(
      blockNeedsAttention(block({ enabled: true, lastRunError: 'boom' }))
    ).toBe(true);
  });

  it('is true when the server sends only a coarse failure flag', () => {
    // The API may report the failure without its message; both shapes mean
    // the same thing to the badge.
    expect(
      blockNeedsAttention(block({ enabled: true, lastRunFailed: true }))
    ).toBe(true);
  });

  it('is true when the server sends only a consecutive-failure count', () => {
    expect(
      blockNeedsAttention(block({ enabled: true, consecutiveFailures: 2 }))
    ).toBe(true);
  });
});

describe('hasInvalidEmail', () => {
  it('is false when every address field is empty', () => {
    expect(hasInvalidEmail(settings({ enabled: true }, { enabled: true }))).toBe(
      false
    );
  });

  it('is true when an enabled block holds a malformed address', () => {
    expect(
      hasInvalidEmail(settings({ enabled: true, replyTo: 'not-an-email' }))
    ).toBe(true);
  });

  it('ignores a disabled block, whose fields are not on screen to fix', () => {
    expect(
      hasInvalidEmail(settings({ enabled: false, replyTo: 'not-an-email' }))
    ).toBe(false);
  });

  it('ignores the non-address fields', () => {
    expect(
      hasInvalidEmail(settings({ enabled: true, emailSubject: 'not-an-email' }))
    ).toBe(false);
  });
});

describe('deliveryStatus', () => {
  it('reads a delivered send as delivered, with no inline detail to show', () => {
    expect(deliveryStatus(document({ deliveryState: 'delivered' }))).toEqual({
      label: 'Delivered',
      tone: 'ok',
      detail: null,
    });
  });

  it('surfaces a bounce with the plain-English reason the client must act on', () => {
    expect(
      deliveryStatus(
        document({
          deliveryState: 'bounced',
          deliveryDetail: "Email address doesn't exist.",
        })
      )
    ).toEqual({
      label: 'Bounced',
      tone: 'bad',
      detail: "Email address doesn't exist.",
    });
  });

  it('calls a rejected send "Failed to send", the spec\'s wording', () => {
    expect(deliveryStatus(document({ deliveryState: 'failed' })).label).toBe(
      'Failed to send'
    );
  });

  it('treats a document with no event yet as Generated, not as a failure', () => {
    expect(deliveryStatus(document())).toEqual({
      label: 'Generated',
      tone: 'muted',
      detail: null,
    });
    expect(deliveryStatus(document({ deliveryState: 'generated' })).tone).toBe(
      'muted'
    );
  });

  it('reports a sent-but-unconfirmed document as Sent', () => {
    expect(deliveryStatus(document({ deliveryState: 'sent' })).label).toBe('Sent');
  });

  it('falls back to Generated for a state this build does not know', () => {
    expect(
      deliveryStatus(document({ deliveryState: 'teleported' as never })).label
    ).toBe('Generated');
  });

  it('never shows a detail line against a state that is not a problem', () => {
    // A stale detail left over from an earlier state must not be rendered
    // beside "Delivered", where it would read as a live failure.
    expect(
      deliveryStatus(
        document({ deliveryState: 'delivered', deliveryDetail: 'Mailbox full.' })
      ).detail
    ).toBeNull();
  });
});
