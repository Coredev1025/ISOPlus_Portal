"use client";

import { Input } from "@/components/ui/input";
import { RichTextEditor } from "@/lib/rich-text-editor";
import {
  EMAIL_TEXT_FIELDS,
  RECIPIENT_OPTIONS,
  SEND_METHOD_OPTIONS,
} from "@/constants/automation";
import { EMAIL_PATTERN } from "@/constants/validation";
import { AutomationField, OptionSelect } from "@/lib/automation-schedule-block";
import type { AutomationBlock } from "@/lib/automation-settings";

type TextFieldKey = (typeof EMAIL_TEXT_FIELDS)[number]["key"];

type EmailTextFieldProps = Readonly<{
  id: string;
  label: string;
  value: string;
  isEmail: boolean;
  multiline: boolean;
  onChange: (next: string) => void;
}>;

function EmailTextField({
  id,
  label,
  value,
  isEmail,
  multiline,
  onChange,
}: EmailTextFieldProps) {
  const invalid = isEmail && value !== "" && !EMAIL_PATTERN.test(value);
  const errorId = `${id}-error`;
  const inputProps = {
    id,
    value,
    "aria-invalid": invalid || undefined,
    "aria-describedby": invalid ? errorId : undefined,
  };

  return (
    // Body text truncates in a third-width one-liner, so a multiline field
    // spans the grid and grows to a rich text editor — the spec calls Email
    // Message a rich-text field, and the composed email sends its HTML.
    <AutomationField
      id={id}
      label={label}
      className={multiline ? "md:col-span-3" : undefined}
    >
      {multiline ? (
        <RichTextEditor
          id={id}
          ariaLabel={label}
          value={value}
          onChange={onChange}
        />
      ) : (
        <Input
          {...inputProps}
          type={isEmail ? "email" : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
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
  value: AutomationBlock;
  onChange: (next: AutomationBlock) => void;
}>;

export function AutomationEmailBlock({
  idPrefix,
  value,
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
          options={SEND_METHOD_OPTIONS}
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
          multiline={field.multiline}
          onChange={setText(field.key)}
        />
      ))}
    </div>
  );
}
