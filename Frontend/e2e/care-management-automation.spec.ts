import { test, expect, type Page } from "@playwright/test";

import { resetAutomationRun } from "./support/automation-run";
import { signInSupportAdmin } from "./helpers/support-auth";

/**
 * KAN-10 — Care Management automation, end to end against the seeded fixture.
 *
 * Everything asserted here comes from
 * Backend/test/fixtures/care-management-automation.json (loaded idempotently
 * via `npm run dev:fixture -- --file test/fixtures/care-management-automation.json`,
 * or automatically by e2e/global-setup.ts when E2E_LOAD_FIXTURES is set):
 * workspace 55390 with three Care Management boards, the
 * invoiceStatementAutomation feature toggle on, and two already-due
 * ScheduledJob rows whose period is January 2025.
 */

// Board ids and labels as seeded by the fixture. Two boards deliberately share
// a label, so assertions on label text use first() while ids stay unique.
const BOARDS = [
  { id: "jpjztrn14pJ", label: "Care Management - SaH" },
  { id: "o24sGM1FoST", label: "Care Management - NDIS - Certification" },
  { id: "dwV23F5WcQL", label: "Care Management - NDIS - Certification" },
] as const;

// nextRunAt in the fixture is 2025-02-01T09:00 Sydney; the worker keys every
// outbox file for that run with this stamp.
const PERIOD_KEY = "20250201-0900";

// The board whose invoice rows are checked for a written-back invoiceNumber.
const NDIS_BOARD_ID = "o24sGM1FoST";

// The Age Care (SaH) board — the one generator branch that completes end to end.
const AGE_CARE_BOARD = BOARDS[0];

// The participants the fixture puts on each board, under
// 'Full Name/Preferred Name'. They matter to the URLs below because the worker
// composes ONE MESSAGE PER PARTICIPANT for every recipient type — including
// 'billing_contact', which is what this fixture's blocks are set to. A single
// message for the whole board could not resolve an address (there is no
// board-level billing contact to read one from) and would have carried every
// participant's documents to whoever it did resolve.
const BOARD_PARTICIPANTS: Record<string, readonly string[]> = {
  jpjztrn14pJ: ["David Brown", "Jane Smith", "Lisa Morphy"],
  o24sGM1FoST: ["David Smith", "Martin Space"],
  dwV23F5WcQL: ["Mike Bird"],
};

/**
 * The outbox key the worker writes for one composed message. Mirrors
 * `outboxKeyFor` / `recipientSlug` in Backend/src/services/email/backends.js:
 * anything not a letter or digit becomes a dash, trimmed at both ends.
 */
