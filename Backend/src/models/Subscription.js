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
  sub: {
    type: String,
    trim: true,
    default: null,
    sparse: true,
    unique: true
  },
  xeroUserId: {
    type: String,
    required: true,
    trim: true,
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
  },
  companyName: {
    type: String,
    default: '',
    trim: true
  },
  phone: {
    type: String,
    default: '',
    trim: true
  },
  applicantMessage: {
    type: String,
    default: '',
    trim: true
  }
}, {
  timestamps: true
});

subscriptionSchema.index({ createdAt: -1 });
subscriptionSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('Subscription', subscriptionSchema);
