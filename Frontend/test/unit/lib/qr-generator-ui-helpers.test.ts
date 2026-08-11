import { describe, it, expect } from 'vitest';
import { getQrSelectionButtonLabel } from '@/lib/qr-generator-ui-helpers';

const CUSTOM_URL_SELECTION_ID = '__qr_custom_url__';

const ITEMS = [
  { id: '9241', name: 'Incident Report', type: 'form' },
  { id: '31007', name: 'Service Agreement', type: 'document' },
];

describe('getQrSelectionButtonLabel', () => {
  it('reports the custom kind with no suffix when the custom url is blank', () => {
    expect(
      getQrSelectionButtonLabel(CUSTOM_URL_SELECTION_ID, '', CUSTOM_URL_SELECTION_ID, ITEMS),
    ).toEqual({ kind: 'custom', suffix: '' });
  });

  it('treats a whitespace-only custom url as blank', () => {
    expect(
      getQrSelectionButtonLabel(CUSTOM_URL_SELECTION_ID, '   \t ', CUSTOM_URL_SELECTION_ID, ITEMS),
    ).toEqual({ kind: 'custom', suffix: '' });
  });

  it('appends the trimmed custom url when it is 36 characters or fewer', () => {
    // exactly 36 characters
    const url = 'https://example.com/forms/abcdefghij';
    expect(
      getQrSelectionButtonLabel(CUSTOM_URL_SELECTION_ID, `  ${url}  `, CUSTOM_URL_SELECTION_ID, ITEMS),
    ).toEqual({ kind: 'custom', suffix: ' — https://example.com/forms/abcdefghij' });
  });

  it('truncates a custom url longer than 36 characters to 36 plus an ellipsis', () => {
    // 37 characters — one over the threshold
    const url37 = 'https://example.com/forms/abcdefghijk';
    expect(
      getQrSelectionButtonLabel(CUSTOM_URL_SELECTION_ID, url37, CUSTOM_URL_SELECTION_ID, ITEMS),
    ).toEqual({ kind: 'custom', suffix: ' — https://example.com/forms/abcdefghij…' });

    const url40 = 'https://example.com/forms/abcdefghijklmn';
    expect(
      getQrSelectionButtonLabel(CUSTOM_URL_SELECTION_ID, url40, CUSTOM_URL_SELECTION_ID, ITEMS),
    ).toEqual({ kind: 'custom', suffix: ' — https://example.com/forms/abcdefghij…' });
  });

  it('returns the placeholder when nothing is selected', () => {
    expect(getQrSelectionButtonLabel('', 'https://ignored.example', CUSTOM_URL_SELECTION_ID, ITEMS)).toEqual({
      kind: 'placeholder',
      text: 'Select a form or document...',
    });
  });

  it('returns the placeholder when the selected id is not in the item list', () => {
    expect(getQrSelectionButtonLabel('does-not-exist', '', CUSTOM_URL_SELECTION_ID, ITEMS)).toEqual({
      kind: 'placeholder',
      text: 'Select a form or document...',
    });
  });

  it('returns the matching item', () => {
    const result = getQrSelectionButtonLabel('31007', '', CUSTOM_URL_SELECTION_ID, ITEMS);
    expect(result).toEqual({
      kind: 'item',
      item: { id: '31007', name: 'Service Agreement', type: 'document' },
    });
    expect((result as { item: unknown }).item).toBe(ITEMS[1]);
  });

  it('matches ids across string/number types', () => {
    const numericItems = [{ id: 9241 as unknown as string, name: 'Incident Report', type: 'form' }];
    expect(getQrSelectionButtonLabel('9241', '', CUSTOM_URL_SELECTION_ID, numericItems)).toEqual({
      kind: 'item',
      item: numericItems[0],
    });
  });

  it('prefers the custom branch even when an item shares the custom id', () => {
    const colliding = [{ id: CUSTOM_URL_SELECTION_ID, name: 'Decoy', type: 'form' }];
    expect(
      getQrSelectionButtonLabel(
        CUSTOM_URL_SELECTION_ID,
        'https://example.com',
        CUSTOM_URL_SELECTION_ID,
        colliding,
      ),
    ).toEqual({ kind: 'custom', suffix: ' — https://example.com' });
  });
});
