import mongoose from 'mongoose';

import { AUTOMATION_UNITS } from '../constants/automation.js';

export const SEND_METHODS = ['isoplus', 'accounting'];
export const RECIPIENTS = ['billing_contact', 'client_participant'];

// runOn is Mixed because its type changes with the unit: a weekday name for
// week, a day number for month, and {month, day} for quarter/year. The
// unit-appropriate shape is enforced on the write path in
// automationSettingsHelpers, not here — a schema type cannot express it.
const blockSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, required: true, default: false },
    every: {
      n: { type: Number, required: true, default: 1, min: 1 },
      unit: { type: String, required: true, default: 'month', enum: AUTOMATION_UNITS },
    },
    runOn: { type: mongoose.Schema.Types.Mixed, default: 1 },
    runAt: { type: String, required: true, default: '09:00' },
    startDate: { type: Date, default: null },
    sendMethod: { type: String, required: true, default: 'isoplus', enum: SEND_METHODS },
    recipient: { type: String, required: true, default: 'billing_contact', enum: RECIPIENTS },
    sendCopyTo: { type: String, default: '' },
    replyTo: { type: String, default: '' },
    // emailFrom removed (KAN-270): Email From is application-level
    // configuration now (EMAIL_FROM env var + a hardcoded display name), not
    // a per-workspace setting. A pre-existing stored document may still carry
    // a stale emailFrom string; nothing reads it any more.
    emailSubject: { type: String, default: '' },
    emailMessage: { type: String, default: '' },
  },
  { _id: false },
);

const automationSettingsSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, required: true, unique: true },
    invoice: { type: blockSchema, default: () => ({}) },
    statement: { type: blockSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export default mongoose.model('AutomationSettings', automationSettingsSchema);
