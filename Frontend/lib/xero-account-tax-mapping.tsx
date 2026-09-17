"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import axios from "@/app/utils/axiosConfig";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  showErrorToast,
  showSaveErrorToast,
  showSaveSuccessToast,
} from "@/lib/toast-utils";
import {
  isCanceledError,
  isExpectedMissingIntegrationData,
  xeroOptionsLoadDescription,
} from "@/lib/xero-integration-errors";
import {
  normalizeMapping,
  accountsForDocumentKind,
  taxRatesForDocumentKind,
  buildDefaultLineItemMapping,
  isLineItemMappingEmpty,
  type XeroAccountOption,
  type XeroDocMapping,
  type XeroDocumentKind,
  type XeroLineItemMapping,
  type XeroQuoteOverrideKind,
  type XeroTaxRateOption,
} from "@/lib/xero-account-tax-mapping-options";

export { EMPTY_LINE_ITEM_MAPPING } from "@/lib/xero-account-tax-mapping-options";
export { normalizeMapping };

const USE_DEFAULT = "__default__";

type MappingSelectProps = Readonly<{
  label: string;
  value: string;
  placeholder: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (next: string) => void;
}>;

function MappingSelect({
  label,
  value,
  placeholder,
  options,
  disabled,
  onChange,
}: MappingSelectProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select
        disabled={disabled}
        value={value === "" ? undefined : value}
        onValueChange={(next) => onChange(next === USE_DEFAULT ? "" : next)}
      >
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={USE_DEFAULT}>Select…</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

type AccountTaxPairProps = Readonly<{
  doc: XeroDocMapping;
  kind: XeroDocumentKind;
  accounts: XeroAccountOption[];
  taxRates: XeroTaxRateOption[];
  disabled: boolean;
  onChange: (patch: Partial<XeroDocMapping>) => void;
}>;

function AccountTaxPair({
  doc,
  kind,
  accounts,
  taxRates,
  disabled,
  onChange,
}: AccountTaxPairProps) {
  const scopedAccounts = accountsForDocumentKind(accounts, kind, doc.accountCode);
  const availableTaxRates = taxRatesForDocumentKind(taxRates, kind, doc.taxType);
  const accountOptions = scopedAccounts.map((account) => ({
    value: account.code,
    label: account.name ? `${account.code} – ${account.name}` : account.code,
  }));
  const taxOptions = availableTaxRates.map((rate) => ({
    value: rate.taxType,
    label: rate.name ?? rate.taxType,
  }));

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <MappingSelect
        label="Account"
        value={doc.accountCode}
        placeholder={accountOptions.length ? "Select account" : "No accounts available"}
        options={accountOptions}
        disabled={disabled}
        onChange={(v) => onChange({ accountCode: v })}
      />
      <MappingSelect
        label="Tax Rate"
        value={doc.taxType}
        placeholder={taxOptions.length ? "Select tax rate" : "No tax rates available"}
        options={taxOptions}
        disabled={disabled}
        onChange={(v) => {
          const rate = availableTaxRates.find((r) => r.taxType === v);
          onChange({
            taxType: v,
            taxRatePercent: rate?.effectiveRate ?? null,
          });
        }}
      />
    </div>
  );
}

const QUOTE_OVERRIDE_ROWS: {
  key: XeroQuoteOverrideKind;
  label: string;
}[] = [
  { key: "quoteService", label: "Quote Service" },
  { key: "material", label: "Material" },
];

type QuoteOverrideRowProps = Readonly<{
  label: string;
  kind: XeroQuoteOverrideKind;
  doc: XeroDocMapping;
  accounts: XeroAccountOption[];
  taxRates: XeroTaxRateOption[];
  disabled: boolean;
  onChange: (kind: XeroQuoteOverrideKind, patch: Partial<XeroDocMapping>) => void;
}>;

