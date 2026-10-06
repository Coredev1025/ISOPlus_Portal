import mongoose from 'mongoose';
import { makeTicketSchema } from './ticketSchema.js';

const xeroConnectTicketSchema = makeTicketSchema(
  {
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
  },
  900
);

export default mongoose.model('XeroConnectTicket', xeroConnectTicketSchema);
