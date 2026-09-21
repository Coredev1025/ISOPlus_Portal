"use client";

import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_EMAIL_MESSAGE,
  EMAIL_MESSAGE_FIELD,
  EMAIL_TEMPLATE_VARIABLE_HINT,
  EMAIL_TEXT_FIELDS,
  RECIPIENT_OPTIONS,
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
}>;

function EmailTextField({
  id,
  label,
  value,
  isEmail,
  allowsList,
  onChange,
}: EmailTextFieldProps) {
  // Send a Copy To takes several addresses; every other address field names
  // one mailbox. Matches the Save gate and the API.
  const accepts = allowsList ? isEmailAddressList(value) : EMAIL_PATTERN.test(value);
  const invalid = isEmail && value !== "" && !accepts;
  const errorId = `${id}-error`;

  return (
    <AutomationField id={id} label={label}>
      <Input
        id={id}
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        type={isEmail ? "email" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
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
  /** Differs per block: statements cannot be sent from the accounting platform. */
  sendMethodOptions: readonly AutomationSelectOption[];
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
      <AutomationField id={`${idPrefix}-recipient`} label="Recipient">
        <OptionSelect
          id={`${idPrefix}-recipient`}
          ariaLabel="Recipient"
          value={value.recipient}
          options={RECIPIENT_OPTIONS}
          onValueChange={(next) =>
            set({ recipient: next as AutomationBlock["recipient"] })
          }
        />
      </AutomationField>

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

      {EMAIL_TEXT_FIELDS.map((field) => (
        <EmailTextField
          key={field.key}
          id={`${idPrefix}-${field.id}`}
          label={field.label}
          value={value[field.key]}
          isEmail={field.isEmail}
          allowsList={field.allowsList}
          onChange={setText(field.key)}
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
