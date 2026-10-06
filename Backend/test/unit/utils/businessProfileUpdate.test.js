import { describe, it, expect, vi, beforeEach } from 'vitest';

// S3 and ISO+ are the only external edges of this module; everything else stays real.
vi.mock('../../../src/utils/uploadS3.js', () => ({
  deleteFileFromS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 204 } })),
  uploadFileToS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 200 }, ETag: '"abc"' })),
}));

vi.mock('../../../src/services/isoplus.js', () => ({
  setLogo: vi.fn(),
}));

import { deleteFileFromS3, uploadFileToS3 } from '../../../src/utils/uploadS3.js';
import { setLogo } from '../../../src/services/isoplus.js';
import {
  applyBusinessLogoUpdates,
  buildBusinessUpdateData,
  mergeDocumentNumbering,
  documentNumberingSetPaths,
  documentNumberingForNewBusiness,
  parseLogoRemovals,
} from '../../../src/utils/businessProfileUpdate.js';

/** Shape multer's memoryStorage produces for `upload.fields([...])`. */
function multerFile(originalname, fieldname) {
  return {
    fieldname,
    originalname,
    encoding: '7bit',
    mimetype: 'image/png',
    buffer: Buffer.from('fake-png-bytes'),
    size: 14,
  };
}

const noRemovals = { defaultLogo: false, squareLogo: false, wideLogo: false };

describe('parseLogoRemovals', () => {
  it('treats only boolean true and the string "true" as a removal', () => {
    expect(
      parseLogoRemovals({
        defaultLogoRemoved: true,
        squareLogoRemoved: 'true',
        wideLogoRemoved: false,
      }),
    ).toEqual({ defaultLogo: true, squareLogo: true, wideLogo: false });
  });

  it('rejects truthy look-alikes and missing keys', () => {
    expect(
      parseLogoRemovals({
        defaultLogoRemoved: 'TRUE',
        squareLogoRemoved: 1,
        wideLogoRemoved: 'yes',
      }),
    ).toEqual({ defaultLogo: false, squareLogo: false, wideLogo: false });

    expect(parseLogoRemovals({})).toEqual({
      defaultLogo: false,
      squareLogo: false,
      wideLogo: false,
    });
  });
});

describe('mergeDocumentNumbering', () => {
  it('keeps an existing statementOfAccount series when the PUT omits it', () => {
    expect(
      mergeDocumentNumbering(
        {
          invoice: { prefix: 'INV-', nextNumber: 10 },
          statementOfAccount: { prefix: 'SOA-', nextNumber: 27 },
        },
        {
          invoice: { prefix: 'INV-', nextNumber: 11 },
          statement: { prefix: 'STM-', nextNumber: 1 },
        },
      ),
    ).toEqual({
      invoice: { prefix: 'INV-', nextNumber: 11 },
      statement: { prefix: 'STM-', nextNumber: 1 },
      statementOfAccount: { prefix: 'SOA-', nextNumber: 27 },
    });
  });

  it('keeps an existing statement (STM-) series when the PUT omits it', () => {
    expect(
      mergeDocumentNumbering(
        {
          invoice: { prefix: 'INV-', nextNumber: 10 },
          statement: { prefix: 'STM-', nextNumber: 1000 },
          statementOfAccount: { prefix: 'SOA-', nextNumber: 27 },
        },
        {
          invoice: { prefix: 'INV-', nextNumber: 11 },
          purchaseOrder: { prefix: 'PO-', nextNumber: 3 },
          quote: { prefix: 'QT-', nextNumber: 4 },
          statementOfAccount: { prefix: 'SOA-', nextNumber: 28 },
        },
      ),
    ).toEqual({
      invoice: { prefix: 'INV-', nextNumber: 11 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 3 },
      quote: { prefix: 'QT-', nextNumber: 4 },
      statement: { prefix: 'STM-', nextNumber: 1000 },
      statementOfAccount: { prefix: 'SOA-', nextNumber: 28 },
    });
  });

  it('applies an explicit statementOfAccount update', () => {
    expect(
      mergeDocumentNumbering(
        { statementOfAccount: { prefix: 'SOA-', nextNumber: 1 } },
        { statementOfAccount: { prefix: 'SOA-', nextNumber: 27 } },
      ),
    ).toEqual({ statementOfAccount: { prefix: 'SOA-', nextNumber: 27 } });
  });
});

