import { test, expect } from "@playwright/test";
import { signInSupportAdmin } from "./helpers/support-auth";

/**
 * The workspace dashboard's action tiles.
 *
 * Each tile's button says what it does rather than where it goes — "Manage
 * Business", "View Audit Trail", "Configure Workspace". KAN-258 brought the
 * Finance tile into line: it read a bare "Open", which named neither.
 */
const WORKSPACE = process.env.E2E_SYSTEM_HEALTH_WORKSPACE_ID ?? "55369";

test.describe("workspace dashboard action tiles", () => {
  test.beforeEach(async ({ page }) => {
    await signInSupportAdmin(page);
  });

  test("the Finance tile is actioned with Manage Finance, not Open", async ({ page }) => {
    await page.goto(`/workspace/${WORKSPACE}`);

    // Anchored on the tile, not the page: a bare getByRole would pass on any
    // "Manage Finance" the dashboard happened to grow elsewhere, and the
    // absence assertion below would pass on a page that never rendered.
    const financeTile = page
      .locator("div", { has: page.getByRole("heading", { name: /finance settings & automation/i }) })
      .last();
    await expect(financeTile).toBeVisible();

    await expect(financeTile.getByRole("button", { name: /^manage finance$/i })).toBeVisible();
    await expect(financeTile.getByRole("button", { name: /^open$/i })).toHaveCount(0);
  });

  test("Manage Finance opens the finance settings page", async ({ page }) => {
    await page.goto(`/workspace/${WORKSPACE}`);

    await page.getByRole("button", { name: /^manage finance$/i }).click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${WORKSPACE}/finance-settings$`));
  });
});
