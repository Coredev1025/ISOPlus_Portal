import { test, expect, type Page } from "@playwright/test";
import { signInSupportAdmin } from "./helpers/support-auth";
import {
  clearKan322Businesses,
  newWorkspaceId,
  readBusiness,
  seedBusiness,
} from "./support/business-profile";

/**
 * KAN-322. Business Configuration and Finance Settings each validate only the
 * fields they show. Before, each blocked its save on the other's fields, so a
 * new workspace could not be set up from either page, and a record with a legacy
 * invalid value on the other page could not be saved at all.
 */
const BUSINESS_SAVED = "Business profile saved successfully!";
const FINANCE_SAVED = "Financial settings saved successfully!";

const businessUrl = (id: string) => `/workspace/${id}/configure-business`;
const financeUrl = (id: string) => `/workspace/${id}/finance-settings?tab=financial`;

async function saveBusiness(page: Page, id: string, fields: Record<string, string>) {
  await page.goto(businessUrl(id));
  await expect(page.getByLabel("Company Name")).toBeVisible();
  for (const [label, value] of Object.entries(fields)) {
    await page.getByLabel(label).fill(value);
  }
  await page.getByRole("button", { name: /save changes/i }).click();
}

/** A brand-new workspace asks for a first number for each document type. */
async function saveFinanceNewWorkspace(page: Page, id: string, bsb?: string) {
  await page.goto(financeUrl(id));
  await expect(
    page.getByRole("heading", { name: "Document Number Configuration" }),
  ).toBeVisible();
  if (bsb !== undefined) await page.locator("#bsb").fill(bsb);
  await page.locator("#invoice-next").fill("1001");
  await page.locator("#po-next").fill("101");
  await page.locator("#quote-next").fill("1");
  await page.locator("#statement-of-account-next").fill("1");
  await page.getByRole("button", { name: /save changes/i }).click();
}

test.describe("each page validates only its own fields (KAN-322)", () => {
  test.beforeEach(async ({ page }) => {
    await signInSupportAdmin(page);
  });
  test.afterAll(() => clearKan322Businesses());

  test("a new empty workspace saves Finance Settings first, then Business Configuration", async ({ page }) => {
    const id = newWorkspaceId("finance-first");
    await saveFinanceNewWorkspace(page, id);
    await expect(page.getByText(FINANCE_SAVED)).toBeVisible();

    await saveBusiness(page, id, { "Company Name": "Finance First Co" });
    await expect(page.getByText(BUSINESS_SAVED)).toBeVisible();
    expect(readBusiness(id)?.name).toBe("Finance First Co");
  });

  test("a new empty workspace saves Business Configuration first, then Finance Settings", async ({ page }) => {
    const id = newWorkspaceId("business-first");
    await saveBusiness(page, id, { "Company Name": "Business First Co" });
    await expect(page.getByText(BUSINESS_SAVED)).toBeVisible();

    await saveFinanceNewWorkspace(page, id, "062000");
    await expect(page.getByText(FINANCE_SAVED)).toBeVisible();
    const saved = readBusiness(id);
    expect(saved?.name).toBe("Business First Co");
    expect(saved?.bankDetails?.bsb).toBe("062000");
  });

  test("a stored invalid BSB does not block Business Configuration, and is left as it was", async ({ page }) => {
    const id = newWorkspaceId("bad-bsb");
    seedBusiness(id, { bankDetails: { bsb: "REDACTED", accountNumber: "x" } });

    await saveBusiness(page, id, { "Company Name": "Renamed Co" });
    await expect(page.getByText(BUSINESS_SAVED)).toBeVisible();
    const saved = readBusiness(id);
    expect(saved?.name).toBe("Renamed Co");
    expect(saved?.bankDetails?.bsb).toBe("REDACTED");
  });

  test("a stored invalid ABN does not block Finance Settings, and is left as it was", async ({ page }) => {
    const id = newWorkspaceId("bad-abn");
    seedBusiness(id, { abn: "REDACTED", name: "" });

    await page.goto(financeUrl(id));
    await page.locator("#bsb").fill("062000");
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByText(FINANCE_SAVED)).toBeVisible();
    const saved = readBusiness(id);
    expect(saved?.abn).toBe("REDACTED");
    expect(saved?.bankDetails?.bsb).toBe("062000");
  });

  test("an invalid ABN typed on Business Configuration is still rejected", async ({ page }) => {
    const id = newWorkspaceId("reject-abn");
    await saveBusiness(page, id, {
      "Company Name": "Acme",
      "Australian Business Number (ABN)": "123",
    });
    await expect(page.getByText("ABN must be exactly 11 digits")).toBeVisible();
    expect(readBusiness(id)).toBeNull();
  });

  test("an invalid BSB typed on Finance Settings is still rejected", async ({ page }) => {
    const id = newWorkspaceId("reject-bsb");
    await saveFinanceNewWorkspace(page, id, "12");
    await expect(page.getByText("BSB must be exactly 6 digits")).toBeVisible();
    expect(readBusiness(id)).toBeNull();
  });
});
