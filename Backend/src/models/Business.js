import mongoose from 'mongoose';

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
      taxFreeType: { type: String }
    },
    purchaseOrder: {
      accountCode: { type: String },
      taxType: { type: String },
      taxFreeType: { type: String }
    },
    invoice: {
      accountCode: { type: String },
      taxType: { type: String },
      taxFreeType: { type: String }
    },
    quoteOverrides: {
      quoteService: {
        accountCode: { type: String },
        taxType: { type: String },
        taxFreeType: { type: String }
      },
      material: {
        accountCode: { type: String },
        taxType: { type: String },
        taxFreeType: { type: String }
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
    },
    statement: {
      prefix: {
        type: String,
        default: 'STMT-'
      },
      nextNumber: {
        type: Number,
        default: 1000
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