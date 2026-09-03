import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { signInSupportAdmin } from "./helpers/support-auth";
import {
  clearDeliveryFailures,
  invoiceNumber,
  seedDeliveryFailures,
} from "./support/delivery-failures";

/**
 * Epic 5 — the Invoice & Statement Automation tab, end to end.
 *
 * Records video for every test in this file, not just failures: this journey
 * is the demonstrable proof that configuration survives a round trip, and the
 * recording is an artefact people ask for by name.
 */
test.use({ video: "on" });

// Local support_admin sessions use a one-time Google-support OAuth ticket
// (see Frontend/e2e/helpers/support-auth.ts). Requires local Mongo.

// The workspace must have invoiceStatementAutomation enabled, or the tab is
// hidden by design and every assertion here is meaningless.
//
// Keep this OFF the Care Management fixture's workspace (55390). That spec
// resets run state and reloads its fixture mid-run, so sharing a workspace
// makes both files fail under the config's fullyParallel for reasons that look
// nothing like the real cause.
const WORKSPACE = process.env.E2E_WORKSPACE_ID ?? "55369";

// A workspace whose flag is OFF, for the two tests that prove the gate. Create
// one locally — it needs no boards or items, only the toggle:
//
//   docker exec -i isoplus-mongo mongosh "$E2E_MONGO_DB" --quiet --eval '
//     db.businesses.updateOne({workspaceId:"55999"},
//       {$set:{workspaceId:"55999",name:"Flag-off fixture (e2e)",
//              "featureToggles.invoiceStatementAutomation":false}},
//       {upsert:true})'
const WORKSPACE_NO_FLAG = process.env.E2E_WORKSPACE_ID_NO_FLAG;

// Which database the Mongo escape hatches below write to.
//
// Not hardcoded, for the reason e2e/support/delivery-failures.ts spells out:
// `npm run worktree -- new --isolated-db` gives a worktree its own database
// named after the branch, so seeding `business-dashboard` from there writes to
// a database the app under test is not reading. The seed succeeds and the
// assertion then fails for a reason that looks nothing like the cause.
const MONGO_DB = process.env.E2E_MONGO_DB ?? "business-dashboard";

// Login is a backend call; the frontend proxies nothing. Ports differ per
// worktree, so read it rather than assuming 4001.
const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  "http://localhost:4001";

const AUTOMATION_URL = `/workspace/${WORKSPACE}/finance-settings?tab=automation`;

/**
 * Authenticate as support_admin through the Google-support ticket exchange.
 */
async function signIn(page: Page) {
  await signInSupportAdmin(page);
}

/** The invoice block. Both blocks render identical fields, so scope every query. */
function invoiceBlock(page: Page) {
  return page.getByRole("region", { name: /invoice automation/i });
}

/** The statement block, which is configured entirely independently. */
function statementBlock(page: Page) {
  return page.getByRole("region", { name: /statement automation/i });
}

/**
 * Return the workspace to defaults before each test.
 *
 * Without this the suite is order-dependent and not re-runnable: the first
 * test clicks the enable switch, so a second run would toggle it back off and
 * fail on assertions that look nothing like the real cause. An empty body is
 * enough — the backend applies defaults to any block it is not given.
 */
async function resetAutomationSettings(page: Page) {
  const response = await page.request.put(
    `${BACKEND}/api/workspaces/${WORKSPACE}/automation-settings`,
    { data: {} },
  );

  expect(
    response.ok(),
    `could not reset automation settings (${response.status()})`,
  ).toBeTruthy();
}

/**
 * Seed one automation document straight into Mongo, in the state a refused send
 * now leaves behind.
 *
 * There is deliberately no API that writes a PDFLink row, and provoking a real
 * refusal end to end would need a participant with no address and a live mail
 * transport. The panel's job is to *report* the row, so the row is the fixture.
 * Same local-stack escape hatch e2e/support/automation-run.ts already uses.
 */
