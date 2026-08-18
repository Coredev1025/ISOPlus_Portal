export const XERO_DOC_TYPES = ['quote', 'purchaseOrder', 'invoice'];

export const XERO_QUOTE_OVERRIDE_KINDS = ['quoteService', 'material'];

export const XERO_LINE_ITEM_TAX_DEFAULTS = {
  quote: { taxType: 'OUTPUT' },
  purchaseOrder: { taxType: 'INPUT' },
  invoice: { taxType: 'OUTPUT' },
};

/** Board-GST tax-free fallback when Finance Settings has no mapped taxType. */
export const XERO_TAX_FREE_DEFAULTS = {
  quote: 'EXEMPTOUTPUT',
  purchaseOrder: 'EXEMPTEXPENSES',
  invoice: 'EXEMPTOUTPUT',
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toRatePercent(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeDocMapping(src) {
  const input = src && typeof src === 'object' ? src : {};
  const rate = toRatePercent(input.taxRatePercent);
  return {
    accountCode: cleanString(input.accountCode),
    taxType: cleanString(input.taxType),
    taxRatePercent: rate == null ? null : rate,
  };
}

export function isGstApplied(gstValue) {
  return String(gstValue ?? '').trim() === '10%';
}

function pickMappingForResolve(business, docType, lineKind) {
  const root = business?.xeroLineItemMapping || {};
  const docMapping = root[docType] || {};
  if (
    docType !== 'quote'
    || !lineKind
    || !XERO_QUOTE_OVERRIDE_KINDS.includes(lineKind)
  ) {
    return docMapping;
  }
  const override = root.quoteOverrides?.[lineKind];
  if (!override || typeof override !== 'object') return docMapping;
  return {
    accountCode: cleanString(override.accountCode) || docMapping.accountCode,
    taxType: cleanString(override.taxType) || docMapping.taxType,
    taxRatePercent:
      toRatePercent(override.taxRatePercent) ?? toRatePercent(docMapping.taxRatePercent),
  };
}

function resolveUnmappedTaxType(docType, gstValue, options = {}) {
  const taxableDefault = XERO_LINE_ITEM_TAX_DEFAULTS[docType]?.taxType || 'OUTPUT';
  const taxFreeDefault =
    cleanString(options.unmappedTaxFreeType)
    || XERO_TAX_FREE_DEFAULTS[docType]
    || 'EXEMPTOUTPUT';

  if (isGstApplied(gstValue)) return taxableDefault;
  return taxFreeDefault;
}

export function inferTaxRatePercentFromTaxType(taxType) {
  const code = cleanString(taxType).toUpperCase();
  if (!code) return null;
  if (code.includes('EXEMPT') || code === 'NONE' || code === 'BASEXCLUDED') return 0;
  if (
    code === 'OUTPUT'
    || code === 'INPUT'
    || code.startsWith('OUTPUT')
    || code.startsWith('INPUT')
  ) {
    return 10;
  }
  return null;
}

export function lookupTaxRatePercent(taxRates, taxType) {
  const code = cleanString(taxType);
  if (!code || !Array.isArray(taxRates)) return null;
  const match = taxRates.find(
    (rate) => cleanString(rate.taxType || rate.TaxType) === code
  );
  if (!match) return null;
  return (
    toRatePercent(match.effectiveRate)
    ?? toRatePercent(match.EffectiveRate)
    ?? toRatePercent(match.displayTaxRate)
    ?? toRatePercent(match.DisplayTaxRate)
  );
}

/**
 * Resolve Account Code + TaxType for a Xero line.
 * Explicit Finance Settings mapping wins; otherwise board GST selects
 * taxable vs tax-free defaults (and options.unmappedTaxFreeType for NDIS).
 */
export function resolveLineItemTax(business, docType, gstValue, lineKind, options = {}) {
  const mapping = pickMappingForResolve(business, docType, lineKind);
  const mappedTaxType = cleanString(mapping.taxType);
  const taxType = mappedTaxType || resolveUnmappedTaxType(docType, gstValue, options);

  return {
    accountCode: cleanString(mapping.accountCode) || undefined,
    taxType: taxType || undefined,
  };
}

export function pickGstValue(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const normalized = String(candidate).trim();
    if (normalized) return normalized;
  }
  return '';
}

function resolveFallbackAccountCode(accounts, options = {}) {
  const fallbackType = options.fallbackAccountType || 'REVENUE';
  const typed = accounts?.find((acc) => acc.Type === fallbackType)?.Code;
  if (typed) return typed;
  if (options.requireAccountCode) return undefined;
  if (Object.hasOwn(options, 'defaultAccountCode')) {
    return options.defaultAccountCode || undefined;
  }
  return undefined;
}

export function resolveSalesLineMapping(
  business,
  docType,
  gstValue,
  accounts,
  lineKind,
  options = {}
) {
  const resolved = resolveLineItemTax(business, docType, gstValue, lineKind, options);
  const accountCode =
    resolved.accountCode || resolveFallbackAccountCode(accounts, options);
  return { accountCode, taxType: resolved.taxType };
}

export function normalizeLineItemMapping(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const docType of XERO_DOC_TYPES) {
    out[docType] = normalizeDocMapping(src[docType]);
  }
  const overridesSrc =
    src.quoteOverrides && typeof src.quoteOverrides === 'object'
      ? src.quoteOverrides
      : {};
  out.quoteOverrides = {};
  for (const kind of XERO_QUOTE_OVERRIDE_KINDS) {
    out.quoteOverrides[kind] = normalizeDocMapping(overridesSrc[kind]);
  }
  return out;
}

export function enrichMappingWithTaxRatePercents(mapping, taxRates) {
  const next = normalizeLineItemMapping(mapping);
  const fill = (doc) => {
    if (!doc.taxType) return doc;
    if (doc.taxRatePercent != null) return doc;
    const lookedUp = lookupTaxRatePercent(taxRates, doc.taxType);
    const inferred = inferTaxRatePercentFromTaxType(doc.taxType);
    return {
      ...doc,
      taxRatePercent: lookedUp ?? inferred ?? null,
    };
  };
  return {
    quote: fill(next.quote),
    purchaseOrder: fill(next.purchaseOrder),
    invoice: fill(next.invoice),
    quoteOverrides: {
      quoteService: fill(next.quoteOverrides.quoteService),
      material: fill(next.quoteOverrides.material),
    },
  };
}
