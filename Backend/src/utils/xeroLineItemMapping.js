export const XERO_DOC_TYPES = ['quote', 'purchaseOrder', 'invoice'];

export const XERO_QUOTE_OVERRIDE_KINDS = ['quoteService', 'material'];

export const XERO_LINE_ITEM_TAX_DEFAULTS = {
  quote: { taxType: 'OUTPUT', taxFreeType: 'EXEMPTOUTPUT' },
  purchaseOrder: { taxType: 'INPUT', taxFreeType: 'EXEMPTEXPENSES' },
  invoice: { taxType: 'OUTPUT', taxFreeType: 'EXEMPTOUTPUT' }
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDocMapping(src) {
  const input = src && typeof src === 'object' ? src : {};
  return {
    accountCode: cleanString(input.accountCode),
    taxType: cleanString(input.taxType),
    taxFreeType: cleanString(input.taxFreeType)
  };
}

export function isGstApplied(gstValue) {
  return String(gstValue ?? '').trim() === '10%';
}

function pickMappingForResolve(business, docType, lineKind) {
  const root = business?.xeroLineItemMapping || {};
  const docMapping = root[docType] || {};
  if (docType !== 'quote' || !lineKind) return docMapping;
  if (!XERO_QUOTE_OVERRIDE_KINDS.includes(lineKind)) return docMapping;
  const override = root.quoteOverrides?.[lineKind];
  if (!override || typeof override !== 'object') return docMapping;
  return {
    accountCode: cleanString(override.accountCode) || docMapping.accountCode,
    taxType: cleanString(override.taxType) || docMapping.taxType,
    taxFreeType: cleanString(override.taxFreeType) || docMapping.taxFreeType
  };
}

export function resolveLineItemTax(business, docType, gstValue, lineKind) {
  const mapping = pickMappingForResolve(business, docType, lineKind);
  const defaults = XERO_LINE_ITEM_TAX_DEFAULTS[docType] || {};
  const taxType = isGstApplied(gstValue)
    ? (mapping.taxType || defaults.taxType)
    : (mapping.taxFreeType || defaults.taxFreeType);
  return {
    accountCode: mapping.accountCode || undefined,
    taxType
  };
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
