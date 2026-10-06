import { execFileSync } from "node:child_process";

/**
 * A history deep enough to page through.
 *
 * The status panel shows five documents, expands to the first page of fifty,
 * and offers Load more beyond that. Proving the third step needs more than
 * fifty documents in one workspace, and no fixture has that: the Care
 * Management fixture is three boards and a handful of participants, which is
 * one run's worth. Generating them for real would mean fifty PDF renders.
 *
 * So the rows are written directly, in the shape the automation generators
 * leave behind — `periodKey` set, which is what marks a row as automation
 * output rather than a UI generator's, and one distinct `pdfLink` each, which
 * is what the panel's aggregation groups by. Nothing else about them is read
 * by the list.
 *
 * They carry their own marker so a parallel spec file's cleanup cannot delete
 * rows this one is still asserting on. `playwright.config.ts` sets
 * `fullyParallel: true`; that is not hypothetical.
 */

/** Same reasoning as delivery-failures.ts: an isolated worktree has its own database. */
const DB = process.env.E2E_MONGO_DB ?? "business-dashboard";

/** The periodKey every seeded row carries, and the handle cleanup deletes by. */
export const HISTORY_PERIOD_KEY = "e2e-history-0000";

function mongoEval(script: string): void {
  execFileSync("docker", ["exec", "-i", "isoplus-mongo", "mongosh", DB, "--quiet", "--eval", script], {
    stdio: "pipe",
  });
}

/**
 * `count` automation documents for `workspaceId`, newest first, one minute
 * apart so their order is unambiguous.
 *
 * Deliberately more than one page: the caller passes 55 to get a full first
 * page of fifty and five behind it, so Load more has something to fetch and
 * the count after it is a number the test can state exactly.
 */
export function seedDocumentHistory(workspaceId: string, count: number): void {
  mongoEval(`
    const rows = [];
    for (let i = 0; i < ${count}; i++) {
      rows.push({
        workspaceId: "${workspaceId}",
        boardId: "e2e-history-board",
        itemId: "e2e-history-" + i,
        participant: "History Test",
        type: "NDIS Invoice",
        invoiceNumber: "INV-HIST-" + String(i).padStart(3, "0"),
        periodKey: "${HISTORY_PERIOD_KEY}",
        pdfLink: "https://example.test/e2e-history-" + i + ".pdf",
        createdAt: new Date(Date.now() - i * 60000),
        createdBy: "",
        isDeleted: false,
        SignatureStatus: "Unsigned",
      });
    }
    db.pdflinks.insertMany(rows);
  `);
}

export function clearDocumentHistory(): void {
  mongoEval(`db.pdflinks.deleteMany({ periodKey: "${HISTORY_PERIOD_KEY}" });`);
}
