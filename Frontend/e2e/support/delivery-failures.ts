import { execFileSync } from "node:child_process";

/**
 * Simulated email delivery failures, for the Epic 6 screens that report them.
 *
 * ## Why this is seeded rather than provoked
 *
 * A real bounce needs SES to accept a message and then publish a Bounce event
 * to SNS → SQS minutes later. Locally there is no SES: the automation worker
 * falls back to the offline outbox backend, which writes a file and records no
 * messageId, so no delivery event can ever be matched back to a document. Even
 * with credentials, an environment in the SES sandbox refuses unverified
 * recipients before a bounce can happen, and the mailbox simulator's events
 * only arrive if SES_EVENTS_QUEUE_URL is wired to a real queue.
 *
 * So the pipeline that PRODUCES these rows cannot run on a laptop. What can
 * and must be tested locally is everything downstream of it: that a bounce,
 * a complaint and a rendering failure each reach the right screen, read
 * correctly, and are attributed to the right message.
 *
 * These rows are therefore written in exactly the shape the real consumers
 * write them:
 *   - `emailevents`  as services/email/events.js records them, eventType
 *                    verbatim from SES ('Bounce', 'Complaint', ...)
 *   - `emailsends`   as services/email/backends.js records them at send time
 *   - `pdflinks`     as services/email/deliveryEvents.js leaves them after
 *                    applyDeliveryEvent has run
 *
 * If those writers change shape, these fixtures go stale — which is the honest
 * trade for being able to test the reporting at all.
 */

/**
 * Which database to seed.
 *
 * Not hardcoded: `npm run worktree -- new --isolated-db` gives a worktree its
 * own database named after the branch, and writing into `business-dashboard`
 * from an isolated worktree seeds a database the app under test is not reading.
 * That failure is silent — the fixture succeeds and every assertion then fails
 * for reasons that look nothing like the cause.
 */
const DB = process.env.E2E_MONGO_DB ?? "business-dashboard";

/**
 * Which spec owns a set of seeded rows.
 *
 * `playwright.config.ts` sets `fullyParallel: true`, so two spec files run in
 * two workers against one database. A single shared marker would mean one
 * file's cleanup deletes rows the other file is still asserting on — a failure
 * that appears only under load and looks like a product bug. Each caller
 * therefore seeds and deletes under its own marker.
 */
export type Suite = "system-health" | "client-panel";

/** The `jobId` of the run this suite's rows belong to. */
export function runMarker(suite: Suite): string {
  return `e2e-delivery-failure-${suite}`;
}

/** The SES messageId of one seeded send. */
export function messageId(suite: Suite, name: string): string {
  return `e2e-msg-${suite}-${name}`;
}

/** The invoice number of one seeded document, as the client panel labels it. */
export function invoiceNumber(suite: Suite, name: string): string {
  return `INV-E2E-${suite === "system-health" ? "SH" : "CP"}-${name.toUpperCase()}`;
}

function mongoEval(script: string): void {
  execFileSync(
    "docker",
    ["exec", "-i", "isoplus-mongo", "mongosh", DB, "--quiet", "--eval", script],
    { stdio: "pipe" },
  );
}

export type SeedOptions = {
  suite: Suite;
  workspaceId: string;
  boardId?: string;
  periodKey?: string;
};

/**
 * One run, four messages, four outcomes: delivered, bounced, complained, and a
 * rendering failure — the case that used to leave a document reading "Sent"
 * forever because the event type had no mapped state.
 */
