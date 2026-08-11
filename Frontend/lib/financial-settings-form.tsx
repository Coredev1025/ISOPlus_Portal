"use client";

import { useState, type ReactNode } from "react";
import { AlertCircle, Hash, Landmark } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CREDIT_NOTE_SEQUENCE_DISPLAY,
  type NumberSequence,
} from "@/lib/configure-business-helpers";

export type DocumentSequenceType =
  | "invoice"
  | "purchaseOrder"
  | "quote"
  | "statement";

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
  disabled?: boolean;
  badge?: ReactNode;
}>;

function Field({
  id,
  label,
  children,
  hint,
  disabled = false,
  badge,
}: FieldProps) {
  return (
    <div className={`space-y-1.5 ${disabled ? "opacity-60" : ""}`}>
      <Label
        htmlFor={id}
        className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"
      >
        {label}
        {badge}
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
  disabled?: boolean;
  badge?: ReactNode;
  onPrefixChange?: (value: string) => void;
  onNextChange?: (value: string) => void;
}>;

function SequenceField({
  label,
  prefixId,
  nextId,
  sequence,
  hint,
  disabled = false,
  badge,
  onPrefixChange,
  onNextChange,
}: SequenceFieldProps) {
  return (
    <Field id={prefixId} label={label} hint={hint} disabled={disabled} badge={badge}>
      <div className="flex items-center gap-2">
        <Input
          id={prefixId}
          value={sequence.prefix}
          onChange={(e) => onPrefixChange?.(e.target.value)}
          placeholder="Prefix"
          disabled={disabled}
          className="min-w-0 flex-1"
        />
        <span className="text-muted-foreground">/</span>
        <Input
          id={nextId}
          type="number"
          value={sequence.nextNumber}
          onChange={(e) => onNextChange?.(e.target.value)}
          min={1}
          disabled={disabled}
          className="min-w-0 flex-1"
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
  onSequenceNextChange: (type: DocumentSequenceType, value: number) => void;
  onRestoreDefaults: () => void;
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
  onSequenceNextChange,
  onRestoreDefaults,
  onSave,
}: FinancialSettingsFormProps) {
  const [alertDialog, setAlertDialog] = useState<{
    isOpen: boolean;
    type: DocumentSequenceType;
    newValue: number;
  }>({
    isOpen: false,
    type: "invoice",
    newValue: 0,
  });

  const handleNextNumberChange = (
    type: DocumentSequenceType,
    value: string
  ) => {
    const newValue = parseInt(value, 10);
    if (!Number.isFinite(newValue)) return;

    if (newValue < sequences[type].nextNumber) {
      setAlertDialog({ isOpen: true, type, newValue });
      return;
    }
    onSequenceNextChange(type, newValue);
  };

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
            description="Configure prefixes and next numbers for financial documents."
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <SequenceField
              label="Invoice Numbers"
              prefixId="invoice-prefix"
              nextId="invoice-next"
              sequence={sequences.invoice}
              onPrefixChange={(v) => onSequencePrefixChange("invoice", v)}
              onNextChange={(v) => handleNextNumberChange("invoice", v)}
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
              onNextChange={(v) => handleNextNumberChange("purchaseOrder", v)}
              hint={`Next: ${sequences.purchaseOrder.prefix}${sequences.purchaseOrder.nextNumber}`}
            />
            <SequenceField
              label="Quote Numbers"
              prefixId="quote-prefix"
              nextId="quote-next"
              sequence={sequences.quote}
              onPrefixChange={(v) => onSequencePrefixChange("quote", v)}
              onNextChange={(v) => handleNextNumberChange("quote", v)}
              hint={`Next: ${sequences.quote.prefix}${sequences.quote.nextNumber}`}
            />
          </div>

          <div className="my-[18px] h-px bg-border" />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <SequenceField
              label="Statement Numbers"
              prefixId="statement-prefix"
              nextId="statement-next"
              sequence={sequences.statement}
              onPrefixChange={(v) => onSequencePrefixChange("statement", v)}
              onNextChange={(v) => handleNextNumberChange("statement", v)}
              hint={`Feeds Statement Automation → next: ${sequences.statement.prefix}${sequences.statement.nextNumber}`}
              badge={
                <Badge
                  variant="secondary"
                  className="bg-emerald-50 text-[10px] uppercase tracking-wide text-emerald-700"
                >
                  new
                </Badge>
              }
            />
            <SequenceField
              label="Credit Note Numbers"
              prefixId="credit-note-prefix"
              nextId="credit-note-next"
              sequence={CREDIT_NOTE_SEQUENCE_DISPLAY}
              disabled
              hint="Shown for completeness — no Credit Note feature yet"
              badge={
                <Badge
                  variant="outline"
                  className="text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  later phase
                </Badge>
              }
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
              variant="outline"
              onClick={onRestoreDefaults}
              disabled={loading}
            >
              Restore Defaults
            </Button>
            <Button type="button" onClick={onSave} disabled={loading}>
              {loading ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </Card>
      </div>

      <AlertDialog
        open={alertDialog.isOpen}
        onOpenChange={(open) =>
          setAlertDialog((prev) => ({ ...prev, isOpen: open }))
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Warning: Reducing Number Sequence
            </AlertDialogTitle>
            <AlertDialogDescription>
              Reducing the next number may result in duplicate document numbers
              if previous numbers have been used. Are you sure you want to
              continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onSequenceNextChange(alertDialog.type, alertDialog.newValue);
                setAlertDialog((prev) => ({ ...prev, isOpen: false }));
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
