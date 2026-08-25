"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Receipt } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AutomationEmailBlock } from "@/lib/automation-email-block";
import { AutomationScheduleBlock } from "@/lib/automation-schedule-block";
import { AutomationStatusPanel } from "@/lib/automation-status-panel";
import { hasInvalidEmail } from "@/lib/automation-helpers";
import {
  DEFAULT_BLOCK,
  fetchAutomationSettings,
  saveAutomationSettings,
  type AutomationBlock,
  type AutomationRecentDocument,
  type AutomationSettings,
} from "@/lib/automation-settings";

/**
 * DEFAULT_BLOCK is deep-frozen: a shallow spread would leave invoice and
 * statement aliasing the same frozen `every`, so each block is deep-copied.
 */
function defaultSettings(): AutomationSettings {
  return {
    invoice: structuredClone(DEFAULT_BLOCK),
    statement: structuredClone(DEFAULT_BLOCK),
  };
}

type AutomationSectionProps = Readonly<{
  idPrefix: string;
  icon: LucideIcon;
  title: string;
  description: string;
  scheduleLabel: string;
  value: AutomationBlock;
  onChange: (next: AutomationBlock) => void;
}>;

function AutomationSection({
  idPrefix,
  icon: Icon,
  title,
  description,
  scheduleLabel,
  value,
  onChange,
}: AutomationSectionProps) {
  const headingId = `${idPrefix}-automation-heading`;

  return (
    <section aria-labelledby={headingId}>
      <Card className="border p-5 shadow-sm">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3 id={headingId} className="text-[14.5px] font-bold leading-tight">
              {title}
            </h3>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {description}
            </p>
          </div>
        </div>

        <AutomationScheduleBlock
          idPrefix={idPrefix}
          label={scheduleLabel}
          value={value}
          onChange={onChange}
        />

        {value.enabled ? (
          <>
            <Separator className="my-[18px]" />

            <AutomationEmailBlock
              idPrefix={idPrefix}
              value={value}
              onChange={onChange}
            />
          </>
        ) : null}
      </Card>
    </section>
  );
}

/**
 * No form until the GET resolves, and none at all if it fails. The defaults the
 * panel holds meanwhile say "both automations off, no email settings", so a
 * Save over unknown server state disables both live schedules and erases their
 * email configuration, from a form that never showed what it was replacing.
 */
function AutomationLoadingSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-[18px]">
      <span className="sr-only">Loading automation settings…</span>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-32 rounded-lg" />
      ))}
    </div>
  );
}

function AutomationLoadFailed() {
  return (
    <Alert variant="destructive">
      <AlertDescription>
        Could not load automation settings. Nothing has been changed — reload
        the page to try again.
      </AlertDescription>
    </Alert>
  );
}

type LoadState = "loading" | "loaded" | "failed";

type InvoiceStatementAutomationPanelProps = Readonly<{
  workspaceId: string;
}>;

export function InvoiceStatementAutomationPanel({
  workspaceId,
}: InvoiceStatementAutomationPanelProps) {
  const [settings, setSettings] = useState<AutomationSettings>(defaultSettings);
  /**
   * The last state the SERVER confirmed, which is what the status panel
   * reports. `settings` is the working draft and changes on every keystroke;
   * feeding that to the status panel made it answer "is your automation
   * healthy?" from an unsaved form — switching a block off read "Paused" while
   * the schedule was still armed, and Restore Defaults erased a Last run that
   * had actually happened. Only a load or a successful save moves this.
   */
  const [savedSettings, setSavedSettings] =
    useState<AutomationSettings>(defaultSettings);
  // Held apart from settings because the PUT echo does not carry it — a save
  // must not blank the recent-documents list.
  const [recentDocuments, setRecentDocuments] = useState<
    AutomationRecentDocument[]
  >([]);
  // Held apart from settings for the same reason as recentDocuments: the PUT
  // echo does not carry it, so a save must not blank the health notices.
  const [health, setHealth] = useState<AutomationSettings["health"]>(undefined);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAutomationSettings(workspaceId)
      .then((loaded) => {
        if (!cancelled) {
          setSettings(loaded);
          setSavedSettings(loaded);
          setRecentDocuments(loaded.recentDocuments ?? []);
          setHealth(loaded.health);
          setLoadState("loaded");
        }
      })
      .catch(() => {
        if (!cancelled) setLoadState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // A "saved" banner sitting above unsaved edits is a lie, so any change to
  // the form retires it.
  const update = (key: keyof AutomationSettings) => (next: AutomationBlock) => {
    setShowSuccess(false);
    setSettings((current) => ({ ...current, [key]: next }));
  };

  const restoreDefaults = () => {
    setShowSuccess(false);
    setSettings(defaultSettings());
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMessage("");
    setShowSuccess(false);
    try {
      const saved = await saveAutomationSettings(workspaceId, settings);
      setSettings(saved);
      // The echo is now the server's state, so the status panel moves with it.
      setSavedSettings(saved);
      setShowSuccess(true);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      setErrorMessage(
        err.response?.data?.message ?? "Could not save automation settings."
      );
    } finally {
      setSaving(false);
    }
  };

  if (loadState === "loading") return <AutomationLoadingSkeleton />;
  if (loadState === "failed") return <AutomationLoadFailed />;

  // The API rejects the whole PUT with one message that does not say which of
  // six address fields is wrong, so the form has to say it first.
  const emailInvalid = hasInvalidEmail(settings);

  return (
    <div className="space-y-[18px]">
      <AutomationStatusPanel
        invoice={savedSettings.invoice}
        statement={savedSettings.statement}
        recentDocuments={recentDocuments}
        health={health}
      />

      <AutomationSection
        idPrefix="invoice"
        icon={Receipt}
        title="Invoice Automation"
        description="Generate and email invoices on a schedule instead of raising each one by hand."
        scheduleLabel="Generate Invoices Every"
        value={settings.invoice}
        onChange={update("invoice")}
      />

      <AutomationSection
        idPrefix="statement"
        icon={CalendarClock}
        title="Statement Automation"
        description="Generate and email client statements on a schedule."
        scheduleLabel="Generate Statements Every"
        value={settings.statement}
        onChange={update("statement")}
      />

      {errorMessage ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {/* role overrides Alert's own role="alert": a save confirmation is a
          polite status, not an assertive interruption. */}
      {showSuccess ? (
        <Alert role="status">
          <AlertDescription>
            Automation settings saved successfully!
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex justify-end gap-2.5">
        <Button
          type="button"
          variant="outline"
          onClick={restoreDefaults}
          disabled={saving}
        >
          Restore Defaults
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving || emailInvalid}
        >
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
