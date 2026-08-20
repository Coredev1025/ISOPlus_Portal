"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccountingIntegrationsPanel } from "@/lib/accounting-integrations-panel";
import { FinancialSettingsPanel } from "@/lib/financial-settings-panel";
import { InvoiceStatementAutomationPanel } from "@/lib/invoice-statement-automation-panel";
import {
  parseFinanceSettingsTab,
  type FinanceSettingsTab,
} from "@/lib/finance-settings-tab";

export type { FinanceSettingsTab };
export {
  parseFinanceSettingsTab,
  resolveActiveFinanceTab,
} from "@/lib/finance-settings-tab";

type FinanceSettingsTabsProps = Readonly<{
  workspaceId: string;
  activeTab: FinanceSettingsTab;
  automationEnabled: boolean;
  onTabChange: (tab: FinanceSettingsTab) => void;
}>;

export function FinanceSettingsTabs({
  workspaceId,
  activeTab,
  automationEnabled,
  onTabChange,
}: FinanceSettingsTabsProps) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) =>
        onTabChange(parseFinanceSettingsTab(value))
      }
      className="w-full"
    >
      <TabsList className="mb-6">
        <TabsTrigger value="financial">Financial Settings</TabsTrigger>
        <TabsTrigger value="accounting">Accounting Integrations</TabsTrigger>
        {automationEnabled ? (
          <TabsTrigger value="automation">
            Invoice & Statement Automation
          </TabsTrigger>
        ) : null}
      </TabsList>

      <TabsContent value="financial" className="mt-0">
        <FinancialSettingsPanel workspaceId={workspaceId} />
      </TabsContent>

      <TabsContent value="accounting" className="mt-0">
        <AccountingIntegrationsPanel workspaceId={workspaceId} />
      </TabsContent>

      {automationEnabled ? (
        <TabsContent value="automation" className="mt-0">
          <InvoiceStatementAutomationPanel workspaceId={workspaceId} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
