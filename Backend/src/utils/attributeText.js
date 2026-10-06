import { formatLabelValue } from './ndisServiceRecords.js';

/**
 * A profile attribute as the text a document prints (KAN-298).
 *
 * A dropdown (select) attribute such as State is stored as an object,
 * `{ id, name, color }`, or as a list of them. Turning that into a string with
 * `String()` prints "[object Object]", which is what the participant tax invoice
 * and the statement did. `formatLabelValue` already reads such a value as its
 * name, label or value; this adds the guarantee that nothing it cannot read ever
 * comes out as "[object Object]": that becomes empty text, so the part is left
 * out of the printed line instead of being printed as noise.
 *
 * Text and numbers come back as themselves, trimmed.
 *
 * Pure. Used by utils/invoiceRecipientHelpers.js and utils/statementOfAccountDocument.js.
 */
export function attributeText(value) {
  const text = formatLabelValue(value).trim();
  return text.includes('[object Object]') ? '' : text;
}
