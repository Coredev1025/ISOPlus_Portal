/**
 * Pure helpers for the "Send from Accounting Platform" delivery route.
 *
 * Nothing here talks to Xero or to Mongo, deliberately: the module that does
 * (services/automation/pushDraftInvoicesToXero.js) stays a thin orchestrator
 * over the Invoice Generator → Xero handler the portal already ships, and the
 * decisions that decide whether a real ACCREC draft gets created are testable
 * without a network or a database.
 */

/**
 * The invoices a run should push, one per generated document.
 *
 * The generator returns one row per PDF, but a replayed slot concatenates rows
 * re-read off PDFLink with rows it generated, and a multi-item participant
 * group yields several rows sharing one invoice number. Pushing that number
 * twice puts two drafts in the client's accountant's Xero for one PDF, which
 * is a billing bug rather than a cosmetic one.
 *
 * Rows with no invoice number are dropped: a statement row carries a
 * statementNumber instead, and a generator row that produced nothing carries
 * neither. Neither can be referenced on a Xero invoice.
 */
export function xeroPushDocuments(results) {
  const byNumber = new Map();
  for (const row of results ?? []) {
    const invoiceNumber = String(row?.invoiceNumber ?? '').trim();
    if (!invoiceNumber || byNumber.has(invoiceNumber)) continue;
    byNumber.set(invoiceNumber, {
      invoiceNumber,
      participant: String(row.participant ?? '').trim(),
    });
  }
  return [...byNumber.values()];
}

/**
 * An Express-shaped `res` that records what a route handler answered with.
 *
 * The shipping Xero handlers are route handlers, and they answer their own
 * failures with a 200 carrying `{message}` — so a caller that only awaits them
 * cannot tell a created draft from a refusal. Capturing the answer is what
 * lets the caller fail the job instead of marking it green with nothing in
 * Xero. Same seam services/automation/generateDocuments.js already uses to
 * call the participant-tax PDF generator.
 */
export function captureRouteRes() {
  const captured = { status: 200, body: null };
  const res = {
    status(code) {
      captured.status = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

/** Whether a workspace's Business record can reach Xero right now. */
export function isXeroConnectedBusiness(business) {
  return Boolean(business?.xeroIntegrated && business?.xeroTokens?.accessToken);
}

function escapeRegExpLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The Xero line description rule: "<service> - <dd/mm/yyyy>", idempotent.
 *
 * A verbatim copy of the private `appendDateSuffix` in routes/xero.js, which
 * the UI's Xero push hands to the same handler. It is duplicated rather than
 * imported because importing it would pull an Express router — and its whole
 * model and service graph — into the BullMQ worker's import graph for one pure
 * six-line function. Its behaviour is pinned by test, and exporting the
 * canonical one so both callers share it is a follow-up, not this ticket.
 */
export function appendXeroLineDateSuffix(description, rowDate) {
  const base = (description ?? '').toString().trim() || 'Service';
  const date = (rowDate ?? '').toString().trim();
  if (!date) return base;

  const alreadySuffixed = new RegExp(`\\s*-\\s*${escapeRegExpLiteral(date)}\\s*$`).test(base);
  return alreadySuffixed ? base : `${base} - ${date}`;
}
