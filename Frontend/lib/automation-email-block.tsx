"use client";

import dynamic from "next/dynamic";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_EMAIL_MESSAGE,
  DEFAULT_EMAIL_SUBJECT,
  EMAIL_MESSAGE_FIELD,
  EMAIL_TEMPLATE_VARIABLE_HINT,
  EMAIL_TEXT_FIELDS,
  type AutomationKind,
} from "@/constants/automation";
import { EMAIL_PATTERN, isEmailAddressList } from "@/constants/validation";
import {
  AutomationField,
  OptionSelect,
  type AutomationSelectOption,
} from "@/lib/automation-schedule-block";
import type { AutomationBlock } from "@/lib/automation-settings";

/**
 * TipTap is ~100-130KB gzipped for one field in one tab of Finance Settings.
 * Loaded statically every visitor downloads it to reach a tab most never open;
 * here it arrives only once a block is enabled. ssr: false because TipTap has
 * to wait for the client anyway (`immediatelyRender: false`).
 */
const RichTextEditor = dynamic(
  () => import("@/lib/rich-text-editor").then((mod) => mod.RichTextEditor),
  { ssr: false },
);

type TextFieldKey =
  | (typeof EMAIL_TEXT_FIELDS)[number]["key"]
  | typeof EMAIL_MESSAGE_FIELD.key;

type EmailTextFieldProps = Readonly<{
  id: string;
  label: string;
  value: string;
  isEmail: boolean;
  /** The field takes several comma-separated addresses rather than one. */
  allowsList?: boolean;
  onChange: (next: string) => void;
  /**
   * Only Email Subject carries this (KAN-269): a per-field "Reset to default"
   * icon button beside the input, distinct from Email Message's own reset so
   * the two never share an accessible name in the same section.
   */
  onReset?: () => void;
  /**
   * The reset button's accessible name. Deliberately *not* built from `label`
   * ("Email Subject"): `getByLabelText` also matches on `aria-label`, so a
   * name containing the field's own label text would make the input and the
   * reset button indistinguishable to that query.
   */
  resetLabel?: string;
}>;

function EmailTextField({
  id,
  label,
  value,
  isEmail,
  allowsList,
  onChange,
  onReset,
  resetLabel,
}: EmailTextFieldProps) {
  // Send a Copy To takes several addresses; every other address field names
  // one mailbox. Matches the Save gate and the API.
  const accepts = allowsList ? isEmailAddressList(value) : EMAIL_PATTERN.test(value);
  const invalid = isEmail && value !== "" && !accepts;
  const errorId = `${id}-error`;

  return (
    <AutomationField id={id} label={label}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          type={isEmail ? "email" : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={onReset ? "flex-1" : undefined}
        />
        {onReset ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground"
            aria-label={resetLabel ?? "Reset field to default"}
            onClick={onReset}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
      {invalid ? (
        <p id={errorId} className="text-[11px] text-destructive">
          Enter a valid email address.
        </p>
      ) : null}
    </AutomationField>
  );
}

type AutomationEmailBlockProps = Readonly<{
  idPrefix: string;
  /** Decides which single system variable this block offers, and its copy. */
  kind: AutomationKind;
  value: AutomationBlock;
  /**
   * The Send Method choices. Only the invoice block passes them: an invoice can be
   * sent from ISO+ or raised in the accounting platform. A statement is always
   * sent from ISO+ (KAN-299), so it passes none and shows no Send Method control.
   */
  sendMethodOptions?: readonly AutomationSelectOption[];
  onChange: (next: AutomationBlock) => void;
}>;

export function AutomationEmailBlock({
  idPrefix,
  kind,
  value,
  sendMethodOptions,
  onChange,
}: AutomationEmailBlockProps) {
  const set = (patch: Partial<AutomationBlock>) =>
    onChange({ ...value, ...patch });

  const setText = (key: TextFieldKey) => (next: string) =>
    set({ [key]: next });

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {/* KAN-272: the manual "Recipient" selector (Billing Contact |
          Client/Participant) is removed — recipient/address resolution is
          now derived purely from ISO+ profile data (Case A/AA/B). */}
      {sendMethodOptions ? (
        <AutomationField id={`${idPrefix}-send-method`} label="Send Method">
          <OptionSelect
            id={`${idPrefix}-send-method`}
            ariaLabel="Send Method"
            value={value.sendMethod}
            options={sendMethodOptions}
            onValueChange={(next) =>
              set({ sendMethod: next as AutomationBlock["sendMethod"] })
            }
          />
        </AutomationField>
      ) : null}

      {EMAIL_TEXT_FIELDS.map((field) => (
        <EmailTextField
          key={field.key}
          id={`${idPrefix}-${field.id}`}
          label={field.label}
          value={value[field.key]}
          isEmail={field.isEmail}
          allowsList={field.allowsList}
          onChange={setText(field.key)}
          onReset={
            field.key === "emailSubject"
              ? () => setText(field.key)(DEFAULT_EMAIL_SUBJECT[kind])
              : undefined
          }
          resetLabel={field.key === "emailSubject" ? "Reset subject to default" : undefined}
        />
      ))}

      <AutomationField
        id={`${idPrefix}-${EMAIL_MESSAGE_FIELD.id}`}
        label={EMAIL_MESSAGE_FIELD.label}
        className="md:col-span-3"
        labelFor={false}
      >
        <RichTextEditor
          id={`${idPrefix}-${EMAIL_MESSAGE_FIELD.id}`}
          ariaLabel={EMAIL_MESSAGE_FIELD.label}
          value={value[EMAIL_MESSAGE_FIELD.key]}
          onChange={setText(EMAIL_MESSAGE_FIELD.key)}
        />

        {/* The guide sits directly under the box, which is where the client
            asked for it, and names only the one variable this block can
            actually resolve. Reset sits beside it rather than above the
            editor so it reads as an escape hatch, not a primary action. */}
        <div className="mt-2 flex items-start justify-between gap-4">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {EMAIL_TEMPLATE_VARIABLE_HINT[kind]}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setText(EMAIL_MESSAGE_FIELD.key)(DEFAULT_EMAIL_MESSAGE[kind])}
          >
            Reset to default
          </Button>
        </div>
      </AutomationField>
    </div>
  );
}
