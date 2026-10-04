import mongoose from 'mongoose';

import {
  INVOICE_KIND,
  INVOICE_ORIGIN,
  INVOICE_SOURCE,
  INVOICE_STATUS,
  INVOICE_TRIGGER,
} from '../constants/invoiceLedger.js';

const { Schema } = mongoose;

/**
 * One invoice (KAN-302), the record screens and documents read, replacing the
 * three older places an invoice's identity lived (the item marker, the `pdflinks`
 * ledger rows and the `invoicenumbers` log). It lists the items it covers, so an
 * item can be on more than one invoice over time, which is what re-invoicing
 * (KAN-289) will need.
 *
 * Design: docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md,
 * section 4.1. This schema declares no indexes. The unique index on (workspace,
 * source, number, duplicateOrdinal) and the lookup indexes are built by
 * migrations/1791102300000-invoice-ledger-indexes.js, like the `pdflinks`
 * constraint, so they exist only once that migration has run: run it BEFORE
 * switching INVOICE_LEDGER_WRITE on. `commitInvoice` refuses to write without the
 * unique index, because the upsert is only idempotent under it.
 *
 * The documents themselves (the PDF, its delivery state) stay on `pdflinks`; those
 * rows carry `invoiceId` back to this record.
 */

const lineSchema = new Schema({
  itemId: { type: String, required: true },
  // What this item contributed to the invoice's total, as billed.
  amount: { type: Number, default: 0 },
}, { _id: false });

const participantSchema = new Schema({
  // The Participant Profile reference, the grouping key from KAN-293.
  profileId: { type: String },
  // The statement matches on board and name today, so both are kept.
  name: { type: String },
}, { _id: false });

const InvoiceSchema = new Schema({
  workspaceId: { type: String, required: true },
  boardId: { type: String },

  // The plain number, with no suffix: INV-24, INV-0001.
  number: { type: String, required: true },
  source: { type: String, enum: Object.values(INVOICE_SOURCE), default: INVOICE_SOURCE.PORTAL },
  // Every string this invoice has been known by (INV-24 (ISO+™), INV-0001 (Xero)),
  // so old links and lookups resolve and nothing parses a suffix again.
  legacyNumbers: { type: [String], default: [] },
  // Zero for the invoice that owns the number. A backfilled invoice that shares a
  // number with a different real invoice gets 1, 2, ... so the unique index still
  // holds. NOT a boolean: a partial index cannot test for an absent field, and a
  // default of false would be stored on every document.
  duplicateOrdinal: { type: Number, default: 0 },

  kind: { type: String, enum: Object.values(INVOICE_KIND), required: true },
  // Age Care only. Decides what `total` means: Low Cat bills the full service
  // amount, every other Age Care board bills the participant contribution.
  lowCat: { type: Boolean },

  participant: { type: participantSchema },
  lines: { type: [lineSchema], default: [] },

  // The billed total as the document printed it.
  total: { type: Number },
  // Set only on a backfilled invoice whose total was recomputed from its items
  // because no document total exists. No default: absent means "as printed".
  totalDerived: { type: Boolean },
  issuedAt: { type: Date },
  dueDate: { type: Date },

  // Automated runs only.
  periodKey: { type: String },
  periodStart: { type: Date },
  periodEnd: { type: Date },
  trigger: { type: String, enum: Object.values(INVOICE_TRIGGER) },
  // The provisional claim token this invoice was issued under. `repairInvoice`
  // takes over a pending marker only when it is exactly this token, so it can never
  // take a claim another run holds. Absent on backfilled invoices.
  claimToken: { type: String },

  status: { type: String, enum: Object.values(INVOICE_STATUS), default: INVOICE_STATUS.ISSUED },
  // Empty until KAN-289 decides how re-invoicing works; they exist so that
  // decision needs no schema change.
  voidedAt: { type: Date },
  voidReason: { type: String },
  supersededBy: { type: Schema.Types.ObjectId },

  pdf: {
    pdfLink: { type: String },
    fileKey: { type: String },
  },
  // Further PDFs for the same invoice, for example a hand-regenerated copy.
  extraPdfLinks: { type: [String], default: undefined },

  // Set when the invoice has been pushed to Xero as a draft. Replaces
  // pdflinks.xeroInvoiceNumber as the duplicate-draft guard.
  xero: {
    invoiceNumber: { type: String },
    id: { type: String },
  },

  origin: { type: String, enum: Object.values(INVOICE_ORIGIN), default: INVOICE_ORIGIN.LIVE },
  // Backfilled invoices only: why this invoice was created and anything the
  // prefill could not place. The reason values belong to the backfill script.
  backfill: {
    reason: { type: String },
    notes: { type: [String], default: undefined },
  },
}, { timestamps: true });

export default mongoose.models.Invoice || mongoose.model('Invoice', InvoiceSchema);
