import mongoose from 'mongoose';
import crypto from 'crypto';

const oauthTicketSchema = new mongoose.Schema({
  ticket: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => crypto.randomBytes(32).toString('hex'),
  },
  accessToken: {
    type: String,
    required: true,
  },
  oauthData: {
    id: String,
    email: String,
    name: String,
    photo_url: String,
  },
  claimedAt: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 300,
  },
});

export default mongoose.model('OAuthTicket', oauthTicketSchema);
