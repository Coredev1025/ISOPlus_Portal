"use client";

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  defaultRunOnForUnit,
  runOnOptionsForUnit,
  type AutomationUnit,
  type RunOnOption,
} from "@/lib/automation-run-on-options";
import type { AutomationBlock } from "@/lib/automation-settings";

type AutomationFieldProps = Readonly<{
  id: string;
  label: string;
  children: ReactNode;
  hint?: string;
}>;

/** Shared by the schedule and email blocks so both tabs label fields alike. */
export function AutomationField({
  id,
  label,
  children,
  hint,
}: AutomationFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label
        htmlFor={id}
        className="text-xs font-semibold text-muted-foreground"
      >
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Structurally compatible with RunOnOption, so both blocks feed one select. */
export type AutomationSelectOption = { value: string | number; label: string };

type OptionSelectProps = Readonly<{
  id: string;
  value: string;
  options: readonly AutomationSelectOption[];
  ariaLabel?: string;
  className?: string;
  onValueChange: (value: string) => void;
}>;

/** Radix only speaks strings, so option values are stringified on the way in. */
export function OptionSelect({
  id,
  value,
  options,
  ariaLabel,
  className,
  onValueChange,
}: OptionSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={String(option.value)} value={String(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const UNIT_OPTIONS: readonly AutomationSelectOption[] = [
  { value: "day", label: "Day(s)" },
  { value: "week", label: "Week(s)" },
  { value: "month", label: "Month(s)" },
  { value: "quarter", label: "Quarter(s)" },
  { value: "year", label: "Year(s)" },
];

type RunOn = AutomationBlock["runOn"];

function monthDayOf(runOn: RunOn): { month: number; day: number } {
  return runOn !== null && typeof runOn === "object"
    ? runOn
    : { month: 1, day: 1 };
}

type RunOnFieldsProps = Readonly<{
  idPrefix: string;
  unit: AutomationUnit;
  runOn: RunOn;
  onChange: (runOn: RunOn) => void;
}>;

function MonthDayRunOn({ idPrefix, runOn, onChange, months, days }: Readonly<{
  idPrefix: string;
  runOn: RunOn;
  onChange: (runOn: RunOn) => void;
  months: readonly RunOnOption[];
  days: readonly RunOnOption[];
}>) {
  const current = monthDayOf(runOn);
  return (
    <AutomationField id={`${idPrefix}-run-on-month`} label="Run On">
      <div className="flex items-center gap-2">
        <OptionSelect
          id={`${idPrefix}-run-on-month`}
          ariaLabel="Run On Month"
          value={String(current.month)}
          options={months}
          className="min-w-0 flex-1"
          onValueChange={(next) =>
            onChange({ month: Number(next), day: current.day })
          }
        />
        <OptionSelect
          id={`${idPrefix}-run-on-day`}
          ariaLabel="Run On Day"
          value={String(current.day)}
          options={days}
          className="min-w-0 flex-1"
          onValueChange={(next) =>
            onChange({ month: current.month, day: Number(next) })
          }
        />
      </div>
    </AutomationField>
  );
}

function RunOnFields({ idPrefix, unit, runOn, onChange }: RunOnFieldsProps) {
  const { kind, options, months } = runOnOptionsForUnit(unit);

  if (kind === "none") return null;

  if (kind === "month-day") {
    return (
      <MonthDayRunOn
        idPrefix={idPrefix}
        runOn={runOn}
        onChange={onChange}
        months={months ?? []}
        days={options}
      />
    );
  }

  const isDayOfMonth = kind === "day-of-month";
  return (
    <AutomationField id={`${idPrefix}-run-on`} label="Run On">
      <OptionSelect
        id={`${idPrefix}-run-on`}
        ariaLabel="Run On"
        value={runOn === null || typeof runOn === "object" ? "" : String(runOn)}
        options={options}
        onValueChange={(next) => onChange(isDayOfMonth ? Number(next) : next)}
      />
    </AutomationField>
  );
}

type AutomationScheduleBlockProps = Readonly<{
  idPrefix: string;
  label: string;
  value: AutomationBlock;
  onChange: (next: AutomationBlock) => void;
}>;

export function AutomationScheduleBlock({
  idPrefix,
  label,
  value,
  onChange,
}: AutomationScheduleBlockProps) {
  const set = (patch: Partial<AutomationBlock>) =>
    onChange({ ...value, ...patch });

  const changeCount = (raw: string) => {
    const n = Number.parseInt(raw, 10);
    set({ every: { unit: value.every.unit, n: Number.isFinite(n) ? n : 1 } });
  };

  // Carrying a weekday into a monthly schedule silently misfires the job, so
  // the unit and its Run On value always move together.
  const changeUnit = (raw: string) => {
    const unit = raw as AutomationUnit;
    set({
      every: { unit, n: value.every.n },
      runOn: defaultRunOnForUnit(unit),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Switch
          id={`${idPrefix}-enabled`}
          checked={value.enabled}
          onCheckedChange={(checked) => set({ enabled: checked })}
        />
        <Label htmlFor={`${idPrefix}-enabled`} className="text-[13px] font-semibold">
          Enable automatic generation
        </Label>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <AutomationField id={`${idPrefix}-every-n`} label={label}>
          <div className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-every-n`}
              type="number"
              min={1}
              value={value.every.n}
              onChange={(event) => changeCount(event.target.value)}
              className="min-w-0 flex-1"
            />
            <OptionSelect
              id={`${idPrefix}-every-unit`}
              ariaLabel="Generate Every Unit"
              value={value.every.unit}
              options={UNIT_OPTIONS}
              className="min-w-0 flex-1"
              onValueChange={changeUnit}
            />
          </div>
        </AutomationField>

        <RunOnFields
          idPrefix={idPrefix}
          unit={value.every.unit}
          runOn={value.runOn}
          onChange={(runOn) => set({ runOn })}
        />

        <AutomationField id={`${idPrefix}-run-at`} label="Run At">
          <Input
            id={`${idPrefix}-run-at`}
            type="time"
            value={value.runAt}
            onChange={(event) => set({ runAt: event.target.value })}
          />
        </AutomationField>

        <AutomationField id={`${idPrefix}-start-date`} label="Start Date">
          <Input
            id={`${idPrefix}-start-date`}
            type="date"
            value={value.startDate ?? ""}
            onChange={(event) => set({ startDate: event.target.value || null })}
          />
        </AutomationField>

        <AutomationField
          id={`${idPrefix}-next-run`}
          label="Next Run"
          hint="Calculated by the scheduler — read-only."
        >
          <Input
            id={`${idPrefix}-next-run`}
            readOnly
            value={value.nextRun ?? "—"}
            className="bg-muted"
          />
        </AutomationField>
      </div>
    </div>
  );
}
