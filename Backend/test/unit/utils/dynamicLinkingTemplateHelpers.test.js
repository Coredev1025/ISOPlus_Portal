import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseTemplateMatchTokens,
  collectLinksFromTemplateText,
} from '../../../src/utils/dynamicLinkingTemplateHelpers.js';

// tokenizeString (src/utils/dynamicLinking.js) console.warn()s whenever a
// placeholder does not yield exactly three tokens. Silence it where a test
// deliberately supplies a malformed placeholder.
function silenceTokenWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseTemplateMatchTokens', () => {
  it('splits a well-formed placeholder into label, board and target', () => {
    const match = ['{{ Support Coordinator > Staff > Full Name }}', 'Support Coordinator > Staff > Full Name '];

    expect(parseTemplateMatchTokens(match)).toEqual({
      label: 'Support Coordinator',
      targetBoardName: 'Staff',
      targetName: 'Full Name',
      originalMatch: '{{ Support Coordinator > Staff > Full Name }}',
    });
  });

  it('carries match[0] through as originalMatch verbatim', () => {
    const match = ['{{Client>Clients>Name}}', 'Client>Clients>Name'];

    expect(parseTemplateMatchTokens(match).originalMatch).toBe('{{Client>Clients>Name}}');
  });

  it('strips HTML tags introduced by the ISO+ rich-text editor', () => {
    const match = ['{{ <b>Client</b> > Clients > Full Name }}', '<b>Client</b> > Clients > Full Name '];

    expect(parseTemplateMatchTokens(match)).toEqual({
      label: 'Client',
      targetBoardName: 'Clients',
      targetName: 'Full Name',
      originalMatch: '{{ <b>Client</b> > Clients > Full Name }}',
    });
  });

  it('decodes HTML entities back to their characters', () => {
    const match = ['{{ Smith &amp; Co > Providers > Trading Name }}', 'Smith &amp; Co > Providers > Trading Name '];

    expect(parseTemplateMatchTokens(match).label).toBe('Smith & Co');
  });

  it('keeps a quoted ">" inside a token and unwraps the quotes', () => {
    const match = ['{{ "Client > VIP" > Clients > Full Name }}', '"Client > VIP" > Clients > Full Name '];

    expect(parseTemplateMatchTokens(match)).toEqual({
      label: 'Client > VIP',
      targetBoardName: 'Clients',
      targetName: 'Full Name',
      originalMatch: '{{ "Client > VIP" > Clients > Full Name }}',
    });
  });

  it('unwraps single-quoted tokens too', () => {
    const match = ["{{ 'Plan > 2026' > Plans > Plan Number }}", "'Plan > 2026' > Plans > Plan Number "];

    expect(parseTemplateMatchTokens(match).label).toBe('Plan > 2026');
  });

  it('collapses runs of whitespace inside each token', () => {
    const match = [
      '{{ Client   Name > Support  Plans > Plan  Number }}',
      'Client   Name > Support  Plans > Plan  Number ',
    ];

    expect(parseTemplateMatchTokens(match)).toEqual({
      label: 'Client Name',
      targetBoardName: 'Support Plans',
      targetName: 'Plan Number',
      originalMatch: '{{ Client   Name > Support  Plans > Plan  Number }}',
    });
  });

  it('collapses newlines and tabs the same way', () => {
    const match = ['{{ Client >\n\tClients > Full\tName }}', 'Client >\n\tClients > Full\tName '];

    expect(parseTemplateMatchTokens(match)).toEqual({
      label: 'Client',
      targetBoardName: 'Clients',
      targetName: 'Full Name',
      originalMatch: '{{ Client >\n\tClients > Full\tName }}',
    });
  });

  it('leaves the missing parts undefined when fewer than three tokens are present', () => {
    silenceTokenWarnings();

    expect(parseTemplateMatchTokens(['{{ Client > Clients }}', 'Client > Clients '])).toEqual({
      label: 'Client',
      targetBoardName: 'Clients',
      targetName: undefined,
      originalMatch: '{{ Client > Clients }}',
    });

    expect(parseTemplateMatchTokens(['{{ Client }}', 'Client '])).toEqual({
      label: 'Client',
      targetBoardName: undefined,
      targetName: undefined,
      originalMatch: '{{ Client }}',
    });
  });

  it('yields an empty label for a whitespace-only placeholder', () => {
    silenceTokenWarnings();

    expect(parseTemplateMatchTokens(['{{ }}', ' '])).toEqual({
      label: '',
      targetBoardName: undefined,
      targetName: undefined,
      originalMatch: '{{ }}',
    });
  });

  it('ignores tokens beyond the third', () => {
    silenceTokenWarnings();

    expect(parseTemplateMatchTokens(['{{ A > B > C > D }}', 'A > B > C > D '])).toEqual({
      label: 'A',
      targetBoardName: 'B',
      targetName: 'C',
      originalMatch: '{{ A > B > C > D }}',
    });
  });
});

