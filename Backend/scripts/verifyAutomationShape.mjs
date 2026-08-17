// Pure checks for verify-automation-output.mjs — no fs, no pdf library, so it
// is unit-testable on its own.
//
// The question these answer is narrower than "did the run succeed": a tick can
// report claimed=2 dispatched=2 failed=0 and still produce a template with
// every rule and heading in place and not one value on it. Bytes on disk do
// not distinguish the two; embedded text does.

import { inflateSync } from 'node:zlib';

/**
 * Characters inside the text-showing operators of every content stream.
 *
 * Both string forms are counted: literal `(Jane Smith) Tj`, and the hex
 * `<0048...> Tj` that pdfme emits once it embeds a subset font — which is what
 * the real invoices use, so a literals-only reader would call every one of
 * them blank. A stream that will not inflate is skipped rather than thrown on:
 * an image XObject is not evidence either way.
 */
export function pdfTextVolume(buf) {
  let total = 0;
  let i = 0;
  while ((i = buf.indexOf('stream', i)) !== -1) {
    let start = i + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = buf.indexOf('endstream', start);
    if (end === -1) break;
    try {
      const content = inflateSync(buf.subarray(start, end)).toString('latin1');
      const shown = content.match(/\((?:[^()\\]|\\.)*\)\s*T[jJ]|<[0-9A-Fa-f\s]+>\s*T[jJ]/g) ?? [];
      for (const op of shown) total += op.length;
    } catch {
      // Not a content stream (or not Flate) — nothing to read.
    }
    i = end + 9;
  }
  return total;
}

/** Which generator wrote a document, from the folder the uploader chose. */
export function classifyPdf(relativePath) {
  return relativePath.includes('monthly-statements') ? 'statement' : 'invoice';
}

/**
 * Attachments on a composed email that another board generated.
 *
 * Non-empty means the cross-board bleed is back: PDF lookups scoped only by
 * workspace and period match a sibling board's rows, and a client is emailed
 * documents belonging to someone else's board. Decoded first, because the
 * stored URLs percent-encode the '+' and '™' in invoice file names.
 */
export function foreignAttachments(email) {
  const ownSegment = `/${email.boardId}/`;
  return (email.attachments ?? []).filter((url) => {
    let path = url;
    try {
      path = decodeURIComponent(url);
    } catch {
      // Undecodable is still comparable in its raw form.
    }
    return !path.includes(ownSegment);
  });
}

/**
 * The verdict for one run. `ok` is false for a blank PDF, an email carrying
 * another board's document, or a run that produced nothing — the last because
 * "none of the zero PDFs were blank" passes every other check trivially, and a
 * tick that generated nothing is the outcome most worth catching.
 */
export function summariseRun({ pdfs, emails }) {
  const blankPdfs = pdfs.filter((pdf) => pdf.textChars === 0).map((pdf) => pdf.file);
  const bleedingEmails = emails
    .filter((email) => foreignAttachments(email).length > 0)
    .map((email) => email.file);

  return {
    counts: {
      pdfs: pdfs.length,
      invoices: pdfs.filter((pdf) => pdf.kind === 'invoice').length,
      statements: pdfs.filter((pdf) => pdf.kind === 'statement').length,
      emails: emails.length,
    },
    blankPdfs,
    bleedingEmails,
    ok: pdfs.length > 0 && blankPdfs.length === 0 && bleedingEmails.length === 0,
  };
}
