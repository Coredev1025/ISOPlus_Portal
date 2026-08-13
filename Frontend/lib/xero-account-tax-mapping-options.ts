export type XeroAccountOption = {
  code: string;
  name: string;
  type: string;
  class: string;
  status: string;
};

export type XeroTaxRateOption = {
  taxType: string;
  name: string;
  status: string;
  canApplyToRevenue: boolean;
  canApplyToExpenses: boolean;
  effectiveRate: number | null;
};

export type XeroDocMapping = {
  accountCode: string;
  taxType: string;
  taxRatePercent: number | null;
};

export type XeroQuoteOverrideKind = "quoteService" | "material";

export type XeroLineItemMapping = {
  quote: XeroDocMapping;
  purchaseOrder: XeroDocMapping;
  invoice: XeroDocMapping;
  quoteOverrides: Record<XeroQuoteOverrideKind, XeroDocMapping>;
};

const EMPTY_DOC: XeroDocMapping = {
  accountCode: "",
  taxType: "",
  taxRatePercent: null
};

export const EMPTY_LINE_ITEM_MAPPING: XeroLineItemMapping = {
  quote: { ...EMPTY_DOC },
  purchaseOrder: { ...EMPTY_DOC },
  invoice: { ...EMPTY_DOC },
  quoteOverrides: {
    quoteService: { ...EMPTY_DOC },
    material: { ...EMPTY_DOC },
  },
};

function pickDoc(d?: Partial<XeroDocMapping>): XeroDocMapping {
  const rate =
    typeof d?.taxRatePercent === "number" && Number.isFinite(d.taxRatePercent)
      ? d.taxRatePercent
      : null;
  return {
    accountCode: d?.accountCode ?? "",
    taxType: d?.taxType ?? "",
    taxRatePercent: rate,
  };
}

const EMPTY_RAW_MAPPING = Object.freeze({});

export function normalizeMapping(raw: unknown): XeroLineItemMapping {
  const m = (raw ?? EMPTY_RAW_MAPPING) as Partial<XeroLineItemMapping> & {
    quoteOverrides?: Partial<Record<XeroQuoteOverrideKind, Partial<XeroDocMapping>>>;
  };
  return {
    quote: pickDoc(m.quote),
    purchaseOrder: pickDoc(m.purchaseOrder),
    invoice: pickDoc(m.invoice),
    quoteOverrides: {
      quoteService: pickDoc(m.quoteOverrides?.quoteService),
      material: pickDoc(m.quoteOverrides?.material),
    },
  };
}

export function accountClass(account: XeroAccountOption): string {
  return (account.class ?? "").toUpperCase();
}

export function taxRatesForAccount(
  taxRates: XeroTaxRateOption[],
  account: XeroAccountOption | undefined
): XeroTaxRateOption[] {
  if (!account) return [];
  const isExpense = accountClass(account) === "EXPENSE";
  return taxRates.filter((rate) =>
    isExpense ? rate.canApplyToExpenses : rate.canApplyToRevenue
  );
}

export type XeroDocumentKind = "quote" | "purchaseOrder" | "invoice";

/**
 * Prefer REVENUE accounts for Quote/Invoice and EXPENSE for Purchase Order.
 * If a saved code falls outside that class, keep it in the list so the UI can
 * still display the current mapping.
 *
 * Touchpoints: xero-account-tax-mapping.tsx (AccountTaxPair, QuoteOverrideRow).
 */
export function accountsForDocumentKind(
  accounts: readonly XeroAccountOption[],
  kind: XeroDocumentKind,
  selectedCode = ""
): XeroAccountOption[] {
  const preferred = kind === "purchaseOrder" ? "EXPENSE" : "REVENUE";
  const filtered = accounts.filter(
    (account) => accountClass(account) === preferred
  );
  if (!selectedCode) return filtered;

  const alreadyIncluded = filtered.some((account) => account.code === selectedCode);
  if (alreadyIncluded) return filtered;

  const selected = accounts.find((account) => account.code === selectedCode);
  return selected ? [...filtered, selected] : filtered;
}

export function prepareMappingForSave(
  mapping: XeroLineItemMapping
): XeroLineItemMapping {
  return normalizeMapping(mapping);
}
