"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Link2 } from "lucide-react";
import axios from "@/app/utils/axiosConfig";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import Spinner from "@/components/ui/spin";
import { cn } from "@/lib/utils";
import { XeroConnectSection } from "@/lib/xero-connect-section";
import {
  EMPTY_LINE_ITEM_MAPPING,
  normalizeMapping,
  XeroAccountTaxMapping,
} from "@/lib/xero-account-tax-mapping";
import type { XeroLineItemMapping } from "@/lib/xero-account-tax-mapping-options";
import { XeroDisabledSyncToggles } from "@/lib/xero-disabled-sync-toggles";
import { XeroConnectionAuditLogs } from "@/lib/xero-connection-audit-logs";
import { showFetchErrorToast } from "@/lib/toast-utils";

type ProviderTab = "xero" | "myob" | "quickbooks";

type AccountingIntegrationsPanelProps = Readonly<{
  workspaceId: string;
}>;

type ProviderSubTabsProps = Readonly<{
  active: ProviderTab;
  onChange: (tab: ProviderTab) => void;
}>;

function ProviderSubTabs({ active, onChange }: ProviderSubTabsProps) {
  return (
    <div className="mb-5 flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onChange("xero")}
        className={cn(
          "rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold",
          active === "xero"
            ? "border-foreground bg-foreground text-background"
            : "border-border bg-background text-muted-foreground"
        )}
      >
        Xero
      </button>
      <button
        type="button"
        disabled
        className="cursor-not-allowed rounded-full border border-border bg-background px-3.5 py-1.5 text-[12.5px] font-semibold text-muted-foreground opacity-50"
      >
        MYOB
        <Badge variant="secondary" className="ml-1.5 text-[10px] uppercase">
          later
        </Badge>
      </button>
      <button
        type="button"
        disabled
        className="cursor-not-allowed rounded-full border border-border bg-background px-3.5 py-1.5 text-[12.5px] font-semibold text-muted-foreground opacity-50"
      >
        QuickBooks
        <Badge variant="secondary" className="ml-1.5 text-[10px] uppercase">
          later
        </Badge>
      </button>
    </div>
  );
}

type ConnectionStatusDotProps = Readonly<{
  connected: boolean;
  needsReconnect: boolean;
}>;

function ConnectionStatusDot({
  connected,
  needsReconnect,
}: ConnectionStatusDotProps) {
  let label = "Not connected";
  let dotClass = "bg-muted-foreground/50";
  if (connected && needsReconnect) {
    label = "Reconnect required";
    dotClass = "bg-amber-500";
  } else if (connected) {
    label = "Connected";
    dotClass = "bg-emerald-500";
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11.5px] text-muted-foreground">
      <i
        aria-hidden="true"
        className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)}
      />
      {label}
    </span>
  );
}

export function AccountingIntegrationsPanel({
  workspaceId,
}: AccountingIntegrationsPanelProps) {
  const [providerTab, setProviderTab] = useState<ProviderTab>("xero");
  const [loading, setLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [mapping, setMapping] = useState<XeroLineItemMapping>(EMPTY_LINE_ITEM_MAPPING);
  const [timezone, setTimezone] = useState("Australia/Sydney");

  const loadProfile = useCallback(
    async (signal?: AbortSignal) => {
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
        { params: { workspaceId }, signal }
      );
      setIsConnected(Boolean(response.data?.xeroIntegrated));
      setMapping(normalizeMapping(response.data?.xeroLineItemMapping));
      if (response.data?.headOfficeTimezone) {
        setTimezone(String(response.data.headOfficeTimezone));
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    const abortController = new AbortController();
    const run = async () => {
      try {
        setLoading(true);
        await loadProfile(abortController.signal);
      } catch (error: unknown) {
        const err = error as { name?: string };
        if (err.name === "CanceledError" || err.name === "AbortError") return;
        showFetchErrorToast("accounting integration settings");
      } finally {
        if (!abortController.signal.aborted) setLoading(false);
      }
    };
    run();
    return () => abortController.abort();
  }, [loadProfile]);

  const handleConnectionCleared = useCallback(() => {
    setMapping(EMPTY_LINE_ITEM_MAPPING);
  }, []);

  const handleOptionsLoadFailed = useCallback(() => {
    setNeedsReconnect(true);
  }, []);

  if (loading) {
    return (
      <Card className="flex items-center justify-center gap-2 p-10 text-muted-foreground shadow-sm">
        <Spinner />
        <span>Loading accounting integrations…</span>
      </Card>
    );
  }

  return (
    <Card className="p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Link2 className="h-4 w-4" />
        </div>
        <div>
          <h4 className="text-[14.5px] font-bold">Accounting Integrations</h4>
          <p className="text-[12.5px] text-muted-foreground">
            Connect ISO+ with supported accounting platforms to synchronise customers,
            invoices, payments and financial records.
          </p>
        </div>
      </div>

      <ProviderSubTabs active={providerTab} onChange={setProviderTab} />

      {providerTab === "xero" ? (
        <div className="flex flex-col gap-5 md:flex-row md:gap-6">
          <div className="w-full flex-none border-b pb-4 text-center md:w-[190px] md:border-b-0 md:border-r md:pb-0 md:pr-4">
            <div className="mx-auto mb-2.5 flex h-14 w-14 items-center justify-center overflow-hidden rounded-full">
              <Image
                src="/assets/xero-icon.png"
                alt=""
                width={56}
                height={56}
                className="h-14 w-14 object-cover"
              />
            </div>
            <h5 className="mb-2 text-[13px] font-bold">Xero</h5>
            <ConnectionStatusDot
              connected={isConnected}
              needsReconnect={needsReconnect}
            />
          </div>

          <div className="min-w-0 flex-1 space-y-5">
            <XeroConnectSection
              workspaceId={workspaceId}
              isConnected={isConnected}
              needsReconnect={needsReconnect}
              onConnectedChange={setIsConnected}
              onConnectionCleared={handleConnectionCleared}
              onNeedsReconnectChange={setNeedsReconnect}
            />
            <div className="border-t" />
            <XeroConnectionAuditLogs
              workspaceId={workspaceId}
              timezone={timezone}
              reloadKey={`${isConnected}:${needsReconnect}`}
            />
            <div className="border-t" />
            <XeroAccountTaxMapping
              workspaceId={workspaceId}
              isConnected={isConnected && !needsReconnect}
              initialMapping={mapping}
              onMappingSaved={setMapping}
              onOptionsLoadFailed={handleOptionsLoadFailed}
            />
            <div className="border-t" />
            <XeroDisabledSyncToggles />
          </div>
        </div>
      ) : null}
    </Card>
  );
}
