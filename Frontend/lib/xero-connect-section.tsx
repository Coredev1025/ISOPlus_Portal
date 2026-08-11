"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import axios from "@/app/utils/axiosConfig";
import { Button } from "@/components/ui/button";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";

type XeroConnectSectionProps = {
  workspaceId: string;
  isConnected: boolean;
  needsReconnect?: boolean;
  onConnectedChange: (connected: boolean) => void;
  onConnectionCleared?: () => void;
  onNeedsReconnectChange?: (needsReconnect: boolean) => void;
};

function openXeroPopup(url: string) {
  const width = 600;
  const height = 600;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;
  return window.open(
    url,
    "Xero Integration",
    `width=${width},height=${height},left=${left},top=${top},status=yes,scrollbars=yes`
  );
}

async function fetchXeroAuthUrl(workspaceId: string, signal: AbortSignal) {
  const response = await axios.get(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/xero/redirect`,
    { params: { workspaceId }, signal }
  );
  return response.data as { url?: string; error?: string; message?: string };
}

function resolveTenantIdFromOAuth(data: {
  tenants?: Array<{ tenantId?: string }>;
  organization?: { organisationId?: string };
}) {
  const fromTenant = data.tenants?.[0]?.tenantId;
  if (typeof fromTenant === "string" && fromTenant.trim()) return fromTenant.trim();
  const fromOrg = data.organization?.organisationId;
  if (typeof fromOrg === "string" && fromOrg.trim()) return fromOrg.trim();
  return null;
}

function isReconnectFailureMessage(message?: string) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("no xero organisation") ||
    text.includes("no xero organization") ||
    text.includes("reconnect") ||
    text.includes("expired") ||
    text.includes("not authenticated")
  );
}

export function XeroConnectSection({
  workspaceId,
  isConnected,
  needsReconnect = false,
  onConnectedChange,
  onConnectionCleared,
  onNeedsReconnectChange,
}: XeroConnectSectionProps) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const oauthMessageListenerRef = useRef<((event: MessageEvent) => void) | null>(
    null
  );

  useEffect(() => {
    return () => {
      if (oauthMessageListenerRef.current) {
        window.removeEventListener("message", oauthMessageListenerRef.current);
        oauthMessageListenerRef.current = null;
      }
    };
  }, []);

  const clearOauthMessageListener = useCallback(() => {
    if (oauthMessageListenerRef.current) {
      window.removeEventListener("message", oauthMessageListenerRef.current);
      oauthMessageListenerRef.current = null;
    }
  }, []);

  const completeOAuth = useCallback(
    async (
      tokenSet: unknown,
      organization: unknown,
      tenantId: string,
      signal: AbortSignal
    ) => {
      await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/xero/connect`,
        { workspaceId, tokens: tokenSet, organization, tenantId },
        { signal }
      );
      onConnectedChange(true);
      onNeedsReconnectChange?.(false);
      showSuccessToast("Successfully connected to Xero!");
    },
    [onConnectedChange, onNeedsReconnectChange, workspaceId]
  );

  const handleConnect = useCallback(async () => {
    const abortController = new AbortController();
    try {
      setIsConnecting(true);
      const data = await fetchXeroAuthUrl(workspaceId, abortController.signal);
      if (!data.url) {
        const reason = data.error || data.message || "Failed to get Xero redirect URL.";
        showErrorToast("Failed to connect to Xero", { description: reason });
        return;
      }

      const popup = openXeroPopup(data.url);
      clearOauthMessageListener();
      const handleMessage = async (event: MessageEvent) => {
        if (event.data?.type !== "XERO_AUTH") return;
        clearOauthMessageListener();
        if (popup) popup.close();
        if (!event.data.success || abortController.signal.aborted) {
          showErrorToast("Failed to connect to Xero", {
            description: "Could not complete the Xero authentication. Please try again.",
          });
          return;
        }

        const tenantId = resolveTenantIdFromOAuth(event.data);
        if (!tenantId) {
          showErrorToast("Failed to connect to Xero", {
            description:
              "No Xero organisation was selected. Please try again and choose an organisation.",
          });
          return;
        }

        try {
          await completeOAuth(
            event.data.tokenSet,
            event.data.organization,
            tenantId,
            abortController.signal
          );
        } catch (error: unknown) {
          const err = error as { response?: { data?: { message?: string } } };
          showErrorToast("Failed to connect to Xero", {
            description:
              err.response?.data?.message ||
              "Could not complete the Xero authentication. Please try again.",
          });
        }
      };
      oauthMessageListenerRef.current = handleMessage;
      window.addEventListener("message", handleMessage);
    } catch (error: unknown) {
      const err = error as {
        name?: string;
        message?: string;
        response?: { data?: { error?: string; message?: string } };
      };
      if (err.name === "CanceledError" || err.name === "AbortError") return;
      const reason =
        err.response?.data?.error ||
        err.response?.data?.message ||
        err.message ||
        "Please try again.";
      showErrorToast("Failed to connect to Xero", { description: reason });
    } finally {
      if (!abortController.signal.aborted) setIsConnecting(false);
    }
  }, [clearOauthMessageListener, completeOAuth, workspaceId]);

  const handleTestConnection = useCallback(async () => {
    try {
      setIsTesting(true);
      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/xero/update-organization`,
        { workspaceId }
      );
      if (response.data?.success) {
        onNeedsReconnectChange?.(false);
        showSuccessToast("Connection OK", {
          description: "Xero organisation details refreshed successfully.",
        });
        return;
      }
      showErrorToast("Test connection failed", {
        description: "Could not refresh Xero organisation details.",
      });
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } }; message?: string };
      const message =
        err.response?.data?.message || err.message || "Please reconnect to Xero.";
      if (isReconnectFailureMessage(message)) {
        onNeedsReconnectChange?.(true);
      }
      showErrorToast("Test connection failed", { description: message });
    } finally {
      setIsTesting(false);
    }
  }, [onNeedsReconnectChange, workspaceId]);

  const handleDisconnect = useCallback(async () => {
    try {
      setIsDisconnecting(true);
      await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/xero/disconnect`,
        { workspaceId }
      );
      onConnectedChange(false);
      onNeedsReconnectChange?.(false);
      onConnectionCleared?.();
      showSuccessToast("Successfully disconnected from Xero!");
    } catch {
      showErrorToast("Failed to disconnect from Xero", {
        description: "Please try again.",
      });
    } finally {
      setIsDisconnecting(false);
    }
  }, [
    onConnectedChange,
    onConnectionCleared,
    onNeedsReconnectChange,
    workspaceId,
  ]);

  return (
    <div className="space-y-3">
      {needsReconnect ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Xero tokens are saved, but no organisation is available. Disconnect and
          Connect Xero again, then select an organisation.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {isConnected ? (
          <Button
            variant="destructive"
            onClick={handleDisconnect}
            disabled={isDisconnecting || isConnecting}
          >
            {isDisconnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Disconnect
          </Button>
        ) : (
          <Button onClick={handleConnect} disabled={isConnecting}>
            {isConnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
            Connect Xero
          </Button>
        )}
        {isConnected && needsReconnect ? (
          <Button onClick={handleConnect} disabled={isConnecting || isDisconnecting}>
            {isConnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
            Reconnect Xero
          </Button>
        ) : null}
        <Button
          variant="outline"
          onClick={handleTestConnection}
          disabled={!isConnected || isTesting || isConnecting}
        >
          {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Test Connection
        </Button>
      </div>
    </div>
  );
}