function QuoteOverrideRow({
  label,
  kind,
  doc,
  accounts,
  taxRates,
  disabled,
  onChange,
}: QuoteOverrideRowProps) {
  const scopedAccounts = accountsForDocumentKind(
    accounts,
    "quote",
    doc.accountCode
  );
  const rowTaxRates = taxRatesForDocumentKind(taxRates, "quote", doc.taxType);

  return (
    <tr className="border-b last:border-b-0">
      <td className="px-3 py-2 font-medium">{label}</td>
      <td className="px-3 py-2">
        <Select
          disabled={disabled}
          value={doc.accountCode === "" ? USE_DEFAULT : doc.accountCode}
          onValueChange={(next) =>
            onChange(kind, {
              accountCode: next === USE_DEFAULT ? "" : next,
            })
          }
        >
          <SelectTrigger className="h-8">
            <SelectValue placeholder="Use quote default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={USE_DEFAULT}>Use quote default</SelectItem>
            {scopedAccounts.map((account) => (
              <SelectItem key={account.code} value={account.code}>
                {account.name ? `${account.code} – ${account.name}` : account.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      <td className="px-3 py-2">
        <Select
          disabled={disabled}
          value={doc.taxType === "" ? USE_DEFAULT : doc.taxType}
          onValueChange={(next) => {
            if (next === USE_DEFAULT) {
              onChange(kind, { taxType: "", taxRatePercent: null});
              return;
            }
            const rate = rowTaxRates.find((r) => r.taxType === next);
            onChange(kind, {
              taxType: next,
              taxRatePercent: rate?.effectiveRate ?? null
            });
          }}
        >
          <SelectTrigger className="h-8">
            <SelectValue placeholder="Use quote default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={USE_DEFAULT}>Use quote default</SelectItem>
            {rowTaxRates.map((rate) => (
              <SelectItem key={rate.taxType} value={rate.taxType}>
                {rate.name ?? rate.taxType}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
    </tr>
  );
}

type XeroAccountTaxMappingProps = Readonly<{
  workspaceId: string;
  isConnected: boolean;
  initialMapping: XeroLineItemMapping;
  onMappingSaved: (mapping: XeroLineItemMapping) => void;
  onOptionsLoadFailed?: () => void;
}>;

export function XeroAccountTaxMapping({
  workspaceId,
  isConnected,
  initialMapping,
  onMappingSaved,
  onOptionsLoadFailed,
}: XeroAccountTaxMappingProps) {
  const [mapping, setMapping] = useState<XeroLineItemMapping>(initialMapping);
  const [accounts, setAccounts] = useState<XeroAccountOption[]>([]);
  const [taxRates, setTaxRates] = useState<XeroTaxRateOption[]>([]);
  const [isLoadingOptions, setIsLoadingOptions] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const onOptionsLoadFailedRef = useRef(onOptionsLoadFailed);
  onOptionsLoadFailedRef.current = onOptionsLoadFailed;
  const onMappingSavedRef = useRef(onMappingSaved);
  onMappingSavedRef.current = onMappingSaved;
  const mappingRef = useRef(mapping);
  mappingRef.current = mapping;

  useEffect(() => {
    setMapping(initialMapping);
  }, [initialMapping]);

  useEffect(() => {
    if (!isConnected) {
      setAccounts([]);
      setTaxRates([]);
      setIsLoadingOptions(false);
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();

    const load = async () => {
      setIsLoadingOptions(true);
      try {
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/xero/account-tax-options`,
          { params: { workspaceId }, signal: abortController.signal }
        );
        if (cancelled) return;
        setAccounts(response.data?.accounts || []);
        setTaxRates(response.data?.taxRates || []);

        // Backfill connect defaults for already-linked workspaces with an empty mapping.
        if (!isLineItemMappingEmpty(mappingRef.current)) return;
        try {
          const payload = buildDefaultLineItemMapping();
          const savedResponse = await axios.put(
            `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/xero/line-item-mapping`,
            { workspaceId, mapping: payload }
          );
          if (cancelled) return;
          const saved = normalizeMapping(
            savedResponse.data?.xeroLineItemMapping || payload
          );
          setMapping(saved);
          onMappingSavedRef.current(saved);
        } catch {
          // Options loaded; seed is best-effort.
        }
      } catch (error: unknown) {
        if (cancelled) return;
        if (isCanceledError(error)) return;
        if (isExpectedMissingIntegrationData(error)) {
          setAccounts([]);
          setTaxRates([]);
          return;
        }
        onOptionsLoadFailedRef.current?.();
        showErrorToast("Failed to load Xero accounts/tax rates", {
          description: xeroOptionsLoadDescription(error),
        });
      } finally {
        if (!cancelled) setIsLoadingOptions(false);
      }
    };

    load();
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [isConnected, workspaceId]);

  const updateDoc = useCallback(
    (
      docKey: "quote" | "purchaseOrder" | "invoice",
      patch: Partial<XeroDocMapping>
    ) => {
      setMapping((prev) => ({
        ...prev,
        [docKey]: { ...prev[docKey], ...patch },
      }));
    },
    []
  );

  const updateOverride = useCallback(
    (kind: XeroQuoteOverrideKind, patch: Partial<XeroDocMapping>) => {
      setMapping((prev) => ({
        ...prev,
        quoteOverrides: {
          ...prev.quoteOverrides,
          [kind]: { ...prev.quoteOverrides[kind], ...patch },
        },
      }));
    },
    []
  );

  const handleSave = useCallback(async () => {
    try {
      setIsSaving(true);
      const payload = normalizeMapping(mapping);
      const response = await axios.put(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/xero/line-item-mapping`,
        { workspaceId, mapping: payload }
      );
      const saved = normalizeMapping(response.data?.xeroLineItemMapping || payload);
      setMapping(saved);
      onMappingSaved(saved);
      showSaveSuccessToast("Account & tax mapping");
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      showSaveErrorToast(
        "Account & tax mapping",
        err.response?.data?.message
      );
    } finally {
      setIsSaving(false);
    }
  }, [mapping, onMappingSaved, workspaceId]);

  const disabled = !isConnected || isLoadingOptions;

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <h5 className="text-[13px] font-bold">Default account &amp; tax mapping</h5>
        </div>
        <p className="text-[12.5px] text-muted-foreground">
          Sets the Xero account code and tax rate ISO+™ uses when creating each synced
          document type.
        </p>
        {!isConnected ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Connect to Xero to load accounts and tax rates.
          </p>
        ) : null}
        {isLoadingOptions ? (
          <p className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading Xero accounts and tax rates…
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          Quote
        </div>
        <AccountTaxPair
          doc={mapping.quote}
          kind="quote"
          accounts={accounts}
          taxRates={taxRates}
          disabled={disabled}
          onChange={(patch) => updateDoc("quote", patch)}
        />
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Line-item type</th>
                <th className="px-3 py-2 font-semibold">Account code</th>
                <th className="px-3 py-2 font-semibold">Tax type</th>
              </tr>
            </thead>
            <tbody>
              {QUOTE_OVERRIDE_ROWS.map((row) => (
                <QuoteOverrideRow
                  key={row.key}
                  label={row.label}
                  kind={row.key}
                  doc={mapping.quoteOverrides[row.key]}
                  accounts={accounts}
                  taxRates={taxRates}
                  disabled={disabled}
                  onChange={updateOverride}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          Purchase Order
        </div>
        <AccountTaxPair
          doc={mapping.purchaseOrder}
          kind="purchaseOrder"
          accounts={accounts}
          taxRates={taxRates}
          disabled={disabled}
          onChange={(patch) => updateDoc("purchaseOrder", patch)}
        />
      </div>

      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          Invoice
        </div>
        <AccountTaxPair
          doc={mapping.invoice}
          kind="invoice"
          accounts={accounts}
          taxRates={taxRates}
          disabled={disabled}
          onChange={(patch) => updateDoc("invoice", patch)}
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!isConnected || isSaving}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save mapping
        </Button>
      </div>
    </div>
  );
}
