import { test, expect, type Page } from "@playwright/test";

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

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

// A non-admin login: a real `isoplus_user` account, seeded separately from
// `npm run dev:user` (which only ever prints a support_admin credential).
const USER_EMAIL = process.env.E2E_USER_EMAIL;
const USER_PASSWORD = process.env.E2E_USER_PASSWORD;

// A workspace with Invoice & Statement Automation enabled, so it appears in
// the System Health connection grid and its drill-down has something to show.
// Defaults to the same workspace invoice-statement-automation.spec.ts uses,
// since that is exactly the property this test needs.
const WORKSPACE = process.env.E2E_SYSTEM_HEALTH_WORKSPACE_ID ?? "55369";

const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  "http://localhost:4001";

/**
 * Authenticate through the API rather than the login form — page.request
 * shares the browser context's cookie jar, so the session it sets is the one
 * the page will send. Mirrors invoice-statement-automation.spec.ts.
 */
async function signIn(page: Page, email?: string, password?: string) {
  const response = await page.request.post(`${BACKEND}/api/auth/login`, {
    data: { email, password },
  });
  expect(response.ok(), `login failed: ${response.status()}`).toBe(true);
}

/**
 * `POST /api/auth/login` signs `role: 'support_admin'` unconditionally
 * (`Backend/src/routes/auth.js:294-298`) — a pre-existing quirk, out of scope
 * to fix here. It exists to give the seeded `dev:user` credential a working
 * session without a real ISO+ OAuth round trip, but it means the login
 * response's role can never be trusted for a non-admin fixture.
 *
 * `GET /api/auth/verify` (`Backend/src/routes/auth.js:373-380`) re-signs the
 * JWT from `user.role` read back out of Mongo, so it carries the account's
 * real stored role. A non-admin fixture must call login *then* verify —
 * verify alone would 401 with no session cookie yet — to end up with a
 * session whose role the server actually issued for that account.
 */
async function signInAsNonAdmin(page: Page) {
  await signIn(page, USER_EMAIL, USER_PASSWORD);
  const response = await page.request.get(`${BACKEND}/api/auth/verify`);
  expect(response.ok(), `verify failed: ${response.status()}`).toBe(true);
  const body = await response.json();
  expect(
    body?.user?.role,
    `expected an isoplus_user account, got role "${body?.user?.role}" — check E2E_USER_EMAIL`,
  ).toBe("isoplus_user");
}

test.describe("System Health", () => {
  test.skip(!EMAIL || !PASSWORD, "set E2E_EMAIL and E2E_PASSWORD — see npm run dev:user");

  test("an admin sees the tab, the tiles, and the delivery notice", async ({ page }) => {
    await signIn(page, EMAIL, PASSWORD);
    await page.goto("/dashboard");

    const tab = page.getByRole("tab", { name: /system health/i });
    await expect(tab).toBeVisible();
    await tab.click();

    await expect(page.getByText(/active automations/i)).toBeVisible();
    await expect(page.getByText(/error rate/i)).toBeVisible();
    await expect(page.getByText(/email delivery is not enabled yet/i)).toBeVisible();
  });

  test("clicking a client navigates to the drill-down", async ({ page }) => {
    await signIn(page, EMAIL, PASSWORD);
    await page.goto("/dashboard");

    await page.getByRole("tab", { name: /system health/i }).click();

    // The connection grid only lists workspaces with automation enabled, so
    // this depends on real data existing locally — same dependency
    // invoice-statement-automation.spec.ts has on E2E_WORKSPACE_ID. Skip
    // rather than fail when nothing matches, and say why.
    const clientRow = page.getByRole("button", { name: new RegExp(WORKSPACE) });
    test.skip(
      (await clientRow.count()) === 0,
      `workspace ${WORKSPACE} is not in the connection grid — set E2E_SYSTEM_HEALTH_WORKSPACE_ID to one with Invoice & Statement Automation enabled`,
    );

    await clientRow.click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${WORKSPACE}/system-health$`));
    await expect(page.getByRole("heading", { name: /system health/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /run invoices now/i })).toBeVisible();
  });

  test("a non-admin never sees the tab", async ({ page }) => {
    test.skip(!USER_EMAIL || !USER_PASSWORD, "set E2E_USER_EMAIL and E2E_USER_PASSWORD to a real isoplus_user account");

    await signInAsNonAdmin(page);
    await page.goto("/dashboard");

    await expect(page.getByRole("tab", { name: /workspaces/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /system health/i })).toHaveCount(0);
  });
});
