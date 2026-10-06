import crypto from 'crypto';
import mongoose from 'mongoose';

/**
 * Shared ticket fields for one-time OAuth handoff documents.
 *
 * Touchpoints: models/OAuthTicket.js, models/XeroConnectTicket.js
 */
export function makeTicketSchema(extraFields, ttlSeconds) {
  return new mongoose.Schema({
    ticket: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => crypto.randomBytes(32).toString('hex'),
    },
    ...extraFields,
    claimedAt: {
      type: Date,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: ttlSeconds,
    },
  });
}
