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
    invoiceNumber: { type: String },
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