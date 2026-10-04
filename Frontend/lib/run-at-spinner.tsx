"use client";

import { useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  parseRunAt,
  stepRunAt,
  toRunAt,
  type RunAtField,
  type RunAtParts,
} from "@/lib/run-at-time";

/**
 * Run At, styled on the ISO+ "Scheduled Shift Start Date & Time" picker the
 * client pointed at (KAN-263): a field showing the time that opens a panel of
 * hour : minute spinners with up/down arrows and Cancel / Select — plus the
 * AM/PM column the ISO+ one lacks and the client asked for.
 *
 * The arrows edit a draft. Only Select hands a value back, as `HH:mm` on the
 * 24-hour clock the backend validates; Cancel, Escape and clicking away drop
 * the draft, so an abandoned panel cannot retime a client's automation.
 */
export function RunAtSpinner({
  id,
  value,
  onChange,
}: Readonly<{
  id: string;
  value: string;
  onChange: (next: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RunAtParts>(() => parseRunAt(value));

  // Every opening starts from the stored value, never a previous draft.
  const onOpenChange = (next: boolean) => {
    if (next) setDraft(parseRunAt(value));
    setOpen(next);
  };
  const step = (field: RunAtField, direction: 1 | -1) =>
    setDraft((current) => stepRunAt(current, field, direction));
  const select = () => {
    onChange(toRunAt(draft));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          aria-label="Run At"
          className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span>{formatRunAt(parseRunAt(value))}</span>
          <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-4" aria-label="Choose the Run At time">
        <div className="flex items-center justify-center gap-3">
          <SpinColumn label="Hour" value={draft.hour} onStep={(d) => step("hour", d)} />
          <span aria-hidden="true" className="pb-1 text-4xl font-light">
            :
          </span>
          <SpinColumn label="Minute" value={draft.minute} onStep={(d) => step("minute", d)} />
          <SpinColumn
            label="AM or PM"
            value={draft.meridiem}
            onStep={(d) => step("meridiem", d)}
            className="ml-2"
          />
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="text-sm">{formatRunAt(draft)}</span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={select}>
              Select
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** "9:05 AM" — how the field and the panel footer both read the time. */
function formatRunAt({ hour, minute, meridiem }: RunAtParts): string {
  return `${hour}:${minute} ${meridiem}`;
}

const ARROW_STEPS: Record<string, 1 | -1> = { ArrowUp: 1, ArrowDown: -1 };

/**
 * One spinner column: up arrow, the value, down arrow. The value itself is the
 * focusable spinbutton, so the keyboard arrows step it without the mouse.
 */
function SpinColumn({
  label,
  value,
  onStep,
  className,
}: Readonly<{
  label: string;
  value: string;
  onStep: (direction: 1 | -1) => void;
  className?: string;
}>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = ARROW_STEPS[event.key];
    if (!direction) return;
    event.preventDefault();
    onStep(direction);
  };

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Increase ${label.toLowerCase()}`}
        onClick={() => onStep(1)}
      >
        <ChevronUp className="h-5 w-5 text-muted-foreground" />
      </Button>
      <div
        role="spinbutton"
        tabIndex={0}
        aria-label={label}
        aria-valuetext={value}
        onKeyDown={onKeyDown}
        className="min-w-[3ch] rounded-md text-center text-4xl font-light tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {value}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Decrease ${label.toLowerCase()}`}
        onClick={() => onStep(-1)}
      >
        <ChevronDown className="h-5 w-5 text-muted-foreground" />
      </Button>
    </div>
  );
}
