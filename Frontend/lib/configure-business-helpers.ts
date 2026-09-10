import { DEFAULT_BUSINESS_TIMEZONE } from "@/constants/timezone";

export function mapBusinessProfileToFormData(data: Record<string, any>, workspaceId: string) {
  return {
    name: data.name || '',
    phone: data.phone || '',
    email: data.email || '',
    companyRegistrationId: data.companyRegistrationId || '',
    street: data.address?.street || '',
    country: data.address?.country || '',
    suburb: data.address?.suburb || '',
    state: data.address?.state || '',
    postcode: data.address?.postcode || '',
    abn: data.abn || '',
    acn: data.acn || '',
    workspaceId,
    bankAccountName: data.bankDetails?.accountName || '',
    bankName: data.bankDetails?.bankName || '',
    bsb: data.bankDetails?.bsb || '',
    accountNumber: data.bankDetails?.accountNumber || '',
    paymentReference: data.bankDetails?.paymentReference || '',
    accountsReceivableTerms: data.bankDetails?.accountsReceivableTerms || '',
    accountsPayableTerms: data.bankDetails?.accountsPayableTerms || '',
    headOfficeTimezone: (data.headOfficeTimezone as string) || DEFAULT_BUSINESS_TIMEZONE,
  };
}

export type NumberSequence = {
  prefix: string;
  nextNumber: number;
};

export const DEFAULT_SEQUENCES: Record<
  "invoice" | "purchaseOrder" | "quote" | "statement" | "statementOfAccount",
  NumberSequence
> = {
  invoice: { prefix: "INV-", nextNumber: 1 },
  purchaseOrder: { prefix: "PO-", nextNumber: 1 },
  quote: { prefix: "QT-", nextNumber: 1 },
  statement: { prefix: "STM-", nextNumber: 1 },
  // Its own series. The two statement types shared one until a client asked
  // why two documents numbered one apart were different things.
  statementOfAccount: { prefix: "SOA-", nextNumber: 1 },
};

function toSequence(
  value: Partial<NumberSequence> | null | undefined,
  fallback: NumberSequence
): NumberSequence {
  return {
    prefix: typeof value?.prefix === "string" ? value.prefix : fallback.prefix,
    nextNumber:
      typeof value?.nextNumber === "number" &&
      Number.isInteger(value.nextNumber) &&
      value.nextNumber >= 0
        ? value.nextNumber
        : fallback.nextNumber,
  };
}

export function extractDocumentNumberingSequences(data: Record<string, any>) {
  const numbering = data.documentNumbering || {};
  return {
    invoice: toSequence(numbering.invoice, DEFAULT_SEQUENCES.invoice),
    purchaseOrder: toSequence(
      numbering.purchaseOrder,
      DEFAULT_SEQUENCES.purchaseOrder
    ),
    quote: toSequence(numbering.quote, DEFAULT_SEQUENCES.quote),
    statement: toSequence(numbering.statement, DEFAULT_SEQUENCES.statement),
    statementOfAccount: toSequence(
      numbering.statementOfAccount,
      DEFAULT_SEQUENCES.statementOfAccount
    ),
  };
}

export const CREDIT_NOTE_SEQUENCE_DISPLAY: NumberSequence = {
  prefix: "CN-",
  nextNumber: 1,
};

export function cloneDefaultSequences() {
  return {
    invoice: { ...DEFAULT_SEQUENCES.invoice },
    purchaseOrder: { ...DEFAULT_SEQUENCES.purchaseOrder },
    quote: { ...DEFAULT_SEQUENCES.quote },
    statement: { ...DEFAULT_SEQUENCES.statement },
    statementOfAccount: { ...DEFAULT_SEQUENCES.statementOfAccount },
  };
}
