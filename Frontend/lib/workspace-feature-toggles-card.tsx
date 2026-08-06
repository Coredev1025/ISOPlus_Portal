"use client";

import { useEffect, useState } from "react";
import { Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import Spinner from "@/components/ui/spin";
import {
  showFetchErrorToast,
  showSaveErrorToast,
  showSaveSuccessToast,
} from "@/lib/toast-utils";
import {
  fetchWorkspaceFeatureToggles,
  saveWorkspaceFeatureToggles,
} from "@/lib/workspace-feature-toggles";

type WorkspaceFeatureTogglesCardProps = {
  workspaceId: string;
};

export function WorkspaceFeatureTogglesCard({
  workspaceId,
}: WorkspaceFeatureTogglesCardProps) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const toggles = await fetchWorkspaceFeatureToggles(workspaceId);
        if (!cancelled) {
          setEnabled(toggles.invoiceStatementAutomation);
        }
      } catch (error: any) {
        if (!cancelled) {
          showFetchErrorToast(
            "feature toggles",
            error.response?.data?.message || "Failed to load feature toggles"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const toggles = await saveWorkspaceFeatureToggles(workspaceId, enabled);
      setEnabled(toggles.invoiceStatementAutomation);
      showSaveSuccessToast("Feature toggles");
    } catch (error: any) {
      showSaveErrorToast(
        "feature toggles",
        error.response?.data?.message || "Failed to save feature toggles"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6 shadow-lg">
      <div className="mb-6 flex items-start gap-4">
        <Flag className="mt-1 h-6 w-6 text-primary" />
        <div>
          <h3 className="mb-2 text-xl font-semibold">Feature Toggles</h3>
          <p className="text-sm text-muted-foreground">
            Visible to <strong>System Owner</strong> and{" "}
            <strong>Support Admin</strong> roles only. These workspace-level
            controls live on Workspace Configuration and default to off for
            every new and existing workspace.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              Location: Workspace Configuration → Feature Toggles (this card).
            </li>
            <li>
              Effect: when enabled, Finance Settings &amp; Automation shows the
              &quot;Invoice &amp; Statement Automation&quot; tab for that
              workspace; when disabled, the tab is hidden for all users.
            </li>
            <li>
              Audience: leave off for NDIS / SaH / IMS (and any workspace
              without invoicing yet) so clients are not shown automation that
              does not apply. No separate NDIS/SaH/IMS toggle is needed.
            </li>
          </ul>
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-2 pr-4">
          <div className="text-sm font-semibold">
            Enable Invoice &amp; Statement Automation
          </div>
          <p className="text-sm text-muted-foreground">
            Turns the Invoice &amp; Statement Automation tab on or off for this
            workspace only. The setting is stored per workspace and exposed to
            the Finance Settings page so the third tab can render conditionally.
          </p>
        </div>
        {loading ? (
          <Spinner />
        ) : (
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={saving}
            aria-label="Enable Invoice and Statement Automation"
          />
        )}
      </div>

      <div className="mt-6 flex justify-end">
        <Button onClick={handleSave} disabled={loading || saving}>
          {saving ? (
            <>
              <Spinner className="mr-2" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </Card>
  );
}