describe('collectLinksFromTemplateText', () => {
  it('finds a single placeholder inside surrounding rich text', () => {
    const text = '<p>Please review {{ Client Name > Clients > Full Name }} today</p>';

    expect(collectLinksFromTemplateText(text)).toEqual([
      {
        label: 'Client Name',
        targetBoardName: 'Clients',
        targetName: 'Full Name',
        originalMatch: '{{ Client Name > Clients > Full Name }}',
      },
    ]);
  });

  it('finds every placeholder in order, each with its own originalMatch', () => {
    const text =
      'Hi {{ Participant > Clients > Full Name }}, your plan {{ Plan > Support Plans > Plan Number }} is ready.';

    expect(collectLinksFromTemplateText(text)).toEqual([
      {
        label: 'Participant',
        targetBoardName: 'Clients',
        targetName: 'Full Name',
        originalMatch: '{{ Participant > Clients > Full Name }}',
      },
      {
        label: 'Plan',
        targetBoardName: 'Support Plans',
        targetName: 'Plan Number',
        originalMatch: '{{ Plan > Support Plans > Plan Number }}',
      },
    ]);
  });

  it('returns the same result when called twice on the same text', () => {
    const text = 'Hi {{ Participant > Clients > Full Name }}';

    const first = collectLinksFromTemplateText(text);
    const second = collectLinksFromTemplateText(text);

    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });

  it('returns an empty array when there is no placeholder', () => {
    expect(collectLinksFromTemplateText('<p>Nothing to link here</p>')).toEqual([]);
    expect(collectLinksFromTemplateText('{ not a placeholder }')).toEqual([]);
  });

  it('ignores an empty placeholder, which the regex cannot match', () => {
    expect(collectLinksFromTemplateText('before {{}} after')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(collectLinksFromTemplateText('')).toEqual([]);
  });

  it('returns an empty array for non-string input', () => {
    expect(collectLinksFromTemplateText(undefined)).toEqual([]);
    expect(collectLinksFromTemplateText(null)).toEqual([]);
    expect(collectLinksFromTemplateText(123)).toEqual([]);
    expect(collectLinksFromTemplateText({ data: '{{ A > B > C }}' })).toEqual([]);
    expect(collectLinksFromTemplateText(['{{ A > B > C }}'])).toEqual([]);
  });

  it('handles an automation templateItemValue payload with markup around the placeholder', () => {
    const text =
      '<div>Invoice for <strong>{{ Participant Full Name > NDIS Master Plan > Participant Full Name }}</strong></div>';

    expect(collectLinksFromTemplateText(text)).toEqual([
      {
        label: 'Participant Full Name',
        targetBoardName: 'NDIS Master Plan',
        targetName: 'Participant Full Name',
        originalMatch: '{{ Participant Full Name > NDIS Master Plan > Participant Full Name }}',
      },
    ]);
  });

  it('still returns a malformed placeholder rather than skipping it', () => {
    silenceTokenWarnings();

    expect(collectLinksFromTemplateText('{{ JustALabel }}')).toEqual([
      {
        label: 'JustALabel',
        targetBoardName: undefined,
        targetName: undefined,
        originalMatch: '{{ JustALabel }}',
      },
    ]);
  });
});
