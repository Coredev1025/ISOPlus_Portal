import mongoose from 'mongoose';
import { makeTicketSchema } from './ticketSchema.js';

const oauthTicketSchema = makeTicketSchema(
  {
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
  },
  300
);

export default mongoose.model('OAuthTicket', oauthTicketSchema);
