import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
  givenName: {
    type: String,
    required: true,
    trim: true
  },
  familyName: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  xeroUserId: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    default: 'request_received',
    enum: ['request_received', 'account_created']
  },
  notes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

export default mongoose.model('Subscription', subscriptionSchema);