function seedFailedDocument(): void {
  const doc = {
    workspaceId: WORKSPACE,
    itemId: "e2e-delivery-report",
    type: "NDIS Invoice",
    invoiceNumber: "INV-E2E-1",
    participant: "Samuel Rivers",
    pdfLink: "https://files.test/e2e-delivery-report.pdf",
    periodKey: "20260401-0900",
    deliveryState: "failed",
    deliveryDetail: "The client's profile has no email address on it.",
  };
  // `createdAt` is appended as a real `new Date(...)` rather than folded into
  // the JSON: mongosh does not convert Extended JSON's `{$date}` on insert, and
  // a plain object there reaches the panel as an unparseable timestamp.
  execFileSync(
    "docker",
    ["exec", "-i", "isoplus-mongo", "mongosh", MONGO_DB, "--quiet", "--eval",
      `db.pdflinks.deleteMany({itemId:"e2e-delivery-report"}); `
      + `db.pdflinks.insertOne(Object.assign(${JSON.stringify(doc)}, `
      + `{createdAt: new Date("2026-04-01T09:00:00Z")}));`],
    { stdio: "pipe" },
  );
}

function removeSeededDocument(): void {
  execFileSync(
    "docker",
    ["exec", "-i", "isoplus-mongo", "mongosh", MONGO_DB, "--quiet", "--eval",
      'db.pdflinks.deleteMany({itemId:"e2e-delivery-report"});'],
    { stdio: "pipe" },
  );
}

// Serial, deliberately. Every test in this file drives the SAME workspace and
// resets it to defaults in beforeEach — under the config's fullyParallel these
// reset one another's state mid-test and fail for reasons that look nothing
// like the real cause. Giving each test its own workspace would be the
// alternative, but a workspace cannot be created locally: the list is proxied
// from ISO+ rather than stored.
test.describe.configure({ mode: "serial" });

/** These rows belong to this file; see e2e/support/delivery-failures.ts. */
const SUITE = "client-panel" as const;

