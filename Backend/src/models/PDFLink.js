import  mongoose from 'mongoose';

import { DELIVERY_STATES, DELIVERY_STATE_GENERATED } from '../constants/automation.js';

const Schema = mongoose.Schema;

const PDFLinkSchema = new Schema({
    itemId: {
        type: String,
        required: true
    },
    workspaceId: {
        type: String,
        required: true
    },
    pdfLink: {
        type: String,
        required: true
    },
    SignatureStatus: {
        type: String,
        default: 'Unsigned'
    },
    type: {
        type: String,
        required: true
    },
    isDeleted: {
        type: Boolean,
        default: false
    },
    createdBy: {
        type: String,
        default: ""
    },
    // Written by the automation generators only. Without it a slot lookup keyed
    // on workspace + periodKey matches every board fanned out on that slot, and
    // one board's invoices are returned (and emailed) as another's. Optional
    // because the UI generators and webhook paths do not set it.
    boardId: { type: String },
    // The invoice's participant, kept so a re-run that reads this row instead of
    // the generator list can still resolve the email's {{client_name}}.
    participant: { type: String },
    periodKey: { type: String },
    // ── The period this document covers (invoice selection spec, 3.2) ───────
    // periodKey is the slot's identity and is what the replay lookup matches
    // on; these two are the actual bounds the selection ran against, kept so a
    // billing query ("what window produced this invoice") can be answered from
    // the document rather than by re-deriving it from the schedule, which may
    // since have changed cadence.
    periodStart: { type: Date },
    periodEnd: { type: Date },
    // Which of the five invoice types' conditions selected the items on this
    // document — one of the INVOICE_TYPE_* values in constants/invoiceSelection.js.
    // Distinct from `type`, which is the document kind (NDIS Invoice, Age Care
    // Invoice, Monthly Statement).
    invoiceType: { type: String },
    // The figure this document billed, as a number. Written by the scheduled
    // generators, which are the only paths that know it: the Age Care total is
    // the participant contribution on most boards and the full service amount
    // on Low Cat, so it cannot be re-derived from the items without
    // replicating that branch. Section 4.2 of the invoice selection spec asks
    // the statement to carry the billed figure through unchanged, and this is
    // where it is carried.
    invoiceTotal: { type: Number },
    invoiceNumber: { type: String },
    // The date the document itself carries — the slot a scheduled run billed,
    // or the `Invoice Date` an operator set on the item before generating by
    // hand. Distinct from `createdAt`, which is when this row was written; the
    // two coincide only for a run that fires on time. The statement of account
    // dates its charge rows by this, so a held slot, a catch-up or a
    // deliberately backdated invoice is reported on the day the invoice
    // claims rather than the day the record happened to be created. Absent on
    // every row written before it existed, and `statementAccountHistory.js`
    // falls back to `createdAt` for those.
    invoiceDate: { type: Date },
    // The number Xero gave the DRAFT this document was pushed as, when the
    // workspace's send method is 'accounting'. It is the idempotency key for
    // that route: a replayed slot hands the worker the same documents, and
    // without a persisted marker each replay would create another draft in the
    // client's accountant's Xero. Declared here because Mongoose strict mode
    // silently drops a $set for a path the schema does not know.
    xeroInvoiceNumber: { type: String },
    createdAt: {
        type: Date,
        default: Date.now
    },
    // ── Email delivery, written by services/email/deliveryEvents.js ──────────
    // The id of the message that carried this document, normalised (no angle
    // brackets, lowercased). It is the only handle an SES event arriving
    // minutes later has on the documents the email contained, so the send
    // stamps it and the SQS events consumer looks up by it. Its index is
    // created by a migration, not declared here — the house style for this
    // collection, matching automation_slot_lookup.
    deliveryMessageId: { type: String },
    // Where that message got to. `generated` — the default — means no send has
    // been recorded, which is a legitimate state, not a failure.
    deliveryState: {
        type: String,
        enum: DELIVERY_STATES,
        default: DELIVERY_STATE_GENERATED
    },
    // A sentence the client can act on ("Email address doesn't exist."), never
    // the raw SMTP diagnostic. Composed by `bounceReason`.
    deliveryDetail: { type: String },
    // When the state last changed. Distinct from createdAt, which is when the
    // PDF was generated.
    deliveryUpdatedAt: { type: Date },
});

export default mongoose.model('PDFLink', PDFLinkSchema);