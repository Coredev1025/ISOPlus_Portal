// Dynamic-field substitution for automation email templates ({{invoice_number}},
// {{client_name}}, {{business_name}}, ...). Pure and dependency-free: the
// caller (workers/automationWorker.js) decides which vars a run actually has;
// this helper substitutes only what it is given and leaves everything else
// exactly as the author typed it.

const TOKEN_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Replace `{{key}}` tokens in `template` with `vars[key]`, tolerating
 * whitespace inside the braces (`{{ client_name }}`).
 *
 * A token whose key is absent from `vars` — or whose value is null/undefined —
 * is left intact verbatim, never rendered as 'undefined' or ''. A non-string
 * template returns ''.
 */
export function substituteEmailTemplate(template, vars) {
  if (typeof template !== 'string') return '';
  const source = vars && typeof vars === 'object' ? vars : {};
  return template.replace(TOKEN_PATTERN, (token, key) => (
    Object.hasOwn(source, key) && source[key] != null ? String(source[key]) : token
  ));
}
