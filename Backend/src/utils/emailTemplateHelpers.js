// Dynamic-field substitution for automation email templates ({{invoice_number}},
// {{client_name}}, {{business_name}}, ...). Pure and dependency-free: the
// caller (workers/automationWorker.js) decides which vars a run actually has;
// this helper substitutes only what it is given and leaves everything else
// exactly as the author typed it.

const TOKEN_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a raw value for interpolation into HTML text or an attribute value.
 *
 * Applied to the substituted value only, never to the composed string. The
 * emailMessage template is rich-text HTML the customer authored; escaping the
 * whole result would mail a body full of visible `&lt;p&gt;`, and escaping
 * twice is exactly the bug that produces `&amp;amp;`. Values, by contrast, are
 * raw ISO+ board data — a participant literally named "Tom & Jerry" — and have
 * no markup meaning at all.
 */
function escapeHtmlValue(value) {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * Replace `{{key}}` tokens in `template` with `vars[key]`, tolerating
 * whitespace inside the braces (`{{ client_name }}`).
 *
 * A token whose key is absent from `vars` — or whose value is null/undefined —
 * is left intact verbatim, never rendered as 'undefined' or ''. A non-string
 * template returns ''.
 *
 * `options.escapeHtml` escapes each substituted value on the way in. It is a
 * parameter of this function rather than something the caller applies
 * afterwards because only substitution knows which span of the result came
 * from data: a caller escaping the composed string cannot tell the author's
 * `<p>` from a participant's `<b>`. Callers pass it for emailMessage (HTML)
 * and omit it for emailSubject (plain text, where `&amp;` would be read
 * literally by every mail client).
 */
export function substituteEmailTemplate(template, vars, { escapeHtml = false } = {}) {
  if (typeof template !== 'string') return '';
  const source = vars && typeof vars === 'object' ? vars : {};
  return template.replace(TOKEN_PATTERN, (token, key) => {
    if (!Object.hasOwn(source, key) || source[key] == null) return token;
    const value = String(source[key]);
    return escapeHtml ? escapeHtmlValue(value) : value;
  });
}
