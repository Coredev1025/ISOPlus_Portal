import { test, expect, type Page } from "@playwright/test";

/**
 * Epic 5 — the Invoice & Statement Automation tab, end to end.
 *
 * Records video for every test in this file, not just failures: this journey
 * is the demonstrable proof that configuration survives a round trip, and the
 * recording is an artefact people ask for by name.
 */
test.use({ video: "on" });

// Credentials come from the environment, never from source. `npm run dev:user`
// prints a local support_admin login; export these before running:
//   E2E_EMAIL=... E2E_PASSWORD=... npx playwright test
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

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
//   docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
//     db.businesses.updateOne({workspaceId:"55999"},
//       {$set:{workspaceId:"55999",name:"Flag-off fixture (e2e)",
//              "featureToggles.invoiceStatementAutomation":false}},
//       {upsert:true})'
const WORKSPACE_NO_FLAG = process.env.E2E_WORKSPACE_ID_NO_FLAG;

// Login is a backend call; the frontend proxies nothing. Ports differ per
// worktree, so read it rather than assuming 4001.
const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  "http://localhost:4001";

const AUTOMATION_URL = `/workspace/${WORKSPACE}/finance-settings?tab=automation`;

/**
 * Authenticate through the API rather than the login form.
 *
 * page.request shares the browser context's cookie jar, so the session cookie
 * it sets is the one the page will send. Driving the sign-in form instead
 * would put a password in the recording and make every test in this file
 * depend on the login UI, which Epic 5 does not touch.
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

// Serial, deliberately. Every test in this file drives the SAME workspace and
// resets it to defaults in beforeEach — under the config's fullyParallel these
// reset one another's state mid-test and fail for reasons that look nothing
// like the real cause. Giving each test its own workspace would be the
// alternative, but a workspace cannot be created locally: the list is proxied
// from ISO+ rather than stored.
test.describe.configure({ mode: "serial" });

test.describe("Invoice & Statement Automation", () => {
  test.skip(
    !EMAIL || !PASSWORD,
    "set E2E_EMAIL and E2E_PASSWORD (see npm run dev:user)",
  );

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
});
