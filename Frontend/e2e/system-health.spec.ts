import { test, expect, type Page } from "@playwright/test";
import {
  clearDeliveryFailures,
  messageId,
  runMarker,
  seedDeliveryFailures,
} from "./support/delivery-failures";
import { signInSupportAdmin, BACKEND } from "./helpers/support-auth";

/**
 * Epic 6 — the System Health tab, its per-client drill-down, and the role gate.
 *
 * The gate is the half worth an e2e test: a unit test can assert the tab
 * renders, but only a real session proves the role that reaches the browser is
 * the one the server issued. Signed against `Frontend/e2e/invoice-statement-automation.spec.ts`'s
 * `signIn` shape (page.request so the cookie lands in the browser context's
 * jar) rather than importing it — that helper is not exported, and exporting
 * it would be a change to an Epic 5 file this task has no reason to touch.
 */

const USER_EMAIL = process.env.E2E_USER_EMAIL;
const USER_PASSWORD = process.env.E2E_USER_PASSWORD;

const WORKSPACE = process.env.E2E_SYSTEM_HEALTH_WORKSPACE_ID ?? "55369";

async function signIn(page: Page) {
  await signInSupportAdmin(page);
}

/**
 * Non-admin e2e still depends on a password-capable login path for isoplus_user
 * fixtures. Support-admin sign-in no longer uses email/password — skip when
 * those credentials are not configured.
 */
async function signInAsNonAdmin(page: Page) {
  test.skip(
    !USER_EMAIL || !USER_PASSWORD,
    "set E2E_USER_EMAIL and E2E_USER_PASSWORD to a real isoplus_user account",
  );
  const response = await page.request.post(`${BACKEND}/api/auth/login`, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });
  expect(response.ok(), `login failed: ${response.status()}`).toBe(true);
  const verify = await page.request.get(`${BACKEND}/api/auth/verify`);
  expect(verify.ok(), `verify failed: ${verify.status()}`).toBe(true);
  const body = await verify.json();
  expect(
    body?.user?.role,
    `expected an isoplus_user account, got role "${body?.user?.role}" — check E2E_USER_EMAIL`,
  ).toBe("isoplus_user");
}

