import { test, expect } from "@playwright/test";
import { signInSupportAdmin } from "./helpers/support-auth";

/**
 * Business Configuration is reached from the workspace dashboard's
 * "Manage Business" tile. KAN-257 is the copy on the three logo uploads:
 * size, recommended dimensions, and where each logo is used.
 */
const WORKSPACE = process.env.E2E_SYSTEM_HEALTH_WORKSPACE_ID ?? "55369";

test.describe("business configuration logos", () => {
  test.beforeEach(async ({ page }) => {
    await signInSupportAdmin(page);
  });

  test("Manage Business opens the logo guidance for default, square, and wide", async ({
    page,
  }) => {
    await page.goto(`/workspace/${WORKSPACE}`);
    await page.getByRole("button", { name: /^manage business$/i }).click();
    await expect(page).toHaveURL(
      new RegExp(`/workspace/${WORKSPACE}/configure-business$`),
    );

    const defaultLogo = page
      .getByRole("heading", { name: "Default Logo" })
      .locator("..");
    await expect(defaultLogo.getByText("Maximum file size: 1 MB", { exact: true })).toBeVisible();
    await expect(
      defaultLogo.getByText(
        "Used for general application areas, profile displays, and generated PDF documents, including tax invoices.",
        { exact: true },
      ),
    ).toBeVisible();

    const squareLogo = page
      .getByRole("heading", { name: "Square Logo" })
      .locator("..");
    await expect(
      squareLogo.getByText("Recommended dimensions: 512 × 512 px", { exact: true }),
    ).toBeVisible();
    await expect(squareLogo.getByText("Maximum file size: 1 MB", { exact: true })).toBeVisible();
    await expect(
      squareLogo.getByText("Used for digital forms, such as the Incident Report Form.", {
        exact: true,
      }),
    ).toBeVisible();

    const wideLogo = page.getByRole("heading", { name: "Wide Logo" }).locator("..");
    await expect(
      wideLogo.getByText(
        "Recommended dimensions: 820 × 312 px, with the logo centred within the middle third of the image. Maximum file size: 1 MB",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      wideLogo.getByText(
        "Used for online documents, including policies and procedures.",
        { exact: true },
      ),
    ).toBeVisible();
  });

  // KAN-290: the numbering sequence is read-only. The next number of each
  // document type is shown, grayed out, and cannot be edited; a counter is
  // advanced only by the generators that issue the numbers.
  test("Finance Settings shows the document next numbers read-only", async ({
    page,
  }) => {
    await page.goto(`/workspace/${WORKSPACE}/finance-settings?tab=financial`);
    await expect(
      page.getByRole("heading", { name: "Document Number Configuration" }),
    ).toBeVisible();

    for (const id of [
      "invoice-next",
      "po-next",
      "quote-next",
      "statement-of-account-next",
    ]) {
      const next = page.locator(`#${id}`);
      await expect(next).toBeVisible();
      await expect(next).toBeDisabled();
      await expect(next).toHaveAttribute("readonly", "");
    }

    // The prefix next to it is still editable.
    await expect(page.locator("#invoice-prefix")).toBeEditable();
  });
});
