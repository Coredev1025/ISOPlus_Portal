import mongoose from 'mongoose';

// One row per SES sending event — Delivery, Bounce, Complaint, DeliveryDelay,
// Reject, Rendering Failure — consumed from the SQS queue by
// workers/emailEventsWorker.js and written by services/email/events.js.
//
// The compound unique index is the idempotency guarantee: SQS is at-least-once,
// so the same event WILL be delivered twice, and two instances can poll the
// same queue. eventAt is part of the key because DeliveryDelay legitimately
// recurs for one message — same messageId, same type, different instant.
const emailEventSchema = new mongoose.Schema(
  {
    eventType: { type: String, required: true },
    sesMessageId: { type: String, required: true },
    eventAt: { type: Date, required: true },
    recipients: { type: [String], default: [] },
    subject: { type: String, default: null },
    // The event's type-specific block (bounce, delivery, complaint, ...) as
    // SES sent it — the diagnostic detail an operator needs, without storing
    // the whole envelope twice.
    detail: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

emailEventSchema.index({ sesMessageId: 1, eventType: 1, eventAt: 1 }, { unique: true });

export default mongoose.model('EmailEvent', emailEventSchema);
