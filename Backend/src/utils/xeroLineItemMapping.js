import {
  XERO_DEFAULT_COGS_ACCOUNT_CODE,
  XERO_DEFAULT_EXPENSE_TAX_TYPE,
  XERO_DEFAULT_INCOME_TAX_TYPE,
  XERO_DEFAULT_SALES_ACCOUNT_CODE,
  XERO_DEFAULT_TAX_RATE_PERCENT,
} from '../constants/xeroMapping.js';

export const XERO_DOC_TYPES = ['quote', 'purchaseOrder', 'invoice'];

export const XERO_QUOTE_OVERRIDE_KINDS = ['quoteService', 'material'];

export const XERO_LINE_ITEM_TAX_DEFAULTS = {
  // Used when Finance Settings has no mapping and the board line is taxable (10% GST).
  // Connect-seeded mapping defaults are GST-free (EXEMPTOUTPUT / EXEMPTEXPENSES) — different.
  quote: { taxType: 'OUTPUT' },
  purchaseOrder: { taxType: 'INPUT' },
  invoice: { taxType: 'OUTPUT' },
};

/** Board-GST tax-free fallback when Finance Settings has no mapped taxType. */
export const XERO_TAX_FREE_DEFAULTS = {
  quote: XERO_DEFAULT_INCOME_TAX_TYPE,
  purchaseOrder: XERO_DEFAULT_EXPENSE_TAX_TYPE,
  invoice: XERO_DEFAULT_INCOME_TAX_TYPE,
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
 * The rate a mapped taxType charges: the percentage stored alongside it
 * (enriched from Xero's own tax rates when the mapping was saved), or the one
 * its code implies. Null when neither is known — a custom Xero tax type whose
 * rate this code cannot judge.
 */
function mappedRatePercent(mapping) {
  return toRatePercent(mapping.taxRatePercent)
    ?? inferTaxRatePercentFromTaxType(mapping.taxType);
}

/**
 * Whether a mapped taxType may be applied to THIS line.
 *
 * One-directional, deliberately. A Finance Settings mapping is a default for a
 * document type, not a per-line fact, and 'OUTPUT' is the sensible thing to map
 * a sales invoice to — so it was being applied to every line, including NDIS
 * supports whose own row says GST Free. Those synced to Xero at 10% GST: the
 * client is over-charged, and the provider has charged GST on a GST-free
 * support.
 *
 * The reverse is left alone. A mapping that charges no GST on a line the board
 * says is taxable is under-charging, which is also wrong — but it is a choice
 * somebody made explicitly, and `quoteOverrides.material` exists to make
 * exactly that choice for one kind of line. Overriding a deliberate exemption
 * would break a configured feature; refusing to invent GST cannot.
 *
 * A blank `gstValue` is no evidence at all, not evidence of exemption, so the
 * mapping stands.
 */
function mappedTaxTypeAppliesTo(mapping, gstValue) {
  const mapped = cleanString(mapping.taxType);
  if (!mapped) return false;
  if (!cleanString(gstValue) || isGstApplied(gstValue)) return true;

  // The line is explicitly GST-free. Only a zero-rated mapping may stand; an
  // unknown rate is honoured rather than second-guessed.
  const rate = mappedRatePercent(mapping);
  return rate == null || rate === 0;
}

/**
 * Resolve Account Code + TaxType for a Xero line.
 * An explicit Finance Settings mapping wins wherever it can be true of the line
 * (see mappedTaxTypeAppliesTo); otherwise board GST selects taxable vs tax-free
 * defaults (and options.unmappedTaxFreeType for NDIS).
 */
export function resolveLineItemTax(business, docType, gstValue, lineKind, options = {}) {
  const mapping = pickMappingForResolve(business, docType, lineKind);
  const taxType = mappedTaxTypeAppliesTo(mapping, gstValue)
    ? cleanString(mapping.taxType)
    : resolveUnmappedTaxType(docType, gstValue, options);

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

function isDocMappingEmpty(doc) {
  return !cleanString(doc?.accountCode) && !cleanString(doc?.taxType);
}

export function isLineItemMappingEmpty(mapping) {
  const normalized = normalizeLineItemMapping(mapping);
  return XERO_DOC_TYPES.every((docType) => isDocMappingEmpty(normalized[docType]));
}

export function buildDefaultLineItemMapping() {
  const sales = {
    accountCode: XERO_DEFAULT_SALES_ACCOUNT_CODE,
    taxType: XERO_DEFAULT_INCOME_TAX_TYPE,
    taxRatePercent: XERO_DEFAULT_TAX_RATE_PERCENT,
  };
  return normalizeLineItemMapping({
    quote: sales,
    invoice: sales,
    purchaseOrder: {
      accountCode: XERO_DEFAULT_COGS_ACCOUNT_CODE,
      taxType: XERO_DEFAULT_EXPENSE_TAX_TYPE,
      taxRatePercent: XERO_DEFAULT_TAX_RATE_PERCENT,
    },
  });
}

export function ensureDefaultLineItemMapping(existing) {
  if (!isLineItemMappingEmpty(existing)) {
    return normalizeLineItemMapping(existing);
  }
  return buildDefaultLineItemMapping();
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