test.describe("Invoice & Statement Automation", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await resetAutomationSettings(page);
  });

  test("configures a fortnightly schedule and it survives a reload", async ({
    page,
  }) => {
    await page.goto(AUTOMATION_URL);

    // The tab only exists when the workspace feature flag is on. If this fails,
    // the flag is off — not a regression in Epic 5.
    await expect(
      page.getByRole("tab", { name: /invoice & statement automation/i }),
    ).toBeVisible();

    const invoice = invoiceBlock(page);
    await expect(invoice).toBeVisible();

    await invoice.getByRole("switch").click();
    await invoice.getByLabel(/generate invoices every/i).fill("2");
    await page.getByLabel(/generate every unit/i).first().click();
    await page.getByRole("option", { name: /week/i }).click();

    // Changing the unit must reset Run On in the same update. A day-number
    // surviving into a weekly schedule is rejected by the backend, so this
    // assertion is load-bearing rather than cosmetic.
    await expect(invoice.getByLabel(/run on/i)).toContainText(/monday/i);

    await invoice.getByLabel(/start date/i).fill("2026-03-02");
    await invoice.getByLabel(/send a copy to/i).fill("billing@example.com");

    // Email Message is a rich text editor; bold typed here must survive the
    // save/reload round trip as markup, not as escaped text.
    await invoice.getByLabel(/email message/i).click();
    await invoice.getByRole("button", { name: /^bold$/i }).click();
    await page.keyboard.type("Please find attached");

    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByText(/saved successfully/i)).toBeVisible();

    // The round trip is the point. The server returns startDate as a full ISO
    // string; without normalisation the date input renders blank here.
    await page.reload();

    const reloaded = invoiceBlock(page);
    await expect(reloaded.getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(reloaded.getByLabel(/generate invoices every/i)).toHaveValue("2");
    await expect(reloaded.getByLabel(/run on/i)).toContainText(/monday/i);
    await expect(reloaded.getByLabel(/start date/i)).toHaveValue("2026-03-02");
    await expect(reloaded.getByLabel(/send a copy to/i)).toHaveValue(
      "billing@example.com",
    );
    await expect(
      reloaded.getByLabel(/email message/i).locator("strong"),
    ).toHaveText("Please find attached");
  });

  test("flags a malformed email inline and holds Save until it is fixed", async ({
    page,
  }) => {
    await page.goto(AUTOMATION_URL);

    const invoice = invoiceBlock(page);
    // Fields only render while generation is enabled (beforeEach resets it off).
    await invoice.getByRole("switch").click();
    await invoice.getByLabel(/send a copy to/i).fill("not-an-email");

    await expect(invoice.getByText(/valid email address/i)).toBeVisible();
    // The API rejects the whole PUT with one message that does not name the
    // offending field, so the form refuses first.
    await expect(page.getByRole("button", { name: /save changes/i })).toBeDisabled();

    await invoice.getByLabel(/send a copy to/i).fill("billing@example.com");

    await expect(page.getByRole("button", { name: /save changes/i })).toBeEnabled();
  });

  test("the editor toolbar is operable by keyboard, not only by mouse", async ({
    page,
  }) => {
    // A focused button activated by Enter dispatches click and never
    // mousedown; a toolbar wired to mousedown alone is tabbable and inert,
    // which reads as broken rather than as unavailable.
    await page.goto(AUTOMATION_URL);

    const invoice = invoiceBlock(page);
    await invoice.getByRole("switch").click();

    await invoice.getByLabel(/email message/i).click();
    await invoice.getByRole("button", { name: /bullet list/i }).press("Enter");

    await expect(
      invoice.getByLabel(/email message/i).locator("ul"),
    ).toHaveCount(1);
  });

  test("Next Run is read-only — the scheduler owns it", async ({ page }) => {
    await page.goto(AUTOMATION_URL);

    // Fields only render while generation is enabled (beforeEach resets it off).
    await invoiceBlock(page).getByRole("switch").click();
    const nextRun = invoiceBlock(page).getByLabel(/next run/i);
    await expect(nextRun).toBeVisible();
    await expect(nextRun).toHaveAttribute("readonly", "");
  });

  test("the tab is absent when the workspace flag is off", async ({ page }) => {
    test.skip(!WORKSPACE_NO_FLAG, "set E2E_WORKSPACE_ID_NO_FLAG — see the constant");

    await page.goto(`/workspace/${WORKSPACE_NO_FLAG}/finance-settings?tab=automation`);

    await expect(
      page.getByRole("tab", { name: /invoice & statement automation/i }),
    ).toHaveCount(0);
  });

  test("the two blocks are independent — enabling Statement leaves Invoice off", async ({
    page,
  }) => {
    // One shared Save writes both blocks, so the risk is a save that arms the
    // schedule the client did not ask for. Epic 5 bills real money off these
    // rows: an Invoice schedule switched on by accident invoices customers.
    await page.goto(AUTOMATION_URL);

    const statement = statementBlock(page);
    await statement.getByRole("switch").click();
    await statement.getByLabel(/reply-to email/i).fill("statements@example.com");

    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByText(/saved successfully/i)).toBeVisible();

    await page.reload();

    await expect(statementBlock(page).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(invoiceBlock(page).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // The disabled block collapses to its switch, so its fields must be gone
    // rather than merely hidden behind a style.
    await expect(invoiceBlock(page).getByLabel(/reply-to email/i)).toHaveCount(0);
  });

  test("Recipient and Send Method survive a save and reload", async ({ page }) => {
    // Send Method is not cosmetic: 'accounting' routes the run's invoices to
    // Xero as DRAFTs instead of emailing them, so a value that fails to persist
    // silently changes where a client's invoices go.
    await page.goto(AUTOMATION_URL);

    const invoice = invoiceBlock(page);
    await invoice.getByRole("switch").click();

    await invoice.getByLabel("Recipient").click();
    await page.getByRole("option", { name: /participant/i }).click();
    await invoice.getByLabel("Send Method").click();
    await page.getByRole("option", { name: /accounting|xero/i }).click();

    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByText(/saved successfully/i)).toBeVisible();

    await page.reload();

    const reloaded = invoiceBlock(page);
    await expect(reloaded.getByLabel("Recipient")).toContainText(/participant/i);
    await expect(reloaded.getByLabel("Send Method")).toContainText(/accounting|xero/i);
  });

  test("Restore Defaults clears the form without saving over the server", async ({
    page,
  }) => {
    await page.goto(AUTOMATION_URL);

    const invoice = invoiceBlock(page);
    await invoice.getByRole("switch").click();
    await invoice.getByLabel(/send a copy to/i).fill("someone@example.com");

    await page.getByRole("button", { name: /restore defaults/i }).click();

    // Defaults mean both blocks off, so the invoice fields unmount with them.
    await expect(invoice.getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(invoice.getByLabel(/send a copy to/i)).toHaveCount(0);

    // Restore is a form action, not a save: a reload must show the server's
    // state, which still has nothing stored for this workspace either way.
    await page.reload();
    await expect(invoiceBlock(page)).toBeVisible();
  });

  test("a failed settings load offers no Save button to lose data with", async ({
    page,
  }) => {
    // The review-round data-loss fix. The panel's defaults say "both
    // automations off, no email settings", so a Save over a load that failed
    // would disable both live schedules and erase their email configuration —
    // from a form that never showed what it was replacing.
    await page.route("**/api/workspaces/*/automation-settings", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 500, body: "{}" })
        : route.continue(),
    );

    await page.goto(AUTOMATION_URL);

    await expect(page.getByText(/could not load automation settings/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /save changes/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /restore defaults/i })).toHaveCount(0);
  });

  test("no Save button is offered while the settings load is still in flight", async ({
    page,
  }) => {
    // Same defect, earlier moment: Save was live before the GET resolved.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    await page.route("**/api/workspaces/*/automation-settings", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await held;
      return route.continue();
    });

    await page.goto(AUTOMATION_URL);

    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.getByRole("button", { name: /save changes/i })).toHaveCount(0);

    release?.();
    await expect(page.getByRole("button", { name: /save changes/i })).toBeVisible();
  });

  test("the API refuses a write for a workspace whose feature flag is off", async ({
    page,
  }) => {
    // Server-side gate added in the review round: the tab being hidden is not
    // access control, because the PUT is reachable without the UI.
    test.skip(!WORKSPACE_NO_FLAG, "set E2E_WORKSPACE_ID_NO_FLAG — see the constant");

    const response = await page.request.put(
      `${BACKEND}/api/workspaces/${WORKSPACE_NO_FLAG}/automation-settings`,
      { data: { invoice: { enabled: true } } },
    );

    expect(response.status()).toBe(403);
  });

  test("Invoice Generator for the KAN-10 board is reachable after sign-in", async ({
    page,
  }) => {
    const board = process.env.E2E_BOARD_ID ?? "eNiJpH14PN3";
    await page.goto(`/workspace/${WORKSPACE}/board/${board}/invoice-generator`);
    await expect(page).toHaveURL(new RegExp(`/workspace/${WORKSPACE}/board/${board}/invoice-generator`));
    await expect(page.getByText(/invoice generator/i).first()).toBeVisible();
  });

  test("the status panel reports the saved schedule, not unsaved edits", async ({
    page,
  }) => {
    // A full save-and-reload round trip against the dev server. The file's
    // 30s default is tight for that on a loaded machine — this triples it
    // rather than relaxing any assertion.
    test.slow();

    // The panel answers "is your automation healthy?" — a fact about the
    // scheduler. It was fed the working draft, so switching a block off
    // reported "Paused" while the schedule was still armed server-side.
    await page.goto(AUTOMATION_URL);

    const invoice = invoiceBlock(page);
    await invoice.getByRole("switch").click();
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByText(/saved successfully/i)).toBeVisible();

    // Asserted as "On track immediately after Invoices" rather than by locating
    // the row: every candidate div ancestor also contains the Statements row,
    // so a containment check there would pass on the wrong badge.
    const status = page.getByRole("region", { name: /automation status/i });
    await expect(status).toContainText(/Invoices\s*On track/);

    // Turn the form off but do NOT save. Nothing has changed on the server.
    await invoice.getByRole("switch").click();
    await expect(invoice.getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(status).toContainText(/Invoices\s*On track/);

    // Restore Defaults writes nothing either, so it cannot retire the badge.
    await page.getByRole("button", { name: /restore defaults/i }).click();
    await expect(status).toContainText(/Invoices\s*On track/);
  });

  test("the automation tab survives a failed business-profile load", async ({
    page,
  }) => {
    test.slow();

    // The feature flag rides on the profile response, and every failure used
    // to collapse to "flag off" — so a transient 503 hid the tab and rewrote
    // ?tab=automation to ?tab=financial with nothing said.
    await page.route("**/api/business/profile*", (route) =>
      route.fulfill({ status: 503, body: "{}" }),
    );

    await page.goto(AUTOMATION_URL);

    await expect(
      page.getByRole("tab", { name: /invoice & statement automation/i }),
    ).toBeVisible();
    await expect(page).toHaveURL(/tab=automation/);
  });
  /**
   * The reproduction for the defect this closes.
   *
   * A send the backend refused wrote nothing to its documents, so they stayed
   * at `generated` — muted, and rendered "never as an error". On portal-dev ten
   * statements were produced and none delivered, with nothing on the page
   * saying so. Epic 5 wants the delivery problem flagged against the send in
   * plain English, naming the client it was raised for.
   *
   * What this asserts is the document row. The block badge is out of scope and
   * still reads "On track ... Succeeded" after an all-refused run: it reports
   * the job, which did succeed in generating the documents. Whether a delivery
   * failure should also mark the schedule needs a product ruling.
   */
  test("a refused send is reported against the document, naming its client", async ({
    page,
  }) => {
    test.slow();
    seedFailedDocument();

    try {
      await page.goto(AUTOMATION_URL);

      const row = page.getByRole("listitem").filter({ hasText: "INV-E2E-1" });
      await expect(row).toBeVisible();

      // Who it was raised for — the part the panel never showed. "For", not
      // "Recipient": under Recipient = Billing Contact the mail can go to a
      // different mailbox, and nothing stores which one.
      await expect(row).toContainText("For Samuel Rivers");
      // Not the muted "Generated": a send that reached nobody reads as failed.
      await expect(row).toContainText(/failed to send/i);
      // And the reason, in words that name the thing to go and fix.
      await expect(row).toContainText(/no email address/i);
    } finally {
      removeSeededDocument();
    }
  });

  /**
   * 6.2: a bounce has to reach the CLIENT, inline against the send it belongs
   * to, in words naming the thing to fix — not buried in a log only support
   * can read.
   *
   * The rows are seeded because the pipeline that produces them cannot run on
   * a laptop; see e2e/support/delivery-failures.ts. Everything from the stored
   * row to the rendered sentence is real.
   */
  test("a bounced document says so on the client panel, with the reason", async ({
    page,
  }) => {
    test.slow();
    // Rows carry this file's own marker, so the System Health spec running in
    // a parallel worker cannot delete them mid-assertion.
    seedDeliveryFailures({ suite: SUITE, workspaceId: WORKSPACE });

    try {
      await page.goto(AUTOMATION_URL);

      const bounced = page
        .getByRole("listitem")
        .filter({ hasText: invoiceNumber(SUITE, "bounce") });
      await expect(bounced).toBeVisible();
      await expect(bounced).toContainText(/bounced/i);
      // The sentence sits in the same row as the document it explains — the
      // client has to know WHICH send to chase and which address to correct.
      await expect(bounced).toContainText(/doesn't exist/i);

      // And a delivered one is not dressed up as a problem.
      const delivered = page
        .getByRole("listitem")
        .filter({ hasText: invoiceNumber(SUITE, "ok") });
      await expect(delivered).toContainText(/delivered/i);
      await expect(delivered).not.toContainText(/doesn't exist/i);
    } finally {
      clearDeliveryFailures(SUITE);
    }
  });

  /**
   * Read in a browser deliberately NOT in the schedule's timezone.
   *
   * `runAt` is a wall-clock time in the schedule's zone and `nextRun` is an
   * instant, so rendering the instant locally put two clocks in one row: a
   * workspace set to 09:00 Sydney read "7:00 AM" to this context.
   *
   * Nested inside the serial describe on purpose. It drives the same workspace
   * and the parent's beforeEach resets it, so as a sibling under the config's
   * fullyParallel the two would reset one another mid-test — the exact failure
   * the file header warns about.
   */
  test.describe("Next Run is read in the schedule timezone", () => {
    test.use({ timezoneId: "Asia/Manila" });

    test("shows the configured Run At, not the reader's local conversion", async ({
      page,
    }) => {
      test.slow();

      await page.goto(AUTOMATION_URL);

      const invoice = invoiceBlock(page);
      await invoice.getByRole("switch").click();
      await invoice.getByLabel(/run at/i).fill("09:00");

      await page.getByRole("button", { name: /save changes/i }).click();
      await expect(page.getByText(/saved successfully/i)).toBeVisible();
      await page.reload();

      const reloaded = invoiceBlock(page);
      await expect(reloaded.getByLabel(/run at/i)).toHaveValue("09:00");

      // The invariant, independent of the date the scheduler picks: every run of
      // this schedule happens at 09:00 in its own zone, so the time half of Next
      // Run must equal Run At. Formatted in Manila (UTC+8) it would read 7:00 AM.
      await expect(reloaded.getByLabel(/next run/i)).toHaveValue(
        /\d{2}\/\d{2}\/\d{4} at 9:00 AM$/,
      );

      // And the row says which clock it is, so the reader does not assume theirs.
      await expect(reloaded.getByText(/times shown in/i)).toBeVisible();
    });
  });
});