describe('buildBusinessUpdateData', () => {
  // findByIdAndUpdate treats nested objects of undefined as {} and wipes
  // stored bankDetails / address. Omit those nests when the body did not
  // send any of their fields.
  it('omits address and bankDetails when those fields are absent from the body', () => {
    const update = buildBusinessUpdateData({
      name: 'Wipe Co',
      workspaceId: 'ws-wipe',
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 11 },
      },
    });

    expect(update).toEqual({
      name: 'Wipe Co',
      workspaceId: 'ws-wipe',
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 11 },
      },
    });
    expect(update).not.toHaveProperty('headOfficeTimezone');
    expect(update).not.toHaveProperty('address');
    expect(update).not.toHaveProperty('bankDetails');
    expect(update).not.toHaveProperty('phone');
    expect(update).not.toHaveProperty('email');
  });

  it('maps a full multipart body onto the Business document shape', () => {
    const body = {
      name: 'Hillsgrade Care Services',
      phone: '+61 2 5550 1234',
      email: 'accounts@hillsgrade.example',
      abn: '51824753556',
      acn: '004085616',
      companyRegistrationId: 'REG-99182',
      street: '12 Bourke Street',
      suburb: 'Surry Hills',
      state: 'NSW',
      country: 'Australia',
      postcode: '2010',
      bankAccountName: 'Hillsgrade Care Services Pty Ltd',
      bankName: 'Commonwealth Bank',
      bsb: '062-000',
      accountNumber: '12345678',
      paymentReference: 'INV-{number}',
      accountsReceivableTerms: '14 days',
      accountsPayableTerms: '30 days',
      headOfficeTimezone: 'Australia/Brisbane',
      workspaceId: 'ws_4821',
      documentNumbering: { invoicePrefix: 'INV', nextInvoiceNumber: 1042 },
    };

    expect(buildBusinessUpdateData(body)).toEqual({
      name: 'Hillsgrade Care Services',
      address: {
        street: '12 Bourke Street',
        country: 'Australia',
        suburb: 'Surry Hills',
        state: 'NSW',
        postcode: '2010',
      },
      phone: '+61 2 5550 1234',
      email: 'accounts@hillsgrade.example',
      abn: '51824753556',
      acn: '004085616',
      companyRegistrationId: 'REG-99182',
      workspaceId: 'ws_4821',
      bankDetails: {
        accountName: 'Hillsgrade Care Services Pty Ltd',
        bankName: 'Commonwealth Bank',
        bsb: '062-000',
        accountNumber: '12345678',
        paymentReference: 'INV-{number}',
        accountsReceivableTerms: '14 days',
        accountsPayableTerms: '30 days',
      },
      documentNumbering: { invoicePrefix: 'INV', nextInvoiceNumber: 1042 },
      headOfficeTimezone: 'Australia/Brisbane',
    });
  });

  // KAN-322: Finance Settings does not send the timezone, so a save must not
  // write one. A default here reset a stored zone to Sydney on every such save;
  // the schema default covers a business created without one.
  it('leaves headOfficeTimezone out when absent or empty', () => {
    expect(buildBusinessUpdateData({ workspaceId: 'ws_1' })).not.toHaveProperty(
      'headOfficeTimezone',
    );
    expect(
      buildBusinessUpdateData({ workspaceId: 'ws_1', headOfficeTimezone: '' }),
    ).not.toHaveProperty('headOfficeTimezone');
  });

  it('drops fields that are not part of the business profile', () => {
    const result = buildBusinessUpdateData({
      name: 'Acme',
      workspaceId: 'ws_1',
      defaultLogoRemoved: 'true',
      xeroIntegrated: true,
      _id: '507f1f77bcf86cd799439011',
    });

    expect(result).not.toHaveProperty('defaultLogoRemoved');
    expect(result).not.toHaveProperty('xeroIntegrated');
    expect(result).not.toHaveProperty('_id');
  });

  it('keeps only defined nested address fields and omits empty bankDetails', () => {
    const result = buildBusinessUpdateData({ name: 'Acme', street: '1 High St' });

    expect(result.address).toEqual({ street: '1 High St' });
    expect(result).not.toHaveProperty('bankDetails');
  });
});

