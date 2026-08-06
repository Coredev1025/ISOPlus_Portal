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
};

export type XeroDocMapping = {
  accountCode: string;
  taxType: string;
  taxFreeType: string;
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
  taxFreeType: "",
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

const TAX_FREE_DEFAULTS: Record<"quote" | "purchaseOrder" | "invoice", string> =
  {
    quote: "EXEMPTOUTPUT",
    purchaseOrder: "EXEMPTEXPENSES",
    invoice: "EXEMPTOUTPUT",
  };

function pickDoc(d?: Partial<XeroDocMapping>): XeroDocMapping {
  return {
    accountCode: d?.accountCode ?? "",
    taxType: d?.taxType ?? "",
    taxFreeType: d?.taxFreeType ?? "",
  };
}

export function normalizeMapping(raw: unknown): XeroLineItemMapping {
  const m = (raw ?? {}) as Partial<XeroLineItemMapping> & {
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

export function withDefaultTaxFreeType(
  doc: XeroDocMapping,
  docType: "quote" | "purchaseOrder" | "invoice"
): XeroDocMapping {
  if (doc.taxFreeType) return doc;
  return { ...doc, taxFreeType: TAX_FREE_DEFAULTS[docType] };
}

export function prepareMappingForSave(
  mapping: XeroLineItemMapping
): XeroLineItemMapping {
  return {
    quote: withDefaultTaxFreeType(mapping.quote, "quote"),
    purchaseOrder: withDefaultTaxFreeType(mapping.purchaseOrder, "purchaseOrder"),
    invoice: withDefaultTaxFreeType(mapping.invoice, "invoice"),
    quoteOverrides: {
      quoteService: withDefaultTaxFreeType(
        mapping.quoteOverrides.quoteService,
        "quote"
      ),
      material: withDefaultTaxFreeType(mapping.quoteOverrides.material, "quote"),
    },
  };
}
