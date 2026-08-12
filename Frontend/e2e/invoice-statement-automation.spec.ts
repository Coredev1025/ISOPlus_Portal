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
const WORKSPACE = process.env.E2E_WORKSPACE_ID ?? "55369";

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
  });

  test("flags a malformed email inline without blocking the form", async ({
    page,
  }) => {
    await page.goto(AUTOMATION_URL);

    const invoice = invoiceBlock(page);
    await invoice.getByLabel(/send a copy to/i).fill("not-an-email");

    await expect(invoice.getByText(/valid email address/i)).toBeVisible();
  });

  test("Next Run is read-only — the scheduler owns it", async ({ page }) => {
    await page.goto(AUTOMATION_URL);

    const nextRun = invoiceBlock(page).getByLabel(/next run/i);
    await expect(nextRun).toBeVisible();
    await expect(nextRun).toHaveAttribute("readonly", "");
  });

  test("the tab is absent when the workspace flag is off", async ({ page }) => {
    const disabled = process.env.E2E_WORKSPACE_ID_NO_FLAG;
    test.skip(!disabled, "needs a workspace with the flag disabled");

    await page.goto(`/workspace/${disabled}/finance-settings?tab=automation`);

    await expect(
      page.getByRole("tab", { name: /invoice & statement automation/i }),
    ).toHaveCount(0);
  });
});
