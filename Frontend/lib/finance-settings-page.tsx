"use client";

import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccountingIntegrationsPanel } from "@/lib/accounting-integrations-panel";
import { FinancialSettingsPanel } from "@/lib/financial-settings-panel";
import {
  parseFinanceSettingsTab,
  type FinanceSettingsTab,
} from "@/lib/finance-settings-tab";

export type { FinanceSettingsTab };
export {
  parseFinanceSettingsTab,
  resolveActiveFinanceTab,
} from "@/lib/finance-settings-tab";

function PlaceholderPanel({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Card className="p-6 shadow-sm">
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </Card>
  );
}

type FinanceSettingsTabsProps = {
  workspaceId: string;
  activeTab: FinanceSettingsTab;
  automationEnabled: boolean;
  onTabChange: (tab: FinanceSettingsTab) => void;
};

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
      <TabsList className="mb-6 h-auto w-full justify-start gap-0 rounded-none border-b bg-transparent p-0">
        <TabsTrigger
          value="financial"
          className="rounded-none border-b-2 border-transparent bg-transparent px-1 py-2.5 mr-6 text-[13.5px] font-semibold text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
        >
          Financial Settings
        </TabsTrigger>
        <TabsTrigger
          value="accounting"
          className="rounded-none border-b-2 border-transparent bg-transparent px-1 py-2.5 mr-6 text-[13.5px] font-semibold text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
        >
          Accounting Integrations
        </TabsTrigger>
        {automationEnabled ? (
          <TabsTrigger
            value="automation"
            className="rounded-none border-b-2 border-transparent bg-transparent px-1 py-2.5 text-[13.5px] font-semibold text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
          >
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
          <PlaceholderPanel
            title="Invoice & Statement Automation"
            description="Automation schedule and email settings will be built in a later update. This tab is visible because the workspace feature flag is enabled."
          />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
