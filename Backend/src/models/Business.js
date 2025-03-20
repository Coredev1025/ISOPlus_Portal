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
  defaultLogo: {
    type: String
  },
  squareLogo: {
    type: String
  },
  wideLogo: {
    type: String
  },
  address: {
    street: {
      type: String,
      required: true
    },
    country: {
      type: String,
      required: true
    },
    suburb: {
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
  },
  bankDetails: {
    accountName: {
      type: String,
      required: true
    },
    bankName: {
      type: String,
      required: true
    },
    bsb: {
      type: String,
      required: true
    },
    accountNumber: {
      type: String,
      required: true
    },
    paymentReference: {
      type: String
    }
  },
  documentNumbering: {
    invoice: {
      prefix: {
        type: String,
        default: 'INV-'
      },
      nextNumber: {
        type: Number,
        default: 1000
      }
    },
    purchaseOrder: {
      prefix: {
        type: String,
        default: 'PO-'
      },
      nextNumber: {
        type: Number,
        default: 1000
      }
    },
    quote: {
      prefix: {
        type: String,
        default: 'QT-'
      },
      nextNumber: {
        type: Number,
        default: 1000
      }
    }
  }
});

export default mongoose.model('Business', businessSchema);