export function seedDeliveryFailures({
  suite,
  workspaceId,
  boardId = "b1",
  periodKey = "20260401-0900",
}: SeedOptions): void {
  const msg = (name: string) => JSON.stringify(messageId(suite, name));
  const inv = (name: string) => JSON.stringify(invoiceNumber(suite, name));

  mongoEval(`
    const now = new Date();
    const marker = ${JSON.stringify(runMarker(suite))};
    const idPrefix = ${JSON.stringify(`^${messageId(suite, "")}`)};
    const ws = ${JSON.stringify(workspaceId)};
    const board = ${JSON.stringify(boardId)};
    const period = ${JSON.stringify(periodKey)};

    db.automationruns.deleteMany({ jobId: marker });
    db.emailsends.deleteMany({ messageId: new RegExp(idPrefix) });
    db.emailevents.deleteMany({ sesMessageId: new RegExp(idPrefix) });
    db.pdflinks.deleteMany({ itemId: marker });

    db.automationruns.insertOne({
      jobId: marker, workspaceId: ws, boardId: board, kind: 'invoice_automation',
      periodKey: period, status: 'succeeded', trigger: 'schedule',
      startedAt: now, finishedAt: now, durationMs: 1200,
      createdAt: now, updatedAt: now,
    });

    // As services/email/backends.js writes them at send time.
    db.emailsends.insertMany([
      { messageId: ${msg("delivered")}, kind: 'invoice_automation', workspaceId: ws, boardId: board, periodKey: period, recipientKey: 'Mike Bird',    recipientType: 'billing_contact',    createdAt: now, updatedAt: now },
      { messageId: ${msg("bounced")},   kind: 'invoice_automation', workspaceId: ws, boardId: board, periodKey: period, recipientKey: 'Jane Smith',   recipientType: 'client_participant', createdAt: now, updatedAt: now },
      { messageId: ${msg("complaint")}, kind: 'invoice_automation', workspaceId: ws, boardId: board, periodKey: period, recipientKey: 'Sam Rivers',   recipientType: 'billing_contact',    createdAt: now, updatedAt: now },
      { messageId: ${msg("render")},    kind: 'invoice_automation', workspaceId: ws, boardId: board, periodKey: period, recipientKey: 'Pat Template', recipientType: 'billing_contact',    createdAt: now, updatedAt: now },
    ]);

    // As services/email/events.js records them: eventType verbatim from SES,
    // detail under the type's own key.
    db.emailevents.insertMany([
      { eventType: 'Delivery',          sesMessageId: ${msg("delivered")}, eventAt: now, recipients: [], detail: null, createdAt: now, updatedAt: now },
      { eventType: 'Bounce',            sesMessageId: ${msg("bounced")},   eventAt: now, recipients: [], detail: { bounceType: 'Permanent', bounceSubType: 'NoEmail' }, createdAt: now, updatedAt: now },
      { eventType: 'Complaint',         sesMessageId: ${msg("complaint")}, eventAt: now, recipients: [], detail: { complaintFeedbackType: 'abuse' }, createdAt: now, updatedAt: now },
      { eventType: 'Rendering Failure', sesMessageId: ${msg("render")},    eventAt: now, recipients: [], detail: { errorMessage: 'Attribute client_name is not present.' }, createdAt: now, updatedAt: now },
    ]);

    // As deliveryEvents.js leaves them once applyDeliveryEvent has run — this
    // is what the CLIENT panel reads.
    db.pdflinks.insertMany([
      { workspaceId: ws, itemId: marker, type: 'NDIS Invoice', invoiceNumber: ${inv("ok")},     participant: 'Mike Bird',  pdfLink: 'https://files.test/e2e-ok.pdf',     periodKey: period, deliveryState: 'delivered', deliveryMessageId: ${msg("delivered")}, createdAt: now, updatedAt: now },
      { workspaceId: ws, itemId: marker, type: 'NDIS Invoice', invoiceNumber: ${inv("bounce")}, participant: 'Jane Smith', pdfLink: 'https://files.test/e2e-bounce.pdf', periodKey: period, deliveryState: 'bounced',   deliveryMessageId: ${msg("bounced")}, deliveryDetail: "Email address doesn't exist.", createdAt: now, updatedAt: now },
    ]);
  `);
}

/** Remove everything this suite's seed wrote, and nothing else. */
export function clearDeliveryFailures(suite: Suite): void {
  mongoEval(`
    const marker = ${JSON.stringify(runMarker(suite))};
    const idPrefix = new RegExp(${JSON.stringify(`^${messageId(suite, "")}`)});
    db.automationruns.deleteMany({ jobId: marker });
    db.emailsends.deleteMany({ messageId: idPrefix });
    db.emailevents.deleteMany({ sesMessageId: idPrefix });
    db.pdflinks.deleteMany({ itemId: marker });
  `);
}
