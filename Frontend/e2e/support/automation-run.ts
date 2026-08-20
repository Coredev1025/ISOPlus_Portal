import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Reset everything a previous automation run left behind, so the pipeline
 * specs are re-runnable rather than passing exactly once.
 *
 * Three separate mechanisms in KAN-10 each make a second run a no-op, and all
 * three are *correct* production behaviour — which is precisely why a test that
 * does not reset them fails with a message pointing nowhere near the cause
 * ("outbox file never appeared"):
 *
 *   1. BullMQ dedupes on jobId `inv:<boardId>:<periodKey>`. The fixture always
 *      replays the same slot, so the second tick's fan-out is dropped.
 *   2. `status: 'pending'` on the NDIS generator means "no invoice number yet",
 *      so rows invoiced by the first run are excluded from every later one.
 *   3. `existingSlotResults` reuses the PDFLink rows recorded for the slot.
 *
 * Clearing these is a local-stack operation, not an API one: there is
 * deliberately no endpoint that deletes invoice numbers, and adding one to a
 * repo that auto-deploys would be a far worse trade than a test helper that
 * shells into the dev containers.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");

/** Mongo and Redis run in the shared `isoplus-infra` project under fixed names. */
function mongoEval(script: string): void {
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "isoplus-mongo",
      "mongosh",
      "business-dashboard",
      "--quiet",
      "--eval",
      script,
    ],
    { stdio: "pipe" },
  );
}

/**
 * The backend service deliberately sets no `container_name` — that is what lets
 * two worktrees run at once — so it is addressed through compose, never by a
 * guessed name.
 */
function backendExec(shellScript: string): void {
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "backend", "sh", "-lc", shellScript],
    { cwd: repoRoot, stdio: "pipe" },
  );
}

function loadFixture(fixture: string): void {
  execFileSync("node", ["scripts/dev.mjs", "fixture", "--file", fixture], {
    cwd: repoRoot,
    stdio: "pipe",
  });
}

export interface ResetOptions {
  workspaceId: string;
  /** Fixture reloaded afterwards, which is what restores a due `nextRunAt`. */
  fixture?: string;
}

/**
 * Put the workspace back to "never run": no minted invoice numbers, no PDFLink
 * slot results, no queued or completed jobs, no generated files, and a schedule
 * that is due again.
 *
 * Throws rather than warning. A silent reset failure would surface as a
 * confusing assertion failure later, which is the exact experience this exists
 * to remove.
 */
export function resetAutomationRun({
  workspaceId,
  fixture = "test/fixtures/care-management-automation.json",
}: ResetOptions): void {
  // Run artifacts only. The fixture seeds no invoiceNumbers of its own, so
  // everything here was written by a previous tick.
  mongoEval(
    `db.invoicenumbers.deleteMany({workspaceId:${JSON.stringify(workspaceId)}});` +
      `db.pdflinks.deleteMany({workspaceId:${JSON.stringify(workspaceId)}});` +
      `db.emailsends.deleteMany({workspaceId:${JSON.stringify(workspaceId)}});`,
  );

  // Completed jobs keep their key, and that key IS the dedupe.
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "isoplus-redis",
      "sh",
      "-lc",
      "redis-cli --scan --pattern 'bull:automation:*' | xargs -r redis-cli del",
    ],
    { stdio: "pipe" },
  );

  // Generated PDFs and composed emails, so "the file appeared" means this run
  // produced it rather than a previous one having left it there.
  backendExec(`rm -rf /app/.local-s3/outbox/${workspaceId} /app/.local-s3/output/${workspaceId}`);

  // Last: restores nextRunAt to the fixture's due slot.
  loadFixture(fixture);
}
