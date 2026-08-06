export type FinanceSettingsTab = "financial" | "accounting" | "automation";

const VALID_TABS: FinanceSettingsTab[] = [
  "financial",
  "accounting",
  "automation",
];

export function parseFinanceSettingsTab(
  raw: string | null | undefined
): FinanceSettingsTab {
  if (raw && VALID_TABS.includes(raw as FinanceSettingsTab)) {
    return raw as FinanceSettingsTab;
  }
  return "financial";
}

export function resolveActiveFinanceTab(
  requested: FinanceSettingsTab,
  automationEnabled: boolean
): FinanceSettingsTab {
  if (requested === "automation" && !automationEnabled) {
    return "financial";
  }
  return requested;
}
