import  mongoose from 'mongoose';

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
    xeroInvoiceId: { type: String },
    xeroInvoiceNumber: { type: String },
    createdAt: {
        type: Date,
        default: Date.now
    },
});

export default mongoose.model('PDFLink', PDFLinkSchema);