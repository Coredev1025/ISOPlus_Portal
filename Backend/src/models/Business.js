import mongoose from 'mongoose';

const businessSchema = new mongoose.Schema({
  workspaceId: {
    type: String,
    ref: 'WorkSpace',
    required: true
  },
  name: {
    type: String,
    required: true
  },
  logo: {
    type: String
  },
  address: {
    street1: {
      type: String,
      required: true
    },
    street2: {
      type: String
    },
    city: {
      type: String,
      required: true
    },
    state: {
      type: String,
      required: true
    },
    postcode: {
      type: String,
      required: true
    }
  },
  phone: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true
  },
  abn: {
    type: String
  },
  acn: {
    type: String
  },
  xeroIntegrated: {
    type: Boolean,
    default: false
  },
  xeroTokens: {
    accessToken: String,
    refreshToken: String,
    expiresAt: Date
  }
});

export default mongoose.model('Business', businessSchema);