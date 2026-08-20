import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Optional fixture seeding, off by default so existing workflows are untouched.
 *
 * When E2E_LOAD_FIXTURES is truthy, load the Care Management automation
 * fixture (Backend/test/fixtures/care-management-automation.json) through the
 * repo-root dev tooling before any spec runs. The loader is idempotent, so
 * re-running the suite is safe. Failure is a warning, never a suite abort:
 * with the Docker stack down the specs skip or fail with their own, clearer
 * messages, and setup must not mask them.
 */
export default function globalSetup(): void {
  const flag = (process.env.E2E_LOAD_FIXTURES ?? "").toLowerCase();
  if (!flag || flag === "0" || flag === "false") return;

  const repoRoot = path.resolve(__dirname, "..", "..");
  try {
    execFileSync(
      "node",
      [
        "scripts/dev.mjs",
        "fixture",
        "--file",
        "test/fixtures/care-management-automation.json",
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
  } catch (err) {
    console.warn(
      "[e2e global-setup] fixture load failed (is the Docker stack up?):",
      err instanceof Error ? err.message : err,
    );
  }
}
