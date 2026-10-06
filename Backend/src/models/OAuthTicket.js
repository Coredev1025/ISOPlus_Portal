import mongoose from 'mongoose';
import { makeTicketSchema } from './ticketSchema.js';

const oauthTicketSchema = makeTicketSchema(
  {
    flow: {
      type: String,
      default: 'isoplus',
      enum: ['isoplus', 'google-support'],
    },
    accessToken: {
      type: String,
      default: '',
    },
    oauthData: {
      id: String,
      email: String,
      name: String,
      photo_url: String,
    },
  },
  300
);

export default mongoose.model('OAuthTicket', oauthTicketSchema);
