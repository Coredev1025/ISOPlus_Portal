// Dynamic-field substitution for automation email templates ({{invoice_number}},
// {{client_name}}, ...). Pure: substitutes only the vars it is given and leaves
// everything else exactly as the author typed it.

const TOKEN_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a raw value for interpolation into HTML.
 *
 * Applied to the substituted value only, never to the composed string: the
 * emailMessage template is rich-text HTML the customer authored, so escaping
 * the whole result mails visible `&lt;p&gt;`, and escaping twice produces
 * `&amp;amp;`.
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
 * `options.escapeHtml` is a parameter here rather than something the caller
 * applies afterwards because only substitution knows which span of the result
 * came from data. Callers pass it for emailMessage (HTML) and omit it for
 * emailSubject (plain text, where `&amp;` is read literally by mail clients).
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