function outboxUrl(kind: string, boardId: string, participant: string) {
  const slug = participant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${BACKEND}/api/local-files/outbox/${WORKSPACE}/${kind}-${boardId}-${PERIOD_KEY}-${slug}.json`;
}

// The two NDIS boards, which mint invoice numbers but produce no PDF or email.
const NDIS_BOARDS = [BOARDS[1], BOARDS[2]];

// Local support_admin sessions use a one-time Google-support OAuth ticket.
const WORKSPACE = process.env.E2E_CM_WORKSPACE_ID ?? "55390";

// The automation tab is a query param on the finance-settings page, not a route
// of its own. Both the tab test and the status-panel test land here.
const AUTOMATION_URL = `/workspace/${WORKSPACE}/finance-settings?tab=automation`;

// Login and the outbox are backend calls; ports differ per worktree, so read
// the URL rather than assuming 4001.
const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  "http://localhost:4001";

// Optional: without it the scheduler-tick journey skips rather than failing.
const SCHEDULER_KEY = process.env.E2E_SCHEDULER_API_KEY;

/**
 * Authenticate through the API rather than the login form. page.request shares
 * the browser context's cookie jar, so the session cookie it sets is the one
 * the page will send.
 */
async function signIn(page: Page) {
  await signInSupportAdmin(page);
}

// Serial, deliberately: the tick test mutates the same workspace the earlier
// tests read, and under fullyParallel the outbox could appear mid-assertion.
test.describe.configure({ mode: "serial" });

test.describe("Care Management automation (KAN-10 fixture)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("workspace 55390 lists the three Care Management boards", async ({
    page,
  }) => {
    // The workspace page reads the workspace list from context, which only the
    // dashboard populates (app/context/index.tsx hydrates from localStorage).
    // Deep-linking straight to /workspace/:id leaves it undefined and the
    // boards fetch never fires, so take the real user journey: dashboard first.
    await page.goto("/dashboard");
    await expect(page.getByRole("cell", { name: WORKSPACE })).toBeVisible();
    await page.goto(`/workspace/${WORKSPACE}`);

    // Ids are unique table cells; labels are asserted via first() because two
    // fixture boards share one.
    for (const board of BOARDS) {
      await expect(page.getByRole("cell", { name: board.id })).toBeVisible();
      await expect(page.getByText(board.label).first()).toBeVisible();
    }
  });

  test("automation tab is available when the feature toggle is on", async ({
    page,
  }) => {
    await page.goto(AUTOMATION_URL);

    // The tab only renders when the fixture's feature toggle is on; if this
    // fails, the fixture was not loaded rather than the tab regressing.
    await expect(
      page.getByRole("tab", { name: /invoice & statement automation/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: /invoice automation/i }),
    ).toBeVisible();
  });

  test("scheduler tick generates invoices and a statement outbox for the Age Care board", async ({
    page,
    request,
  }) => {
    test.skip(
      !SCHEDULER_KEY,
      "set E2E_SCHEDULER_API_KEY to run the scheduler-tick journey",
    );

    // One tick claims both due jobs and fans out one BullMQ job per board;
    // six outbox files each polled up to 60s needs headroom beyond slow().
    test.setTimeout(240_000);

    // Without this the test passes exactly once per database: jobId dedupe,
    // minted invoice numbers and recorded slot results all make the second run
    // a no-op. See e2e/support/automation-run.ts.
    resetAutomationRun({ workspaceId: WORKSPACE });

    const tick = await request.post(`${BACKEND}/api/scheduler/tick`, {
      headers: { Authorization: SCHEDULER_KEY! },
    });
    expect(tick.status(), "scheduler tick should be accepted").toBe(200);

    // The worker writes one outbox JSON per (kind, board, PARTICIPANT) for the
    // claimed period. Statements are generated for every participant on the
    // board, so all three must appear; invoices only for participants with
    // billable rows this period, so at least one must.
    //
    // Scoped to the Age Care board deliberately. The two NDIS boards produce
    // nothing on this path today — see the `test.fail()` case below, which
    // holds the defect rather than letting it hide inside this loop.
    const participants = BOARD_PARTICIPANTS[AGE_CARE_BOARD.id];

    for (const participant of participants) {
      const url = outboxUrl("statement_automation", AGE_CARE_BOARD.id, participant);

      await expect
        .poll(async () => (await request.get(url)).status(), {
          timeout: 60_000,
          message: `statement outbox file never appeared: ${url}`,
        })
        .toBe(200);

      const outbox = await (await request.get(url)).json();
      expect(outbox.kind, `kind in ${url}`).toBe("statement_automation");
      expect(outbox.periodKey, `periodKey in ${url}`).toBe(PERIOD_KEY);
      // One participant's documents, not the whole board's. The message that
      // carried every participant's statements to one address is the shape this
      // per-participant grouping replaced.
      expect(outbox.attachments, `attachments in ${url}`).toHaveLength(1);
    }

    const invoiceUrls = participants.map((participant) =>
      outboxUrl("invoice_automation", AGE_CARE_BOARD.id, participant),
    );

    await expect
      .poll(
        async () => {
          const statuses = await Promise.all(
            invoiceUrls.map(async (url) => (await request.get(url)).status()),
          );
          return statuses.filter((status) => status === 200).length;
        },
        {
          timeout: 60_000,
          message: `no per-participant invoice outbox file appeared: ${invoiceUrls.join(", ")}`,
        },
      )
      .toBeGreaterThan(0);

    for (const url of invoiceUrls) {
      const response = await request.get(url);
      if (response.status() !== 200) continue;
      const outbox = await response.json();
      expect(outbox.kind, `kind in ${url}`).toBe("invoice_automation");
      expect(outbox.periodKey, `periodKey in ${url}`).toBe(PERIOD_KEY);
    }

    // The run must also have written invoice numbers back to the board rows —
    // read them through the authenticated session, like the UI does.
    const listed = await page.request.get(
      // limit must cover every fixture's rows on this board: the full replica
      // and statement-permutation fixtures may be loaded alongside the lean one.
      `${BACKEND}/api/items/${WORKSPACE}/${NDIS_BOARD_ID}/invoice-generator?page=1&limit=500`,
    );
    expect(listed.ok(), `invoice-generator list failed (${listed.status()})`).toBeTruthy();

    const body = await listed.json();
    const rows: Array<{ invoiceNumber?: string }> = body.items ?? [];
    expect(rows.length, "fixture board should have invoice rows").toBeGreaterThan(0);
    expect(
      rows.some((row) => typeof row.invoiceNumber === "string" && row.invoiceNumber.length > 0),
      "at least one row should carry a generated invoiceNumber",
    ).toBeTruthy();
  });

  /**
   * Was a KNOWN DEFECT, marked `fail`: both NDIS boards minted an invoice
   * number and wrote PDFLink rows for a PDF that was never rendered, then
   * composed no email and logged nothing. A group that collected zero rows
   * returned `{ empty: true }` and `generateNdisGeneratorInvoices` skipped it
   * with a bare `continue`.
   *
   * Fixed by wiring section 2's selection conditions in front of generation
   * (utils/automationItemSelection.js): items that cannot be billed are removed
   * before participants are grouped, so a group that would collect zero rows is
   * no longer formed and the boards produce their invoices and their email.
   *
   * Residual, narrower than what this test watches: `ndisInvoiceGeneratorPdf.js`
   * still calls `allocateInvoiceNumberBase()` before `collectNdisInvoiceRows()`,
   * so any group that still manages to collect zero rows burns a number. That
   * is a gap in the sequence, not a missing email.
   */
  test("NDIS boards generate invoices and an email, like the Age Care board", async ({
    request,
  }) => {
    test.skip(
      !SCHEDULER_KEY,
      "set E2E_SCHEDULER_API_KEY to run the scheduler-tick journey",
    );
    test.setTimeout(120_000);

    // Runs after the tick test in this serial file, so the run has happened.
    for (const board of NDIS_BOARDS) {
      const statuses = await Promise.all(
        BOARD_PARTICIPANTS[board.id].map(async (participant) =>
          (await request.get(outboxUrl("invoice_automation", board.id, participant))).status(),
        ),
      );
      expect(
        statuses.filter((status) => status === 200).length,
        `no invoice email was composed for NDIS board ${board.id}`,
      ).toBeGreaterThan(0);
    }
  });

  test("the status panel reports what the run produced, with a delivery state", async ({
    page,
  }) => {
    // The spec's Visibility section: a client checks whether automation is
    // healthy without contacting support. This asserts the panel against a
    // workspace whose documents were produced by a real tick, so the list and
    // its states come from PDFLink rows rather than a fixture of the view.
    await page.goto("/dashboard");
    await page.goto(AUTOMATION_URL);

    const status = page.getByRole("region", { name: /automation status/i });
    await expect(status).toBeVisible();

    // Recent documents only render once a run has produced some. The tick test
    // above is the one that produces them, and the suite runs serially.
    const documents = status.getByRole("link");
    await expect(documents.first()).toBeVisible();

    // Every listed document carries a delivery state. Offline runs never send,
    // so the honest state here is "Generated" — the point of the assertion is
    // that a state is rendered per document at all, which is what replaced the
    // hardcoded badge. Delivered / Bounced / Failed rendering, and the inline
    // bounce reason, are covered by the panel unit tests: reaching them here
    // would mean forging an SNS notification, and the endpoint verifies
    // signatures precisely so that cannot be done.
    await expect(status.getByText(/generated/i).first()).toBeVisible();
  });

  test("the recent-document list starts at five and expands to the rest", async ({
    page,
  }) => {
    // The list is a health signal first, and a run over this fixture produces
    // more documents than fit above the fold. Five rows answer "did last
    // night's run work"; the history behind them is one click away rather
    // than capped at what the panel happened to render.
    await page.goto("/dashboard");
    await page.goto(AUTOMATION_URL);

    const status = page.getByRole("region", { name: /automation status/i });
    const rows = status.getByRole("listitem");
    await expect(rows.first()).toBeVisible();
    await expect(rows).toHaveCount(5);

    const expander = status.getByRole("button", { name: /show \d+ more/i });
    await expect(expander).toBeVisible();
    await expander.click();

    // More than five now, and the button offers the way back.
    expect(await rows.count()).toBeGreaterThan(5);
    await status.getByRole("button", { name: /show fewer/i }).click();
    await expect(rows).toHaveCount(5);
  });
});
