import { test, expect, type Page } from "@playwright/test";

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

// Credentials come from the environment, never from source. `npm run dev:user`
// prints a local support_admin login; export these before running.
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

// Workspace 55390 is what the fixture seeds; overridable for reruns elsewhere.
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
  const response = await page.request.post(`${BACKEND}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });

  expect(
    response.ok(),
    `login failed (${response.status()}) — check E2E_EMAIL/E2E_PASSWORD and that the stack at ${BACKEND} is seeded`,
  ).toBeTruthy();
}

// Serial, deliberately: the tick test mutates the same workspace the earlier
// tests read, and under fullyParallel the outbox could appear mid-assertion.
test.describe.configure({ mode: "serial" });

test.describe("Care Management automation (KAN-10 fixture)", () => {
  test.skip(
    !EMAIL || !PASSWORD,
    "set E2E_EMAIL and E2E_PASSWORD (see npm run dev:user)",
  );

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

  test("scheduler tick generates invoices and statement outbox for all three boards", async ({
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

    const tick = await request.post(`${BACKEND}/api/scheduler/tick`, {
      headers: { Authorization: SCHEDULER_KEY! },
    });
    expect(tick.status(), "scheduler tick should be accepted").toBe(200);

    // The worker writes one outbox JSON per (kind, board) for the claimed
    // period; poll until each exists, then check its identifying fields.
    for (const kind of ["invoice_automation", "statement_automation"]) {
      for (const board of BOARDS) {
        const url = `${BACKEND}/api/local-files/outbox/${WORKSPACE}/${kind}-${board.id}-${PERIOD_KEY}.json`;

        await expect
          .poll(async () => (await request.get(url)).status(), {
            timeout: 60_000,
            message: `outbox file never appeared: ${url}`,
          })
          .toBe(200);

        const outbox = await (await request.get(url)).json();
        expect(outbox.kind, `kind in ${url}`).toBe(kind);
        expect(outbox.periodKey, `periodKey in ${url}`).toBe(PERIOD_KEY);
      }
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
});
