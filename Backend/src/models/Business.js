import mongoose from 'mongoose';
import { DEFAULT_DOCUMENT_NEXT_NUMBER } from '../constants/documentNumbering.js';

const businessSchema = new mongoose.Schema({
  workspaceId: {
    type: String,
    ref: 'WorkSpace'
  },
  name: {
    type: String
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
      type: String
    },
    country: {
      type: String
    },
    suburb: {
      type: String
    },
    state: {
      type: String
    },
    postcode: {
      type: String
    }
  },
  phone: {
    type: String
  },
  email: {
    type: String
  },
  abn: {
    type: String
  },
  acn: {
    type: String
  },
  companyRegistrationId: {
    type: String
  },
  xeroIntegrated: {
    type: Boolean,
    default: false
  },
  xeroTenantId: {
    type: String
  },
  xeroTokens: {
    accessToken: String,
    refreshToken: String,
    expiresAt: Number,
    refreshTokenExpiresAt: Number
  },
  xeroOrganization: {
    name: String,
    legalName: String,
    shortCode: String,
    organisationId: String,
    baseCurrency: String,
    countryCode: String,
    isDemoCompany: Boolean,
    organisationStatus: String
  },
  xeroLineItemMapping: {
    quote: {
      accountCode: { type: String },
      taxType: { type: String },
      taxRatePercent: { type: Number, default: null }
    },
    purchaseOrder: {
      accountCode: { type: String },
      taxType: { type: String },
      taxRatePercent: { type: Number, default: null }
    },
    invoice: {
      accountCode: { type: String },
      taxType: { type: String },
      taxRatePercent: { type: Number, default: null }
    },
    quoteOverrides: {
      quoteService: {
        accountCode: { type: String },
        taxType: { type: String },
        taxRatePercent: { type: Number, default: null }
      },
      material: {
        accountCode: { type: String },
        taxType: { type: String },
        taxRatePercent: { type: Number, default: null }
      }
    }
  },
  bankDetails: {
    accountName: {
      type: String
    },
    bankName: {
      type: String
    },
    bsb: {
      type: String
    },
    accountNumber: {
      type: String
    },
    accountsReceivableTerms: {
      type: String
    },
    accountsPayableTerms: {
      type: String
    }
  },
  headOfficeTimezone: {
    type: String,
    default: 'Australia/Sydney'
  },
  documentNumbering: {
    invoice: {
      prefix: {
        type: String,
        default: 'INV-'
      },
      nextNumber: {
        type: Number,
        default: DEFAULT_DOCUMENT_NEXT_NUMBER
      }
    },
    purchaseOrder: {
      prefix: {
        type: String,
        default: 'PO-'
      },
      nextNumber: {
        type: Number,
        default: DEFAULT_DOCUMENT_NEXT_NUMBER
      }
    },
    quote: {
      prefix: {
        type: String,
        default: 'QT-'
      },
      nextNumber: {
        type: Number,
        default: DEFAULT_DOCUMENT_NEXT_NUMBER
      }
    },
    statement: {
      prefix: {
        type: String,
        default: 'STM-'
      },
      nextNumber: {
        type: Number,
        default: DEFAULT_DOCUMENT_NEXT_NUMBER
      }
    },
    // The statement of account runs its own series. It shared the budget
    // statement's until a client asked why two documents numbered one apart
    // were different things: a statement number should identify one series,
    // and two document types drawing from one made STM-84 and STM-85
    // indistinguishable in a list and in an inbox.
    statementOfAccount: {
      prefix: {
        type: String,
        default: 'SOA-'
      },
      nextNumber: {
        type: Number,
        default: DEFAULT_DOCUMENT_NEXT_NUMBER
      }
    }
  },
  featureToggles: {
    invoiceStatementAutomation: {
      type: Boolean,
      default: false
    }
  }
});

export default mongoose.model('Business', businessSchema);