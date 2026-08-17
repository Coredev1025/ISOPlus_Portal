"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Receipt } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AutomationEmailBlock } from "@/lib/automation-email-block";
import { AutomationScheduleBlock } from "@/lib/automation-schedule-block";
import {
  DEFAULT_BLOCK,
  fetchAutomationSettings,
  saveAutomationSettings,
  type AutomationBlock,
  type AutomationSettings,
} from "@/lib/automation-settings";

/**
 * DEFAULT_BLOCK is deep-frozen, including its nested `every`. A shallow spread
 * would leave invoice and statement aliasing the same frozen object, so each
 * block gets its own deep copy every time.
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
            <div className="my-[18px] h-px bg-border" />

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

type InvoiceStatementAutomationPanelProps = Readonly<{
  workspaceId: string;
}>;

export function InvoiceStatementAutomationPanel({
  workspaceId,
}: InvoiceStatementAutomationPanelProps) {
  const [settings, setSettings] = useState<AutomationSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAutomationSettings(workspaceId)
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch(() => {
        if (!cancelled) setErrorMessage("Could not load automation settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const update =
    (key: keyof AutomationSettings) => (next: AutomationBlock) =>
      setSettings((current) => ({ ...current, [key]: next }));

  const handleSave = async () => {
    setSaving(true);
    setErrorMessage("");
    setShowSuccess(false);
    try {
      setSettings(await saveAutomationSettings(workspaceId, settings));
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

  return (
    <div className="space-y-[18px]">
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
        <div
          role="alert"
          className="rounded-md border border-destructive bg-destructive/10 p-4"
        >
          <p className="text-sm text-destructive">{errorMessage}</p>
        </div>
      ) : null}

      {showSuccess ? (
        <div className="rounded-md border border-green-500 bg-green-100 p-4">
          <p className="text-sm text-green-700">
            Automation settings saved successfully!
          </p>
        </div>
      ) : null}

      <div className="flex justify-end gap-2.5">
        <Button
          type="button"
          variant="outline"
          onClick={() => setSettings(defaultSettings())}
          disabled={saving}
        >
          Restore Defaults
        </Button>
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
