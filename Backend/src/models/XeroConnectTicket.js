import crypto from 'crypto';
import mongoose from 'mongoose';

const xeroConnectTicketSchema = new mongoose.Schema({
  ticket: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => crypto.randomBytes(32).toString('hex'),
  },
  userId: {
    type: String,
    required: true,
  },
  workspaceId: {
    type: String,
    required: true,
  },
  origin: {
    type: String,
    default: '',
  },
  email: {
    type: String,
    default: '',
  },
  claimedAt: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 900,
  },
});

export default mongoose.model('XeroConnectTicket', xeroConnectTicketSchema);