describe('applyBusinessLogoUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const business = {
    workspaceId: 'ws_4821',
    name: 'Hillsgrade Care Services',
    defaultLogo: 'logos/ws_4821/default-logo.png',
    squareLogo: 'logos/ws_4821/square-logo.jpg',
    wideLogo: null,
  };

  it('returns an empty update when nothing was uploaded or removed', async () => {
    const updateData = await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: {},
      removals: noRemovals,
      authorization: 'Bearer tok',
      req: {},
    });

    expect(updateData).toEqual({});
    expect(uploadFileToS3).not.toHaveBeenCalled();
    expect(deleteFileFromS3).not.toHaveBeenCalled();
  });

  it('uploads a new default logo under logos/<workspaceId>/default-logo<ext> and deletes the old key', async () => {
    const file = multerFile('Company Brand.PNG', 'defaultLogo');
    const updateData = await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: { defaultLogo: [file] },
      removals: noRemovals,
      authorization: 'Bearer tok',
      req: {},
    });

    expect(updateData).toEqual({ defaultLogo: 'logos/ws_4821/default-logo.PNG' });
    expect(deleteFileFromS3).toHaveBeenCalledWith('logos/ws_4821/default-logo.png', false);
    expect(uploadFileToS3).toHaveBeenCalledWith(file.buffer, 'logos/ws_4821/default-logo.PNG', false);
  });

  it('does not delete anything when the business had no previous logo for that field', async () => {
    const updateData = await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: { wideLogo: [multerFile('banner.svg', 'wideLogo')] },
      removals: noRemovals,
      authorization: 'Bearer tok',
      req: {},
    });

    expect(updateData).toEqual({ wideLogo: 'logos/ws_4821/wide-logo.svg' });
    expect(deleteFileFromS3).not.toHaveBeenCalled();
  });

  it('syncs the square logo to ISO+ as a "form" logo and the wide logo as "document"', async () => {
    const req = { id: 'req-1' };
    const square = multerFile('square.png', 'squareLogo');
    const wide = multerFile('wide.png', 'wideLogo');

    await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: { squareLogo: [square], wideLogo: [wide] },
      removals: noRemovals,
      authorization: 'Bearer tok',
      req,
    });

    expect(setLogo).toHaveBeenCalledTimes(2);
    expect(setLogo).toHaveBeenNthCalledWith(1, 'Bearer tok', 'ws_4821', square, 'form', req);
    expect(setLogo).toHaveBeenNthCalledWith(2, 'Bearer tok', 'ws_4821', wide, 'document', req);
  });

  it('never syncs the default logo to ISO+', async () => {
    await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: { defaultLogo: [multerFile('logo.png', 'defaultLogo')] },
      removals: noRemovals,
      authorization: 'Bearer tok',
      req: {},
    });

    expect(setLogo).not.toHaveBeenCalled();
  });

  it('nulls a removed logo field and deletes the stored object', async () => {
    const updateData = await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: {},
      removals: { ...noRemovals, squareLogo: true },
      authorization: 'Bearer tok',
      req: {},
    });

    expect(updateData).toEqual({ squareLogo: null });
    expect(deleteFileFromS3).toHaveBeenCalledWith('logos/ws_4821/square-logo.jpg', false);
  });

  it('omits the field entirely when a removal is requested but nothing is stored', async () => {
    const updateData = await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: {},
      removals: { ...noRemovals, wideLogo: true },
      authorization: 'Bearer tok',
      req: {},
    });

    expect(updateData).toEqual({});
    expect(deleteFileFromS3).not.toHaveBeenCalled();
  });

  it('lets an upload win over a removal flag for the same field', async () => {
    const updateData = await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: { squareLogo: [multerFile('replacement.webp', 'squareLogo')] },
      removals: { ...noRemovals, squareLogo: true },
      authorization: 'Bearer tok',
      req: {},
    });

    expect(updateData).toEqual({ squareLogo: 'logos/ws_4821/square-logo.webp' });
    expect(deleteFileFromS3).toHaveBeenCalledTimes(1);
    expect(uploadFileToS3).toHaveBeenCalledTimes(1);
  });

  it('produces an extension-less key when the uploaded file has no extension', async () => {
    const updateData = await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business: {},
      files: { defaultLogo: [multerFile('logo', 'defaultLogo')] },
      removals: noRemovals,
      authorization: 'Bearer tok',
      req: {},
    });

    expect(updateData).toEqual({ defaultLogo: 'logos/ws_4821/default-logo' });
  });

  it('handles a missing files object by falling through to removals', async () => {
    const updateData = await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: undefined,
      removals: { defaultLogo: true, squareLogo: true, wideLogo: true },
      authorization: 'Bearer tok',
      req: {},
    });

    expect(updateData).toEqual({ defaultLogo: null, squareLogo: null });
    expect(deleteFileFromS3).toHaveBeenCalledTimes(2);
  });

  it('handles all three fields at once', async () => {
    const updateData = await applyBusinessLogoUpdates({
      workspaceId: 'ws_4821',
      business,
      files: {
        defaultLogo: [multerFile('a.png', 'defaultLogo')],
        wideLogo: [multerFile('c.jpeg', 'wideLogo')],
      },
      removals: { ...noRemovals, squareLogo: true },
      authorization: 'Bearer tok',
      req: {},
    });

    expect(updateData).toEqual({
      defaultLogo: 'logos/ws_4821/default-logo.png',
      squareLogo: null,
      wideLogo: 'logos/ws_4821/wide-logo.jpeg',
    });
  });
});

