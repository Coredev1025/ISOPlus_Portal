/**
 * Schema default for invoice, purchase order, quote, statement, and
 * statement-of-account sequences.
 *
 * `statement` (STM-) is claimed by monthly budget statement automation
 * (`generateStatements.allocateStatementNumber`). It is not editable in Finance
 * Settings or Business Settings. Clients must omit it on PUT. A profile save
 * never writes a `nextNumber` for an existing business (KAN-290); it writes only
 * prefixes (`documentNumberingSetPaths`). `statementOfAccount` (SOA-) is the
 * series whose prefix operators configure in Finance Settings.
 *
 * Touchpoints: models/Business.js, Frontend/lib/configure-business-helpers.ts,
 * Frontend/lib/financial-settings-panel.tsx, configure-business page (omit on save).
 */
export const DEFAULT_DOCUMENT_NEXT_NUMBER = 1;

/**
 * The numbering series a business has. A profile save writes a series by name
 * into a database path, so only these names are accepted (KAN-290).
 *
 * Touchpoints: utils/businessProfileUpdate.js (documentNumberingSetPaths).
 */
export const DOCUMENT_SERIES = [
  'invoice',
  'purchaseOrder',
  'quote',
  'statement',
  'statementOfAccount',
];