test.describe("System Health", () => {
  test("an admin sees the tab, the tiles, and the delivery notice", async ({ page }) => {
    await signIn(page);
    await page.goto("/dashboard");

    const tab = page.getByRole("tab", { name: /system health/i });
    await expect(tab).toBeVisible();
    await tab.click();

    await expect(page.getByText(/active automations/i)).toBeVisible();
    await expect(page.getByText(/error rate/i)).toBeVisible();
    // Was asserting the screen said delivery reporting "is not built yet" —
    // an expectation that outlived the thing it described. Both figures are
    // real now, and a zero must render as a zero.
    await expect(page.getByText(/^Bounced \(/)).toBeVisible();
    await expect(page.getByText(/^Complaints \(/)).toBeVisible();
    await expect(page.getByText(/not built yet/i)).toHaveCount(0);
  });

  test("clicking a client navigates to the drill-down", async ({ page }) => {
    await signIn(page);
    await page.goto("/dashboard");

    await page.getByRole("tab", { name: /system health/i }).click();

    // The connection grid only lists workspaces with automation enabled, so
    // this depends on real data existing locally — same dependency
    // invoice-statement-automation.spec.ts has on E2E_WORKSPACE_ID. Skip
    // rather than fail when nothing matches, and say why.
    //
    // The grid populates from an async fetch after the tab click above, so
    // count() alone cannot tell "absent" from "not loaded yet" — it queries
    // the DOM once, synchronously, with no retry. Wait for the grid to reach
    // a settled state first: either our row appeared, or the grid rendered
    // its empty state (the exact copy in
    // Frontend/lib/system-health-connection-grid.tsx). Only once one of the
    // two is actually visible do we know which case we're in.
    const clientRow = page.getByRole("button", { name: new RegExp(WORKSPACE) });
    const emptyState = page.getByText(
      /no workspace has invoice & statement automation enabled yet/i,
    );
    await expect(clientRow.or(emptyState)).toBeVisible();

    test.skip(
      (await clientRow.count()) === 0,
      `workspace ${WORKSPACE} is not in the connection grid — set E2E_SYSTEM_HEALTH_WORKSPACE_ID to one with Invoice & Statement Automation enabled`,
    );

    await clientRow.click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${WORKSPACE}/system-health$`));
    await expect(page.getByRole("heading", { name: /system health/i })).toBeVisible();

    // KAN-230 removed the manual trigger buttons by product decision: the
    // drill-down reports what the scheduler did, it does not start runs.
    // Asserted against a landmark that proves the page actually rendered —
    // otherwise "the button is absent" would also pass on a blank screen.
    await expect(page.getByRole("button", { name: /run invoices now/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /run statements now/i })).toHaveCount(0);
  });

  /**
   * KAN-43. The grid labelled every row with the raw workspaceId, because the
   * `/clients` query's `.select()` omitted the `name` already on the same
   * Business document. Asserted end-to-end rather than only in the grid's unit
   * test: the unit test is handed a name, so it cannot catch the half that was
   * actually broken — the route not sending one.
   *
   * The name is read from the API rather than hardcoded, so this works against
   * whatever workspace E2E_SYSTEM_HEALTH_WORKSPACE_ID points at. Only the
   * "the name is rendered" assertion is conditional on there being one — the
   * contract assertion below it is not, so a workspace whose Business row has
   * no name still fails this test if the route stops sending the key.
   */
  test("labels a client row with its business name, not the workspace id", async ({ page }) => {
    await signIn(page);

    const response = await page.request.get(`${BACKEND}/api/system-health/clients`);
    expect(response.ok(), `clients failed: ${response.status()}`).toBe(true);
    const { clients } = await response.json();
    const client = clients?.find((c: { workspaceId: string }) => c.workspaceId === WORKSPACE);

    test.skip(
      !client,
      `workspace ${WORKSPACE} has no Invoice & Statement Automation settings — set E2E_SYSTEM_HEALTH_WORKSPACE_ID to one that does`,
    );

    // Key presence, asserted before anything is skipped: the bug was `name`
    // missing from the payload entirely, and null is a legitimate value. Were
    // this folded into the render assertion below it would skip rather than
    // fail on the very defect it exists to catch — verified by reverting the
    // `.select()` and watching this line go red.
    expect(
      client,
      "GET /api/system-health/clients must carry a name key for every client",
    ).toHaveProperty("name");

    await page.goto("/dashboard");
    await page.getByRole("tab", { name: /system health/i }).click();

    const row = page.getByRole("button", { name: new RegExp(WORKSPACE) });
    await expect(row).toBeVisible();
    // The id is always there — it is what the drill-down URL and the logs are
    // keyed on, so the name is added above it rather than swapped for it.
    await expect(row).toContainText(WORKSPACE);

    if (client.name) {
      await expect(row).toContainText(client.name);
    }
  });

  test("a non-admin never sees the tab", async ({ page }) => {
    test.skip(!USER_EMAIL || !USER_PASSWORD, "set E2E_USER_EMAIL and E2E_USER_PASSWORD to a real isoplus_user account");

    await signInAsNonAdmin(page);
    await page.goto("/dashboard");

    await expect(page.getByRole("tab", { name: /workspaces/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /system health/i })).toHaveCount(0);
  });
});

/** These rows belong to this file; see e2e/support/delivery-failures.ts. */
const SUITE = "system-health" as const;

/**
 * The reporting half of 6.2/6.4/6.5, exercised against seeded delivery
 * failures.
 *
 * The pipeline that PRODUCES a bounce cannot run locally — there is no SES, the
 * worker falls back to the offline outbox, and no messageId exists for an event
 * to match. What is testable, and what these cover, is everything downstream:
 * that a bounce and a complaint reach the overview's counters, and that a
 * per-message outcome reaches the drill-down attributed to the right recipient.
 * See e2e/support/delivery-failures.ts for why the rows are seeded.
 */
test.describe("delivery failures are reported", () => {
  // Serial: the three tests read one shared set of seeded rows. Under the
  // config's fullyParallel they would otherwise land in different workers and
  // one test's cleanup would delete the rows another is still asserting on.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    seedDeliveryFailures({ suite: SUITE, workspaceId: WORKSPACE });
  });

  test.afterAll(() => {
    clearDeliveryFailures(SUITE);
  });

  test("the overview counts bounces and complaints", async ({ page }) => {
    test.slow();
    await signIn(page);
    await page.goto("/dashboard");
    await page.getByRole("tab", { name: /system health/i }).click();

    // The tiles replaced a paragraph that said delivery reporting was not
    // built. Both must now be present AND numeric.
    const bounced = page.getByText(/^Bounced \(/);
    await expect(bounced).toBeVisible();
    await expect(page.getByText(/^Complaints \(/)).toBeVisible();
    await expect(page.getByText(/not built yet/i)).toHaveCount(0);

    // At least the seeded ones. Not an exact count: a developer's database may
    // legitimately hold other events, and pinning the total would make this
    // test fail for reasons that have nothing to do with the screen.
    const overview = await page.request.get(`${BACKEND}/api/system-health/overview`);
    const body = await overview.json();
    expect(body.delivery.bounced).toBeGreaterThanOrEqual(1);
    expect(body.delivery.complained).toBeGreaterThanOrEqual(1);
  });

  test("the drill-down names each message and why it failed", async ({ page }) => {
    test.slow();
    await signIn(page);
    await page.goto(`/workspace/${WORKSPACE}/system-health`);

    // Expand the seeded run. The listing is fetched on demand, so nothing
    // about it is on screen until this is clicked.
    await page.getByRole("button", { name: /show emails/i }).first().click();

    await expect(page.getByText("Jane Smith")).toBeVisible();
    await expect(page.getByText(/doesn't exist/i)).toBeVisible();
    // The delivered one must not be dressed up as a failure.
    await expect(page.getByText("Mike Bird")).toBeVisible();
  });

  test("a rendering failure is a failure, not a silent success", async ({ page }) => {
    test.slow();
    await signIn(page);

    // The defect this covers left the document reading "Sent" forever, because
    // the event type was stored but had no mapped delivery state.
    const res = await page.request.get(
      `${BACKEND}/api/system-health/workspace/${WORKSPACE}/runs/${await seededRunId(page)}/emails`,
    );
    const { emails } = await res.json();
    const render = emails.find((e: { messageId: string }) => e.messageId === messageId(SUITE, "render"));

    expect(render.state).toBe("failed");
    expect(render.detail).toMatch(/template/i);
  });
});

/** The _id of the run seedDeliveryFailures wrote, read back through the API. */
async function seededRunId(page: Page): Promise<string> {
  const res = await page.request.get(
    `${BACKEND}/api/system-health/workspace/${WORKSPACE}?page=1`,
  );
  const { runs } = await res.json();
  const seeded = runs.find((r: { jobId: string }) => r.jobId === runMarker(SUITE));
  expect(seeded, "seeded run not found in history").toBeTruthy();
  return seeded._id;
}
