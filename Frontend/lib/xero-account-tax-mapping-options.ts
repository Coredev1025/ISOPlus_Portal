import {
  XERO_DEFAULT_COGS_ACCOUNT_CODE,
  XERO_DEFAULT_EXPENSE_TAX_TYPE,
  XERO_DEFAULT_INCOME_TAX_TYPE,
  XERO_DEFAULT_SALES_ACCOUNT_CODE,
  XERO_DEFAULT_TAX_RATE_PERCENT,
} from "@/constants/xeroMapping";

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

export type XeroDocumentKind = "quote" | "purchaseOrder" | "invoice";

export type XeroLineItemMapping = {
  quote: XeroDocMapping;
  purchaseOrder: XeroDocMapping;
  invoice: XeroDocMapping;
  quoteOverrides: Record<XeroQuoteOverrideKind, XeroDocMapping>;
};

const EMPTY_DOC: XeroDocMapping = {
  accountCode: "",
  taxType: "",
  taxRatePercent: null,
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

function isDocMappingEmpty(doc: XeroDocMapping): boolean {
  return !doc.accountCode && !doc.taxType;
}

/** True when quote / PO / invoice have no account or tax chosen (overrides ignored). */
export function isLineItemMappingEmpty(mapping: XeroLineItemMapping): boolean {
  return (
    isDocMappingEmpty(mapping.quote) &&
    isDocMappingEmpty(mapping.purchaseOrder) &&
    isDocMappingEmpty(mapping.invoice)
  );
}

/** AU chart defaults persisted on connect — real Select values, not placeholders. */
export function buildDefaultLineItemMapping(): XeroLineItemMapping {
  const sales: XeroDocMapping = {
    accountCode: XERO_DEFAULT_SALES_ACCOUNT_CODE,
    taxType: XERO_DEFAULT_INCOME_TAX_TYPE,
    taxRatePercent: XERO_DEFAULT_TAX_RATE_PERCENT,
  };
  return {
    quote: { ...sales },
    invoice: { ...sales },
    purchaseOrder: {
      accountCode: XERO_DEFAULT_COGS_ACCOUNT_CODE,
      taxType: XERO_DEFAULT_EXPENSE_TAX_TYPE,
      taxRatePercent: XERO_DEFAULT_TAX_RATE_PERCENT,
    },
    quoteOverrides: {
      quoteService: { ...EMPTY_DOC },
      material: { ...EMPTY_DOC },
    },
  };
}

function selectedOrEmpty(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function pickDoc(d: Partial<XeroDocMapping> | undefined): XeroDocMapping {
  const rate =
    typeof d?.taxRatePercent === "number" && Number.isFinite(d.taxRatePercent)
      ? d.taxRatePercent
      : null;
  return {
    accountCode: selectedOrEmpty(d?.accountCode),
    taxType: selectedOrEmpty(d?.taxType),
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

/**
 * Prefer expense tax types for Purchase Order and revenue types for Quote/Invoice.
 * If a saved tax type falls outside that set, keep it so the UI can show it.
 *
 * Touchpoints: xero-account-tax-mapping.tsx (AccountTaxPair, QuoteOverrideRow).
 */
export function taxRatesForDocumentKind(
  taxRates: readonly XeroTaxRateOption[],
  kind: XeroDocumentKind,
  selectedTaxType = ""
): XeroTaxRateOption[] {
  const forExpenses = kind === "purchaseOrder";
  const filtered = taxRates.filter((rate) =>
    forExpenses ? rate.canApplyToExpenses : rate.canApplyToRevenue
  );
  if (!selectedTaxType) return filtered;

  const alreadyIncluded = filtered.some((rate) => rate.taxType === selectedTaxType);
  if (alreadyIncluded) return filtered;

  const selected = taxRates.find((rate) => rate.taxType === selectedTaxType);
  return selected ? [...filtered, selected] : filtered;
}

/**
 * Prefer REVENUE accounts for Quote/Invoice and EXPENSE for Purchase Order.
 * If a saved code falls outside that class, keep it so the UI can show it.
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
