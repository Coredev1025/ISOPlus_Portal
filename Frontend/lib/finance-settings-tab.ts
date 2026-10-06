import type { AutomationFlagState } from "@/lib/workspace-feature-toggles";

export type FinanceSettingsTab = "financial" | "accounting" | "automation";

const VALID_TABS = new Set<FinanceSettingsTab>([
  "financial",
  "accounting",
  "automation",
]);

export function parseFinanceSettingsTab(
  raw: string | null | undefined
): FinanceSettingsTab {
  if (raw && VALID_TABS.has(raw as FinanceSettingsTab)) {
    return raw as FinanceSettingsTab;
  }
  return "financial";
}

/**
 * Only a definite `off` redirects.
 *
 * When the profile call did not answer we do not know whether this workspace
 * has the feature, and sending the reader to Financial Settings asserts that
 * it does not — the silent redirect a transient 503 used to cause.
 *
 * Staying is safe because this function is not the gate: the backend is.
 * `GET /automation-settings` is deliberately open so a workspace that lost the
 * feature can still see what it had, and `PUT` answers 403. The worst outcome
 * of guessing "show it" is a panel that reports its own error, which is honest;
 * the worst outcome of guessing "hide it" is a feature that appears deleted.
 */
export function resolveActiveFinanceTab(
  requested: FinanceSettingsTab,
  automationFlag: AutomationFlagState
): FinanceSettingsTab {
  if (requested === "automation" && automationFlag === "off") {
    return "financial";
  }
  return requested;
}
