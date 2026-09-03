import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../Backend");

const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  "http://localhost:4001";

const FRONTEND =
  process.env.E2E_FRONTEND_URL ??
  process.env.PLAYWRIGHT_BASE_URL ??
  "http://localhost:3100";

/**
 * Sign in as support_admin through the real Google-support oauth-exchange path.
 * Inserts a one-time OAuth ticket in local Mongo (no application auth bypass).
 */
export async function signInSupportAdmin(page: Page) {
  const fromEnv = process.env.E2E_SUPPORT_TICKET?.trim();
  const ticket =
    fromEnv ||
    execSync("node scripts/e2e-support-ticket.mjs", {
      cwd: backendRoot,
      encoding: "utf8",
    }).trim();

  const loginUrl = `${FRONTEND.replace(/\/+$/, "")}/?ticket=${encodeURIComponent(ticket)}`;
  await page.goto(loginUrl);
  await page.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 20_000 });

  const verify = await page.request.get(`${BACKEND}/api/auth/verify`);
  expect(verify.ok(), `verify failed after support sign-in: ${verify.status()}`).toBe(
    true,
  );
  const body = await verify.json();
  expect(body?.user?.role).toBe("support_admin");
}

export { BACKEND, FRONTEND };
