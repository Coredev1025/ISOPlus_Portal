"use client";

import { Input } from "@/components/ui/input";
import {
  AutomationField,
  OptionSelect,
  type AutomationSelectOption,
} from "@/lib/automation-schedule-block";
import type { AutomationBlock } from "@/lib/automation-settings";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RECIPIENT_OPTIONS: readonly AutomationSelectOption[] = [
  { value: "billing_contact", label: "Billing Contact" },
  { value: "client_participant", label: "Client / Participant" },
];

const SEND_METHOD_OPTIONS: readonly AutomationSelectOption[] = [
  { value: "isoplus", label: "Send from ISO+" },
  { value: "accounting", label: "Send from Accounting Platform" },
];

type TextFieldKey =
  | "sendCopyTo"
  | "replyTo"
  | "emailFrom"
  | "emailSubject"
  | "emailMessage";

type TextFieldSpec = Readonly<{
  key: TextFieldKey;
  id: string;
  label: string;
  /** Only address-valued fields are checked against EMAIL_PATTERN. */
  isEmail: boolean;
}>;

const TEXT_FIELDS: readonly TextFieldSpec[] = [
  { key: "sendCopyTo", id: "send-copy-to", label: "Send a Copy To", isEmail: true },
  { key: "replyTo", id: "reply-to", label: "Reply-to Email", isEmail: true },
  { key: "emailFrom", id: "email-from", label: "Email From", isEmail: true },
  { key: "emailSubject", id: "email-subject", label: "Email Subject", isEmail: false },
  { key: "emailMessage", id: "email-message", label: "Email Message", isEmail: false },
];

type EmailTextFieldProps = Readonly<{
  id: string;
  label: string;
  value: string;
  isEmail: boolean;
  onChange: (next: string) => void;
}>;

function EmailTextField({
  id,
  label,
  value,
  isEmail,
  onChange,
}: EmailTextFieldProps) {
  const invalid = isEmail && value !== "" && !EMAIL_PATTERN.test(value);
  const errorId = `${id}-error`;

  return (
    <AutomationField id={id} label={label}>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
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

      {TEXT_FIELDS.map((field) => (
        <EmailTextField
          key={field.key}
          id={`${idPrefix}-${field.id}`}
          label={field.label}
          value={value[field.key]}
          isEmail={field.isEmail}
          onChange={setText(field.key)}
        />
      ))}
    </div>
  );
}
