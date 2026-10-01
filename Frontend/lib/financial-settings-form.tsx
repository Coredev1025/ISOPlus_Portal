"use client";

import { type ReactNode } from "react";
import { Hash, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type NumberSequence } from "@/lib/configure-business-helpers";

export type DocumentSequenceType =
  | "invoice"
  | "purchaseOrder"
  | "quote"
  | "statement"
  | "statementOfAccount";

export type DocumentSequences = Record<DocumentSequenceType, NumberSequence>;

export type BankDetailsForm = {
  bankName: string;
  bankAccountName: string;
  bsb: string;
  accountNumber: string;
  accountsReceivableTerms: string;
  accountsPayableTerms: string;
};

type FieldProps = Readonly<{
  id: string;
  label: string;
  children: ReactNode;
  hint?: string;
}>;

function Field({
  id,
  label,
  children,
  hint,
}: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label
        htmlFor={id}
        className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"
      >
        {label}
      </Label>
      {children}
      {hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

type CardHeaderBlockProps = Readonly<{
  icon: ReactNode;
  title: string;
  description: string;
}>;

function CardHeaderBlock({
  icon,
  title,
  description,
}: CardHeaderBlockProps) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
      <div>
        <h3 className="text-[14.5px] font-bold leading-tight">{title}</h3>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

type SequenceFieldProps = Readonly<{
  label: string;
  prefixId: string;
  nextId: string;
  sequence: NumberSequence;
  hint: string;
  onPrefixChange?: (value: string) => void;
}>;

/**
 * KAN-290: the next number is shown but cannot be edited. A counter is advanced
 * only by the generators that issue the numbers; typing one here let an operator
 * (or a page opened before invoices were issued) set it to a number already in
 * use. The server ignores a next number for an existing business as well.
 */
function SequenceField({
  label,
  prefixId,
  nextId,
  sequence,
  hint,
  onPrefixChange,
}: SequenceFieldProps) {
  return (
    <Field id={prefixId} label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Input
          id={prefixId}
          value={sequence.prefix}
          onChange={(e) => onPrefixChange?.(e.target.value)}
          placeholder="Prefix"
          className="min-w-0 flex-1"
        />
        <span className="text-muted-foreground">/</span>
        <Input
          id={nextId}
          type="number"
          value={sequence.nextNumber}
          readOnly
          disabled
          aria-readonly="true"
          title="Assigned automatically; it cannot be edited here"
          className="min-w-0 flex-1 cursor-not-allowed bg-muted text-muted-foreground"
        />
      </div>
    </Field>
  );
}

type FinancialSettingsFormProps = Readonly<{
  bankDetails: BankDetailsForm;
  sequences: DocumentSequences;
  loading: boolean;
  errors: string[];
  apiError: string;
  showSuccess: boolean;
  onBankChange: (field: keyof BankDetailsForm, value: string) => void;
  onSequencePrefixChange: (type: DocumentSequenceType, value: string) => void;
  onSave: () => void;
}>;

export function FinancialSettingsForm({
  bankDetails,
  sequences,
  loading,
  errors,
  apiError,
  showSuccess,
  onBankChange,
  onSequencePrefixChange,
  onSave,
}: FinancialSettingsFormProps) {
  return (
    <>
      <div className="space-y-[18px]">
        <Card className="border p-5 shadow-sm">
          <CardHeaderBlock
            icon={<Landmark className="h-4 w-4" />}
            title="Bank Details"
            description="These details appear on your invoices and statements for receiving payments."
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field id="bankName" label="Bank Name">
              <Input
                id="bankName"
                placeholder="Enter bank name"
                value={bankDetails.bankName}
                onChange={(e) => onBankChange("bankName", e.target.value)}
              />
            </Field>
            <Field id="bankAccountName" label="Account Name">
              <Input
                id="bankAccountName"
                value={bankDetails.bankAccountName}
                onChange={(e) =>
                  onBankChange("bankAccountName", e.target.value)
                }
                placeholder="Enter account name"
              />
            </Field>
            <Field
              id="accountsReceivableTerms"
              label="Accounts Receivable Payment Terms"
            >
              <Input
                id="accountsReceivableTerms"
                placeholder="When clients are expected to pay you"
                value={bankDetails.accountsReceivableTerms}
                onChange={(e) =>
                  onBankChange("accountsReceivableTerms", e.target.value)
                }
              />
            </Field>
            <Field id="bsb" label="BSB">
              <Input
                id="bsb"
                placeholder="Enter BSB"
                value={bankDetails.bsb}
                onChange={(e) => onBankChange("bsb", e.target.value)}
                maxLength={6}
              />
            </Field>
            <Field id="accountNumber" label="Account Number">
              <Input
                id="accountNumber"
                placeholder="Enter account number"
                value={bankDetails.accountNumber}
                onChange={(e) =>
                  onBankChange("accountNumber", e.target.value)
                }
              />
            </Field>
            <Field
              id="accountsPayableTerms"
              label="Accounts Payable Payment Terms"
            >
              <Input
                id="accountsPayableTerms"
                placeholder="When your business pays contractors or suppliers"
                value={bankDetails.accountsPayableTerms}
                onChange={(e) =>
                  onBankChange("accountsPayableTerms", e.target.value)
                }
              />
            </Field>
          </div>
        </Card>

        <Card className="border p-5 shadow-sm">
          <CardHeaderBlock
            icon={<Hash className="h-4 w-4" />}
            title="Document Number Configuration"
            description="Configure the prefix for each financial document. Next numbers are assigned automatically and cannot be edited."
          />

          <div
            data-testid="document-numbering-grid"
            className="grid grid-cols-1 gap-4 md:grid-cols-2"
          >
            <SequenceField
              label="Invoice Numbers"
              prefixId="invoice-prefix"
              nextId="invoice-next"
              sequence={sequences.invoice}
              onPrefixChange={(v) => onSequencePrefixChange("invoice", v)}
              hint={`Next: ${sequences.invoice.prefix}${sequences.invoice.nextNumber}`}
            />
            <SequenceField
              label="Purchase Order Numbers"
              prefixId="po-prefix"
              nextId="po-next"
              sequence={sequences.purchaseOrder}
              onPrefixChange={(v) =>
                onSequencePrefixChange("purchaseOrder", v)
              }
              hint={`Next: ${sequences.purchaseOrder.prefix}${sequences.purchaseOrder.nextNumber}`}
            />
            <SequenceField
              label="Quote Numbers"
              prefixId="quote-prefix"
              nextId="quote-next"
              sequence={sequences.quote}
              onPrefixChange={(v) => onSequencePrefixChange("quote", v)}
              hint={`Next: ${sequences.quote.prefix}${sequences.quote.nextNumber}`}
            />
            <SequenceField
              label="Statement of Account Numbers"
              prefixId="statement-of-account-prefix"
              nextId="statement-of-account-next"
              sequence={sequences.statementOfAccount}
              onPrefixChange={(v) =>
                onSequencePrefixChange("statementOfAccount", v)
              }
              hint={`Next: ${sequences.statementOfAccount.prefix}${sequences.statementOfAccount.nextNumber}`}
            />
          </div>

          {errors.length > 0 && (
            <div className="mt-4 rounded-md border border-destructive bg-destructive/10 p-4">
              <h4 className="mb-2 text-sm font-medium text-destructive">
                Please correct the following errors:
              </h4>
              <ul className="list-inside list-disc space-y-1">
                {errors.map((error) => (
                  <li key={error} className="text-sm text-destructive">
                    {error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {apiError ? (
            <div className="mt-4 rounded-md border border-destructive bg-destructive/10 p-4">
              <p className="text-sm text-destructive">{apiError}</p>
            </div>
          ) : null}

          {showSuccess ? (
            <div className="mt-4 rounded-md border border-green-500 bg-green-100 p-4">
              <p className="text-sm text-green-700">
                Financial settings saved successfully!
              </p>
            </div>
          ) : null}

          <div className="mt-4 flex justify-end gap-2.5">
            <Button
              type="button"
              onClick={onSave}
              disabled={loading}
            >
              {loading ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