// KAN-290: the numbering sequence is read-only through the profile form. An
// update to an existing business may change a series' prefix, never its
// nextNumber, and writes only the fields it was sent so it cannot rewrite a
// counter that moved while the save was in flight.
describe('documentNumberingSetPaths', () => {
  it('turns each sent prefix into its own path and ignores nextNumber', () => {
    expect(
      documentNumberingSetPaths({
        invoice: { prefix: 'INV-', nextNumber: 11 },
        quote: { prefix: 'QT-', nextNumber: 5 },
      }),
    ).toEqual({
      'documentNumbering.invoice.prefix': 'INV-',
      'documentNumbering.quote.prefix': 'QT-',
    });
  });

  it('writes nothing for a series that was not sent, or one with only a nextNumber', () => {
    expect(documentNumberingSetPaths({})).toEqual({});
    expect(documentNumberingSetPaths(undefined)).toEqual({});
    expect(documentNumberingSetPaths({ invoice: { nextNumber: 99 } })).toEqual({});
  });

  it('skips undefined prefixes and anything that is not a series object', () => {
    expect(
      documentNumberingSetPaths({
        invoice: { prefix: undefined, nextNumber: 7 },
        quote: 'nope',
        purchaseOrder: null,
        statementOfAccount: { prefix: 'SOA-' },
      }),
    ).toEqual({ 'documentNumbering.statementOfAccount.prefix': 'SOA-' });
  });

  it('copies only the prefix, so a request cannot write other fields', () => {
    expect(
      documentNumberingSetPaths({ invoice: { prefix: 'INV-', nextNumber: 9, $set: { x: 1 }, other: 2 } }),
    ).toEqual({ 'documentNumbering.invoice.prefix': 'INV-' });
  });
});

// KAN-290 / KAN-292: a new workspace starts every counter at 1. The request may
// choose prefixes; it cannot choose a starting number.
describe('documentNumberingForNewBusiness', () => {
  it('keeps each prefix and drops every nextNumber, so the schema default of 1 applies', () => {
    expect(
      documentNumberingForNewBusiness({
        invoice: { prefix: 'TAX-', nextNumber: 1000 },
        quote: { prefix: 'QT-', nextNumber: 5 },
      }),
    ).toEqual({
      invoice: { prefix: 'TAX-' },
      quote: { prefix: 'QT-' },
    });
  });

  it('gives nothing for a series with only a number, or for no numbering at all', () => {
    expect(documentNumberingForNewBusiness({ invoice: { nextNumber: 9 } })).toEqual({});
    expect(documentNumberingForNewBusiness(undefined)).toEqual({});
    expect(documentNumberingForNewBusiness({})).toEqual({});
  });

  it('only accepts known series names', () => {
    expect(
      documentNumberingForNewBusiness({ notASeries: { prefix: 'X-' }, quote: { prefix: 'QT-' } }),
    ).toEqual({ quote: { prefix: 'QT-' } });
  });
});
