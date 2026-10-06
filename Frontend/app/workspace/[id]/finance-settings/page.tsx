"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/ui/header";
import { useAppContext } from "@/app/context";
import {
  FinanceSettingsTabs,
  parseFinanceSettingsTab,
  resolveActiveFinanceTab,
  type FinanceSettingsTab,
} from "@/lib/finance-settings-page";
import {
  fetchInvoiceStatementAutomationFlag,
  type AutomationFlagState,
} from "@/lib/workspace-feature-toggles";
import Spinner from "@/components/ui/spin";
import { XeroOAuthReturnBoundary } from "@/lib/xero-oauth-return-listener";

function FinanceSettingsLoading() {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Spinner />
      <span>Loading…</span>
    </div>
  );
}

function FinanceSettingsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workspaceId = pathname.split("/")[2];
  const { setCurrentWorkspaceId } = useAppContext();
  const tabParam = searchParams.get("tab");

  const requestedTab = parseFinanceSettingsTab(tabParam);
  // Tri-state: "unavailable" is the profile call not answering, which must not
  // read as "this workspace does not have automation" — see the type.
  const [automationFlag, setAutomationFlag] =
    useState<AutomationFlagState>("off");
  const [flagLoaded, setFlagLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<FinanceSettingsTab>("financial");

  useEffect(() => {
    if (workspaceId) {
      setCurrentWorkspaceId(workspaceId);
    }
    return () => {
      setCurrentWorkspaceId(null);
    };
  }, [workspaceId, setCurrentWorkspaceId]);

  useEffect(() => {
    let cancelled = false;

    const loadFlag = async () => {
      const flag = await fetchInvoiceStatementAutomationFlag(workspaceId);
      if (cancelled) return;
      setAutomationFlag(flag);
      setFlagLoaded(true);
    };

    loadFlag();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!flagLoaded) return;
    const resolved = resolveActiveFinanceTab(requestedTab, automationFlag);
    setActiveTab(resolved);

    if (resolved !== requestedTab) {
      router.replace(`${pathname}?tab=${resolved}`);
    }
  }, [
    flagLoaded,
    requestedTab,
    automationFlag,
    pathname,
    router,
  ]);

  const handleTabChange = useCallback(
    (tab: FinanceSettingsTab) => {
      const resolved = resolveActiveFinanceTab(tab, automationFlag);
      setActiveTab(resolved);
      router.replace(`${pathname}?tab=${resolved}`);
    },
    [automationFlag, pathname, router]
  );

  return (
    <>
      <Button variant="ghost" className="mb-6" onClick={() => router.replace(`/workspace/${workspaceId}`)}>
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to Workspace
      </Button>

      <h1 className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">
        Finance Settings & Automation
      </h1>
      <p className="mb-8 max-w-3xl text-sm text-muted-foreground sm:text-base">
        Manage bank details, payment terms, document numbering, integrations,
        and billing automation.
      </p>

      {!flagLoaded ? (
        <FinanceSettingsLoading />
      ) : (
        <FinanceSettingsTabs
          workspaceId={workspaceId}
          activeTab={activeTab}
          automationEnabled={automationFlag !== "off"}
          onTabChange={handleTabChange}
        />
      )}
    </>
  );
}

export default function FinanceSettingsPage() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8 sm:px-6 lg:px-8">
        <Suspense fallback={<FinanceSettingsLoading />}>
          <XeroOAuthReturnBoundary />
          <FinanceSettingsContent />
        </Suspense>
      </div>
    </div>
  );
}
