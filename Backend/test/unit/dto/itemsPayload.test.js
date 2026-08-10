import { describe, it, expect } from 'vitest';
import {
  ItemValues,
  ContactValues,
  ContractorValues,
  PurchaseOrderValues,
  JobValues,
  JobTypeValues,
  JobPlanningValues,
  ServiceFeeTypeValues,
  QuoteValues,
  NDISPricingValues,
  IsoPlusLineItemValues,
  IsoPlusInvoiceValues,
  Item,
  Payload,
} from '../../../src/dto/itemsPayload.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const messagesOf = (result) => (result.error?.details ?? []).map((d) => d.message);

describe('ContactValues', () => {
  it('copies every declared field off the payload', () => {
    const values = new ContactValues({
      client: 'Acme Care',
      typeOfClient: 'Organisation',
      contactPersonsFirstName: 'Dana',
      contactPersonsLastName: 'Reid',
      emailAddress: 'dana@acme.example.com',
      phoneNumber: '0400000000',
      paymentTerm: '14 days',
      additionalNotes: 'VIP',
      address: '1 Test St',
      suburb: 'Testville',
      state: 'NSW',
      postcode: 2000,
      xeroQuote: 'Q-1',
      xeroAccount: '200',
      jobTitle: 'Support',
      issueDate: '2026-01-01',
      integrationValidation: 'ok',
      integrationMessage: 'synced',
      notDeclared: 'dropped',
    });

    expect(values.client).toBe('Acme Care');
    expect(values.emailAddress).toBe('dana@acme.example.com');
    expect(values.postcode).toBe(2000);
    expect(values.notDeclared).toBeUndefined();
  });

  it('is an ItemValues', () => {
    expect(new ContactValues({})).toBeInstanceOf(ItemValues);
  });

  it('accepts a complete contact', () => {
    const result = ContactValues.validationSchema().validate({
      client: 'Acme Care',
      emailAddress: 'dana@acme.example.com',
      phoneNumber: '0400000000',
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects a missing client, email and phone with all three messages at once', () => {
    const result = ContactValues.validationSchema().validate({}, { abortEarly: false });
    expect(messagesOf(result)).toEqual([
      'Client is required.',
      'Email Address is required.',
      'Phone Number is required.',
    ]);
  });

  it('rejects a malformed email address', () => {
    const result = ContactValues.validationSchema().validate({
      client: 'Acme Care',
      emailAddress: 'not-an-email',
      phoneNumber: '0400000000',
    });
    expect(messagesOf(result)).toEqual(['Email Address is invalid.']);
  });

  it('rejects an empty client string, not just a missing key', () => {
    const result = ContactValues.validationSchema().validate({
      client: '',
      emailAddress: 'dana@acme.example.com',
      phoneNumber: '0400000000',
    });
    expect(messagesOf(result)).toEqual(['Client is required.']);
  });

  it('allows the optional fields to be null or empty', () => {
    const result = ContactValues.validationSchema().validate({
      client: 'Acme Care',
      emailAddress: 'dana@acme.example.com',
      phoneNumber: '0400000000',
      typeOfClient: null,
      additionalNotes: '',
      postcode: null,
      issueDate: null,
    });
    expect(result.error).toBeUndefined();
  });

  it('requires the postcode to be a whole number', () => {
    const result = ContactValues.validationSchema().validate({
      client: 'Acme Care',
      emailAddress: 'dana@acme.example.com',
      phoneNumber: '0400000000',
      postcode: 2000.5,
    });
    expect(result.error).toBeDefined();
  });
});

describe('ContractorValues', () => {
  it('copies the PascalCase contractor fields', () => {
    const values = new ContractorValues({
      Contractor: 'Bright Support',
      EmailAddress: 'ops@bright.example.com',
      PhoneNumber: '0411111111',
      Postcode: 3000,
    });
    expect(values.Contractor).toBe('Bright Support');
    expect(values.Postcode).toBe(3000);
  });

  it('requires contractor, email and phone', () => {
    const result = ContractorValues.validationSchema().validate({}, { abortEarly: false });
    expect(messagesOf(result)).toEqual([
      'Contractor is required.',
      'Email Address is required.',
      'Phone Number is required.',
    ]);
  });

  it('rejects a camelCase payload, because the schema keys are PascalCase', () => {
    const result = ContractorValues.validationSchema().validate({
      contractor: 'Bright Support',
      emailAddress: 'ops@bright.example.com',
      phoneNumber: '0411111111',
    });
    expect(result.error).toBeDefined();
  });
});

describe('PurchaseOrderValues', () => {
  it('generates a uuid id when none is supplied', () => {
    expect(new PurchaseOrderValues({}).id).toMatch(UUID_V4);
  });

  it('keeps a supplied id', () => {
    expect(new PurchaseOrderValues({ id: 'given-id' }).id).toBe('given-id');
  });

  it('gives two instances different generated ids', () => {
    expect(new PurchaseOrderValues({}).id).not.toBe(new PurchaseOrderValues({}).id);
  });

  it('accepts a complete purchase order', () => {
    const result = PurchaseOrderValues.validationSchema().validate({
      clientsOrderNumber: 'PO-1',
      issueDate: '2026-01-01',
      deliveryDate: '2026-02-01',
      jobTitle: 'Install',
      unitPrice: 100,
      quantity: 2,
      jobDescription: 'Install the unit',
    });
    expect(result.error).toBeUndefined();
  });

  it('names each missing required field', () => {
    const result = PurchaseOrderValues.validationSchema()
      .validate({ clientsOrderNumber: 'PO-1' }, { abortEarly: false });
    expect(messagesOf(result)).toEqual([
      'Issue Date is required.',
      'Delivery Date is required.',
      'Job Title is required.',
      'Unit Price is required.',
      'Quantity is required.',
      'Job Description is required.',
    ]);
  });

  it('rejects a non-uuid id', () => {
    const result = PurchaseOrderValues.validationSchema().validate({
      id: 'not-a-guid',
      clientsOrderNumber: 'PO-1',
      issueDate: '2026-01-01',
      deliveryDate: '2026-02-01',
      jobTitle: 'Install',
      unitPrice: 100,
      quantity: 2,
      jobDescription: 'Install the unit',
    });
    expect(result.error).toBeDefined();
  });

  it('rejects an unparseable issue date', () => {
    const result = PurchaseOrderValues.validationSchema().validate({
      clientsOrderNumber: 'PO-1',
      issueDate: 'yesterday',
      deliveryDate: '2026-02-01',
      jobTitle: 'Install',
      unitPrice: 100,
      quantity: 2,
      jobDescription: 'Install the unit',
    });
    expect(messagesOf(result)).toEqual(['Issue Date is required.']);
  });
});

describe('JobValues', () => {
  it('generates a uuid id when none is supplied', () => {
    expect(new JobValues({}).id).toMatch(UUID_V4);
  });

  it('accepts array-valued jobNumber and serviceFeeType', () => {
    const result = JobValues.validationSchema().validate({
      jobNumber: ['4021'],
      jobDurationHrs: 3,
      serviceFeeType: ['Hourly'],
      payableServiceFee: 150,
      payableMaterialFee: 0,
      otherPayableFee: 0,
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects a scalar jobNumber', () => {
    const result = JobValues.validationSchema().validate({
      jobNumber: '4021',
      jobDurationHrs: 3,
      serviceFeeType: ['Hourly'],
      payableServiceFee: 150,
      payableMaterialFee: 0,
      otherPayableFee: 0,
    });
    expect(result.error).toBeDefined();
  });

  it('requires every fee field, so a zero fee must be stated explicitly', () => {
    const result = JobValues.validationSchema().validate(
      { jobNumber: ['4021'], jobDurationHrs: 3, serviceFeeType: ['Hourly'] },
      { abortEarly: false },
    );
    expect(result.error.details).toHaveLength(3);
  });
});

describe('JobTypeValues', () => {
  it('generates a uuid id when none is supplied', () => {
    expect(new JobTypeValues({}).id).toMatch(UUID_V4);
  });

  it('requires both jobType and jobCode', () => {
    const result = JobTypeValues.validationSchema().validate({}, { abortEarly: false });
    expect(result.error.details).toHaveLength(2);
  });
});

describe('JobPlanningValues', () => {
  it('generates a uuid id when none is supplied', () => {
    expect(new JobPlanningValues({}).id).toMatch(UUID_V4);
  });

  it('requires a string jobNumber, unlike JobValues which requires an array', () => {
    const asString = JobPlanningValues.validationSchema().validate({
      clientOrderNumber: 'PO-1',
      jobTitle: 'Install',
      jobNumber: '4021',
    });
    const asArray = JobPlanningValues.validationSchema().validate({
      clientOrderNumber: 'PO-1',
      jobTitle: 'Install',
      jobNumber: ['4021'],
    });
    expect(asString.error).toBeUndefined();
    expect(asArray.error).toBeDefined();
  });
});

describe('ServiceFeeTypeValues', () => {
  it('copies feeType and rate without generating an id', () => {
    const values = new ServiceFeeTypeValues({ feeType: 'Hourly', rate: 55.75 });
    expect(values).toEqual({ feeType: 'Hourly', rate: 55.75 });
  });

  it('coerces a numeric string rate', () => {
    const result = ServiceFeeTypeValues.validationSchema()
      .validate({ feeType: 'Hourly', rate: '55.75' });
    expect(result.error).toBeUndefined();
    expect(result.value.rate).toBe(55.75);
  });

  it('rejects a non-numeric rate', () => {
    const result = ServiceFeeTypeValues.validationSchema()
      .validate({ feeType: 'Hourly', rate: 'n/a' });
    expect(result.error).toBeDefined();
  });
});

describe('QuoteValues', () => {
  it('renames title, summary and lineItems onto the quote fields', () => {
    const values = new QuoteValues({
      issueDate: '2026-01-01',
      expiryDate: '2026-02-01',
      title: 'Bathroom mod',
      unitPrice: 500,
      quantity: 1,
      summary: 'Rails and ramp',
      lineItems: ['Rails', 'Ramp'],
    });

    expect(values.jobTitle).toBe('Bathroom mod');
    expect(values.jobDescription).toBe('Rails and ramp');
    expect(values.quoteChecklist).toEqual(['Rails', 'Ramp']);
    expect(values.title).toBeUndefined();
    expect(values.summary).toBeUndefined();
  });

  it('validates the constructed object rather than the raw payload', () => {
    const raw = {
      issueDate: '2026-01-01',
      expiryDate: '2026-02-01',
      title: 'Bathroom mod',
      unitPrice: 500,
      quantity: 1,
      summary: 'Rails and ramp',
      lineItems: ['Rails'],
    };
    const schema = QuoteValues.validationSchema();

    expect(schema.validate(raw).error).toBeDefined();
    expect(schema.validate({ ...new QuoteValues(raw) }).error).toBeUndefined();
  });

  it('requires a non-empty quote checklist array', () => {
    const base = {
      id: undefined,
      issueDate: '2026-01-01',
      expiryDate: '2026-02-01',
      jobTitle: 'Bathroom mod',
      unitPrice: 500,
      quantity: 1,
      jobDescription: 'Rails and ramp',
    };
    expect(QuoteValues.validationSchema().validate({ ...base, quoteChecklist: [] }).error)
      .toBeUndefined();
    expect(messagesOf(QuoteValues.validationSchema().validate({ ...base })))
      .toEqual(['Quote Checklist is required.']);
    expect(messagesOf(QuoteValues.validationSchema().validate({ ...base, quoteChecklist: 'Rails' })))
      .toEqual(['Quote Checklist is required.']);
  });
});

describe('NDISPricingValues', () => {
  it('defaults unitPrice and unitPriceAttr to 0 when absent', () => {
    const values = new NDISPricingValues({ itemId: '01_011_0107_1_1', serviceArea: 'NSW' });
    expect(values.unitPrice).toBe(0);
    expect(values.unitPriceAttr).toBe(0);
  });

  it('treats a supplied unit price of 0 the same as an absent one', () => {
    expect(new NDISPricingValues({ unitPrice: 0 }).unitPrice).toBe(0);
    expect(new NDISPricingValues({ unitPrice: 57.1 }).unitPrice).toBe(57.1);
  });

  it('accepts a complete pricing row', () => {
    const result = NDISPricingValues.validationSchema().validate({
      itemId: '01_011_0107_1_1',
      serviceArea: 'NSW',
      unit: 'Hour',
      unitPrice: 67.56,
      unitAttr: 'Unit',
      unitPriceAttr: 'Price ($)',
    });
    expect(result.error).toBeUndefined();
  });

  it('names each missing required field', () => {
    const result = NDISPricingValues.validationSchema().validate({}, { abortEarly: false });
    expect(messagesOf(result)).toEqual([
      'Support Item Number is required.',
      'Service Area is required.',
      'Unit Attribute is required.',
      'Unit Price Attribute is required.',
    ]);
  });

  it('rejects the constructor default of 0 for unitPriceAttr, which the schema types as a string', () => {
    // Documents current behaviour: an instance built with no unitPriceAttr can
    // never satisfy its own schema.
    const values = new NDISPricingValues({
      itemId: '01_011_0107_1_1',
      serviceArea: 'NSW',
      unitAttr: 'Unit',
    });
    const result = NDISPricingValues.validationSchema().validate({ ...values });
    expect(messagesOf(result)).toEqual(['"unitPriceAttr" must be a string']);
  });
});

describe('IsoPlusLineItemValues', () => {
  it('reads camelCase fields', () => {
    const line = new IsoPlusLineItemValues({
      description: 'Support hour',
      quantity: 2,
      unitAmount: 67.56,
      accountCode: '200',
      discountRate: 10,
      itemCode: 'SUP',
      taxType: 'NONE',
      taxAmount: 0,
      lineAmount: 135.12,
    });
    expect(line.description).toBe('Support hour');
    expect(line.unitAmount).toBe(67.56);
  });

  it('falls back to the PascalCase Xero field names', () => {
    const line = new IsoPlusLineItemValues({
      Description: 'Support hour',
      Quantity: 2,
      UnitAmount: 67.56,
      AccountCode: '200',
      DiscountRate: 10,
      ItemCode: 'SUP',
      TaxType: 'NONE',
      TaxAmount: 0,
      LineAmount: 135.12,
    });
    expect(line.description).toBe('Support hour');
    expect(line.accountCode).toBe('200');
    expect(line.lineAmount).toBe(135.12);
  });

  it('prefers the camelCase value when both spellings are present', () => {
    const line = new IsoPlusLineItemValues({ description: 'camel', Description: 'pascal' });
    expect(line.description).toBe('camel');
  });

  it('drops a zero quantity in favour of the PascalCase key, because the fallback is ||', () => {
    // Documents current behaviour: `data.quantity || data.Quantity` cannot
    // express a genuine 0.
    const line = new IsoPlusLineItemValues({ quantity: 0, Quantity: 5 });
    expect(line.quantity).toBe(5);
  });

  it('accepts a complete line item', () => {
    const result = IsoPlusLineItemValues.validationSchema().validate({
      description: 'Support hour',
      quantity: 2,
      unitAmount: 67.56,
      accountCode: '200',
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects a zero unit amount', () => {
    const result = IsoPlusLineItemValues.validationSchema().validate({
      description: 'Support hour',
      quantity: 2,
      unitAmount: 0,
      accountCode: '200',
    });
    expect(messagesOf(result)).toEqual(['UnitAmount must not be 0']);
  });

  it('accepts a negative unit amount, which credit lines rely on', () => {
    const result = IsoPlusLineItemValues.validationSchema().validate({
      description: 'Credit',
      quantity: 1,
      unitAmount: -50,
      accountCode: '200',
    });
    expect(result.error).toBeUndefined();
  });

  it('requires an account code, because Xero rejects a line without one', () => {
    const result = IsoPlusLineItemValues.validationSchema().validate({
      description: 'Support hour',
      quantity: 2,
      unitAmount: 67.56,
    });
    expect(messagesOf(result)).toEqual(['AccountCode is required for Xero API.']);
  });

  it('holds the discount rate to 0..100', () => {
    const base = { description: 'd', quantity: 1, unitAmount: 1, accountCode: '200' };
    const schema = IsoPlusLineItemValues.validationSchema();
    expect(schema.validate({ ...base, discountRate: 0 }).error).toBeUndefined();
    expect(schema.validate({ ...base, discountRate: 100 }).error).toBeUndefined();
    expect(messagesOf(schema.validate({ ...base, discountRate: -1 })))
      .toEqual(['DiscountRate must be between 0 and 100']);
    expect(messagesOf(schema.validate({ ...base, discountRate: 101 })))
      .toEqual(['DiscountRate must be between 0 and 100']);
  });

  it('rejects a negative tax amount', () => {
    const result = IsoPlusLineItemValues.validationSchema().validate({
      description: 'd',
      quantity: 1,
      unitAmount: 1,
      accountCode: '200',
      taxAmount: -1,
    });
    expect(messagesOf(result)).toEqual(['TaxAmount must be non-negative.']);
  });

  it('defaults taxType to NONE', () => {
    const result = IsoPlusLineItemValues.validationSchema().validate({
      description: 'd',
      quantity: 1,
      unitAmount: 1,
      accountCode: '200',
    });
    expect(result.value.taxType).toBe('NONE');
  });
});

describe('IsoPlusInvoiceValues', () => {
  const contactID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('reads the contact id from a nested camelCase contact', () => {
    const invoice = new IsoPlusInvoiceValues({ type: 'ACCREC', contact: { contactID } });
    expect(invoice.contactID).toBe(contactID);
  });

  it('reads the contact id from a nested PascalCase Contact', () => {
    const invoice = new IsoPlusInvoiceValues({ Type: 'ACCREC', Contact: { ContactID: contactID } });
    expect(invoice.type).toBe('ACCREC');
    expect(invoice.contactID).toBe(contactID);
  });

  it('prefers a top-level contactID over the nested one', () => {
    const invoice = new IsoPlusInvoiceValues({
      contactID,
      contact: { contactID: '00000000-0000-4000-8000-000000000000' },
    });
    expect(invoice.contactID).toBe(contactID);
  });

  it('wraps every line item in an IsoPlusLineItemValues', () => {
    const invoice = new IsoPlusInvoiceValues({
      LineItems: [{ Description: 'a', Quantity: 1, UnitAmount: 5, AccountCode: '200' }],
    });
    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.lineItems[0]).toBeInstanceOf(IsoPlusLineItemValues);
    expect(invoice.lineItems[0].description).toBe('a');
  });

  it('defaults lineItems to an empty array when absent', () => {
    expect(new IsoPlusInvoiceValues({}).lineItems).toEqual([]);
  });

  it('does not read a PascalCase CustomerName, unlike every other field', () => {
    // Documents current behaviour: the fallback reads `customerName` twice.
    expect(new IsoPlusInvoiceValues({ CustomerName: 'Acme' }).customerName).toBeUndefined();
    expect(new IsoPlusInvoiceValues({ customerName: 'Acme' }).customerName).toBe('Acme');
  });

  it('accepts a complete invoice', () => {
    const result = IsoPlusInvoiceValues.validationSchema().validate({
      type: 'ACCREC',
      contactID,
      lineItems: [{ description: 'a', quantity: 1, unitAmount: 5, accountCode: '200' }],
    });
    expect(result.error).toBeUndefined();
  });

  it.each(['ACCPAY', 'ACCREC', 'QUOTE'])('accepts the %s document type', (type) => {
    const result = IsoPlusInvoiceValues.validationSchema().validate({
      type,
      contactID,
      lineItems: [{ description: 'a', quantity: 1, unitAmount: 5, accountCode: '200' }],
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects an unknown document type', () => {
    const result = IsoPlusInvoiceValues.validationSchema().validate({
      type: 'INVOICE',
      contactID,
      lineItems: [{ description: 'a', quantity: 1, unitAmount: 5, accountCode: '200' }],
    });
    expect(messagesOf(result)).toEqual(['Type must be ACCPAY, ACCREC, or QUOTE']);
  });

  it('rejects a non-GUID contact id', () => {
    const result = IsoPlusInvoiceValues.validationSchema().validate({
      type: 'ACCREC',
      contactID: 'contact-1',
      lineItems: [{ description: 'a', quantity: 1, unitAmount: 5, accountCode: '200' }],
    });
    expect(messagesOf(result)).toEqual(['ContactID must be a valid GUID.']);
  });

  it('requires at least one line item', () => {
    const result = IsoPlusInvoiceValues.validationSchema()
      .validate({ type: 'ACCREC', contactID, lineItems: [] });
    expect(messagesOf(result)).toEqual(['At least one LineItem is required']);
  });

  it('validates each nested line item', () => {
    const result = IsoPlusInvoiceValues.validationSchema().validate({
      type: 'ACCREC',
      contactID,
      lineItems: [{ description: 'a', quantity: 1, unitAmount: 0, accountCode: '200' }],
    });
    expect(messagesOf(result)).toEqual(['UnitAmount must not be 0']);
  });

  it('defaults the status to AUTHORISED', () => {
    const result = IsoPlusInvoiceValues.validationSchema().validate({
      type: 'ACCREC',
      contactID,
      lineItems: [{ description: 'a', quantity: 1, unitAmount: 5, accountCode: '200' }],
    });
    expect(result.value.status).toBe('AUTHORISED');
  });

  it('rejects a status outside AUTHORISED and DRAFT', () => {
    const result = IsoPlusInvoiceValues.validationSchema().validate({
      type: 'ACCREC',
      contactID,
      lineItems: [{ description: 'a', quantity: 1, unitAmount: 5, accountCode: '200' }],
      status: 'PAID',
    });
    expect(messagesOf(result)).toEqual(['Status must be either AUTHORISED or DRAFT']);
  });

  it('rejects an unknown lineAmountTypes', () => {
    const result = IsoPlusInvoiceValues.validationSchema().validate({
      type: 'ACCREC',
      contactID,
      lineItems: [{ description: 'a', quantity: 1, unitAmount: 5, accountCode: '200' }],
      lineAmountTypes: 'Gross',
    });
    expect(messagesOf(result)).toEqual(['LineAmountTypes must be Exclusive, Inclusive, or NoTax']);
  });
});

describe('Item', () => {
  it('stamps a uuid, the type, the values and a creation time', () => {
    const before = Date.now();
    const item = new Item('Contact', { client: 'Acme' });

    expect(item.id).toMatch(UUID_V4);
    expect(item.object).toBe('Contact');
    expect(item.values).toEqual({ client: 'Acme' });
    expect(item.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('gives two items different ids', () => {
    expect(new Item('Contact', {}).id).not.toBe(new Item('Contact', {}).id);
  });

  it.each([
    ['Contact', { client: 'Acme', emailAddress: 'a@b.example.com', phoneNumber: '04' }],
    ['Contractor', { Contractor: 'Acme', EmailAddress: 'a@b.example.com', PhoneNumber: '04' }],
    ['ServiceFeeType', { feeType: 'Hourly', rate: 10 }],
    ['JobType', { jobType: 'Support', jobCode: 'SUP' }],
    ['JobPlanning', { clientOrderNumber: 'PO', jobTitle: 'T', jobNumber: '1' }],
  ])('routes %s to its own schema and passes valid data', (type, data) => {
    expect(Item.validate(type, data).error).toBeUndefined();
  });

  it('routes each type to a schema that rejects the others’ data', () => {
    const contractorData = { Contractor: 'Acme', EmailAddress: 'a@b.example.com', PhoneNumber: '04' };
    expect(Item.validate('Contact', contractorData).error).toBeDefined();
    expect(Item.validate('Contractor', contractorData).error).toBeUndefined();
  });

  it.each([
    'Contact',
    'Contractor',
    'PurchaseOrder',
    'Job',
    'JobType',
    'JobPlanning',
    'ServiceFeeType',
    'Quote',
    'IsoPlusInvoice',
    'NDISPricing',
  ])('knows the %s type', (type) => {
    expect(() => Item.validate(type, {})).not.toThrow();
  });

  it('throws on an unknown type', () => {
    expect(() => Item.validate('Widget', {})).toThrow('Unknown item type');
    expect(() => Item.validate(undefined, {})).toThrow('Unknown item type');
  });

  it('is case-sensitive about the type name', () => {
    expect(() => Item.validate('contact', {})).toThrow('Unknown item type');
  });

  it('reports every problem rather than stopping at the first', () => {
    const result = Item.validate('Contact', {});
    expect(result.error.details.length).toBe(3);
  });
});

describe('Payload', () => {
  it('holds the items it was given by reference', () => {
    const items = [new Item('Contact', { client: 'Acme' })];
    expect(new Payload(items).items).toBe(items);
  });

  it('accepts an empty list', () => {
    expect(new Payload([]).items).toEqual([]);
  });
});
