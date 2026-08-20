import mongoose from 'mongoose';

// One row per automation email actually handed to SES, written by the SES
// backend in services/email/backends.js at send time. This is the join table
// between the business run and the delivery events: every Delivery/Bounce/
// Complaint row in `emailevents` is keyed by SES's messageId, and this is the
// only record of which board, period and recipient that messageId belonged to.
const emailSendSchema = new mongoose.Schema(
  {
    // The bare SES message id, exactly as events carry it — no nodemailer
    // '<...@region.amazonses.com>' decoration.
    messageId: { type: String, required: true, unique: true },
    kind: { type: String, required: true },
    workspaceId: { type: String, required: true },
    boardId: { type: String, required: true },
    periodKey: { type: String, required: true },
    recipientKey: { type: String, default: null },
    recipientType: { type: String, default: null },
  },
  { timestamps: true },
);

export default mongoose.model('EmailSend', emailSendSchema);
