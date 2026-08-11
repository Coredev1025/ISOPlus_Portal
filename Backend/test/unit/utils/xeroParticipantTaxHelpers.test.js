import { describe, it, expect, vi } from 'vitest';
import {
  resolveParticipantTaxDueDate,
  buildContactPayloadFromBilling,
  buildParticipantTaxContact,
  buildParticipantTaxLineItems,
} from '../../../src/utils/xeroParticipantTaxHelpers.js';

/**
 * Test doubles for the collaborators the route injects (routes/xero.js). They
 * are deliberately trivial and deterministic so every expectation below can be
 * hand-derived; the logic under test is the real module.
 */
function roundTo(value, dp) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, dp);
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

const round2 = (value) => roundTo(value, 2);
const round4 = (value) => roundTo(value, 4);

const getXeroServiceRowDate = (item) =>
  item.serviceDeliveryDate || item.scheduledServiceDate || '';

const appendDateSuffix = (description, rowDate) => {
  const base = String(description ?? '').trim() || 'Service';
  return rowDate ? `${base} - ${rowDate}` : base;
};

/** Builds the ctx buildParticipantTaxLineItems receives, recording the timezone. */
function lineItemContext(items, overrides = {}) {
  const timezonesSeen = [];
  const ctx = {
    items,
    isLowCatBoard: false,
    salesAccountCode: '200',
    gstType: 'EXEMPTOUTPUT',
    business: { headOfficeTimezone: 'Australia/Sydney' },
    getXeroServiceRowDate,
    appendDateSuffix,
    formatDdMmYyyy: (value, timeZone) => {
      timezonesSeen.push(timeZone);
      return value ? String(value).split('-').reverse().join('/') : '';
    },
    round2,
    round4,
    ...overrides,
  };
  return { ctx, timezonesSeen };
}

/** A service row as the participant-tax route posts it in req.body.items. */
function serviceItem(overrides = {}) {
  return {
    id: 'itm_5001',
    service: 'Community access support',
    quantity: 2,
    unitPrice: 60,
    totalAmount: 120,
    participantContribution: 30,
    transactionStatus: 'Delivered - To be claimed and invoiced.',
    scheduledServiceDate: '2026-06-01',
    serviceDeliveryDate: '2026-06-01',
    worker: 'Ann Reyes',
    notes: '',
    ...overrides,
  };
}

/** A Xero contact as xero-node returns it from getContacts. */
function xeroContact(overrides = {}) {
  return {
    contactID: 'c0ffee00-0000-4000-8000-000000000001',
    name: 'Jane Doe',
    emailAddress: 'jane@example.com',
    contactStatus: 'ACTIVE',
    updatedDateUTC: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveParticipantTaxDueDate', () => {
  it('takes the date part of a supplied due date', () => {
    expect(resolveParticipantTaxDueDate('2026-06-01T00:00:00.000Z', '2026-07-04T13:45:00.000Z'))
      .toBe('2026-07-04');
    expect(resolveParticipantTaxDueDate('2026-06-01', '2026-07-04')).toBe('2026-07-04');
  });

  it('returns the supplied due date untouched when asIsoString is set', () => {
    expect(resolveParticipantTaxDueDate('2026-06-01', '2026-07-04T13:45:00.000Z', true))
      .toBe('2026-07-04T13:45:00.000Z');
  });

  it('falls back to invoice date + 14 days when the due date is blank', () => {
    expect(resolveParticipantTaxDueDate('2026-06-01T00:00:00.000Z', '')).toBe('2026-06-15');
    expect(resolveParticipantTaxDueDate('2026-06-01T00:00:00.000Z', null)).toBe('2026-06-15');
    expect(resolveParticipantTaxDueDate('2026-06-01T00:00:00.000Z', undefined)).toBe('2026-06-15');
  });

  it('returns the +14 day fallback as a full ISO timestamp when asIsoString is set', () => {
    expect(resolveParticipantTaxDueDate('2026-06-01T00:00:00.000Z', '', true))
      .toBe('2026-06-15T00:00:00.000Z');
  });

  it('rolls the fallback over a month boundary', () => {
    expect(resolveParticipantTaxDueDate('2026-06-25T00:00:00.000Z', '')).toBe('2026-07-09');
  });

  it('throws RangeError when the invoice date is unparseable and no due date is given', () => {
    expect(() => resolveParticipantTaxDueDate('not-a-date', '')).toThrow(RangeError);
  });
});

describe('buildContactPayloadFromBilling', () => {
  it('splits the billing contact into first and last name and maps the address', () => {
    expect(buildContactPayloadFromBilling({
      billingContact: 'Jane van der Berg',
      email: 'jane@example.com',
      billingAddress: '12 Smith St, Sydney, NSW, 2000',
    })).toStrictEqual({
      Name: 'Jane van der Berg',
      FirstName: 'Jane',
      LastName: 'van der Berg',
      ContactStatus: 'ACTIVE',
      EmailAddress: 'jane@example.com',
      Addresses: [{
        AddressType: 'STREET',
        AddressLine1: '12 Smith St',
        City: 'Sydney',
        Region: 'NSW',
        PostalCode: '2000',
      }],
    });
  });

  it('leaves LastName empty for a single-word contact', () => {
    const payload = buildContactPayloadFromBilling({
      billingContact: 'Acme',
      email: '',
      billingAddress: '',
    });

    expect(payload.FirstName).toBe('Acme');
    expect(payload.LastName).toBe('');
  });

  it('sets EmailAddress to undefined rather than an empty string', () => {
    const payload = buildContactPayloadFromBilling({
      billingContact: 'Jane Doe',
      email: '',
      billingAddress: '',
    });

    expect(payload.EmailAddress).toBeUndefined();
    expect('EmailAddress' in payload).toBe(true);
  });

  it('omits Addresses entirely for an empty or whitespace-only address', () => {
    expect(buildContactPayloadFromBilling({
      billingContact: 'Jane Doe',
      email: 'jane@example.com',
      billingAddress: '',
    })).toStrictEqual({
      Name: 'Jane Doe',
      FirstName: 'Jane',
      LastName: 'Doe',
      ContactStatus: 'ACTIVE',
      EmailAddress: 'jane@example.com',
    });

    expect(buildContactPayloadFromBilling({
      billingContact: 'Jane Doe',
      email: '',
      billingAddress: '   ',
    }).Addresses).toBeUndefined();

    expect(buildContactPayloadFromBilling({
      billingContact: 'Jane Doe',
      email: '',
      billingAddress: undefined,
    }).Addresses).toBeUndefined();
  });

  it('leaves the trailing address fields undefined when only a street is given', () => {
    expect(buildContactPayloadFromBilling({
      billingContact: 'Jane Doe',
      email: '',
      billingAddress: '12 Smith St',
    }).Addresses).toStrictEqual([{
      AddressType: 'STREET',
      AddressLine1: '12 Smith St',
      City: undefined,
      Region: undefined,
      PostalCode: undefined,
    }]);
  });

  it('drops empty segments produced by doubled commas so later fields shift up', () => {
    expect(buildContactPayloadFromBilling({
      billingContact: 'Jane Doe',
      email: '',
      billingAddress: '12 Smith St,, Sydney , NSW',
    }).Addresses).toStrictEqual([{
      AddressType: 'STREET',
      AddressLine1: '12 Smith St',
      City: 'Sydney',
      Region: 'NSW',
      PostalCode: undefined,
    }]);
  });
});

describe('buildParticipantTaxContact', () => {
  it('returns the contact found by email without looking it up by name', async () => {
    const found = xeroContact();
    const getContactByEmail = vi.fn().mockResolvedValue(found);
    const getContactByName = vi.fn();
    const createOrUpdateContact = vi.fn();

    const contact = await buildParticipantTaxContact({
      billingContact: 'Jane Doe',
      participantProfile: { billingEmail: '  jane@example.com  ', billingAddress: '' },
      getContactByEmail,
      getContactByName,
      createOrUpdateContact,
    });

    expect(contact).toBe(found);
    expect(getContactByEmail).toHaveBeenCalledWith('jane@example.com');
    expect(getContactByName).not.toHaveBeenCalled();
    expect(createOrUpdateContact).not.toHaveBeenCalled();
  });

  it('skips the email lookup entirely when there is no billing email', async () => {
    const found = xeroContact();
    const getContactByEmail = vi.fn();
    const getContactByName = vi.fn().mockResolvedValue(found);
    const createOrUpdateContact = vi.fn();

    const contact = await buildParticipantTaxContact({
      billingContact: 'Jane Doe',
      participantProfile: { billingEmail: '   ', billingAddress: '', updatedAt: '2026-07-01T00:00:00.000Z' },
      getContactByEmail,
      getContactByName,
      createOrUpdateContact,
    });

    expect(getContactByEmail).not.toHaveBeenCalled();
    expect(getContactByName).toHaveBeenCalledWith('Jane Doe');
    expect(contact).toBe(found);
    expect(createOrUpdateContact).not.toHaveBeenCalled();
  });

  it('patches the email onto the name match when the ISO+ profile is newer', async () => {
    const nameContact = xeroContact({ updatedDateUTC: '2026-05-01T00:00:00.000Z' });
    const patched = xeroContact({ emailAddress: 'new@example.com', updatedDateUTC: '2026-08-01T00:00:00.000Z' });
    const createOrUpdateContact = vi.fn().mockResolvedValue(patched);

    const contact = await buildParticipantTaxContact({
      billingContact: 'Jane Doe',
      participantProfile: {
        billingEmail: 'new@example.com',
        billingAddress: '12 Smith St, Sydney',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      getContactByEmail: vi.fn().mockResolvedValue(null),
      getContactByName: vi.fn().mockResolvedValue(nameContact),
      createOrUpdateContact,
    });

    expect(createOrUpdateContact).toHaveBeenCalledTimes(1);
    expect(createOrUpdateContact).toHaveBeenCalledWith({
      contactID: 'c0ffee00-0000-4000-8000-000000000001',
      EmailAddress: 'new@example.com',
    });
    expect(contact).toBe(patched);
  });

  it('keeps the Xero contact untouched when it is newer than the ISO+ profile', async () => {
    const nameContact = xeroContact({ updatedDateUTC: '2026-07-01T00:00:00.000Z' });
    const createOrUpdateContact = vi.fn();

    const contact = await buildParticipantTaxContact({
      billingContact: 'Jane Doe',
      participantProfile: {
        billingEmail: 'new@example.com',
        billingAddress: '',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      getContactByEmail: vi.fn().mockResolvedValue(null),
      getContactByName: vi.fn().mockResolvedValue(nameContact),
      createOrUpdateContact,
    });

    expect(contact).toBe(nameContact);
    expect(createOrUpdateContact).not.toHaveBeenCalled();
  });

  it('keeps the Xero contact untouched when either timestamp is unparseable', async () => {
    const nameContact = xeroContact({ updatedDateUTC: 'not-a-date' });
    const createOrUpdateContact = vi.fn();

    const contact = await buildParticipantTaxContact({
      billingContact: 'Jane Doe',
      participantProfile: {
        billingEmail: 'new@example.com',
        billingAddress: '',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      getContactByEmail: vi.fn().mockResolvedValue(null),
      getContactByName: vi.fn().mockResolvedValue(nameContact),
      createOrUpdateContact,
    });

    expect(contact).toBe(nameContact);
    expect(createOrUpdateContact).not.toHaveBeenCalled();
  });

  it('creates a contact from the billing details when neither lookup matches', async () => {
    const created = xeroContact({ contactID: 'c0ffee00-0000-4000-8000-000000000009' });
    const createOrUpdateContact = vi.fn().mockResolvedValue(created);

    const contact = await buildParticipantTaxContact({
      billingContact: 'Jane Doe',
      participantProfile: {
        billingEmail: 'jane@example.com',
        billingAddress: '12 Smith St, Sydney, NSW, 2000',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      getContactByEmail: vi.fn().mockResolvedValue(null),
      getContactByName: vi.fn().mockResolvedValue(null),
      createOrUpdateContact,
    });

    expect(createOrUpdateContact).toHaveBeenCalledWith({
      Name: 'Jane Doe',
      FirstName: 'Jane',
      LastName: 'Doe',
      ContactStatus: 'ACTIVE',
      EmailAddress: 'jane@example.com',
      Addresses: [{
        AddressType: 'STREET',
        AddressLine1: '12 Smith St',
        City: 'Sydney',
        Region: 'NSW',
        PostalCode: '2000',
      }],
    });
    expect(contact).toBe(created);
  });
});

describe('buildParticipantTaxLineItems', () => {
  it('bills the participant contribution and derives the unit amount', () => {
    const { ctx } = lineItemContext([serviceItem()]);

    expect(buildParticipantTaxLineItems(ctx)).toEqual({
      lineItems: [{
        description: 'Community access support - 01/06/2026',
        quantity: 2,
        unitAmount: 15,
        lineAmount: 30,
        accountCode: '200',
        taxType: 'EXEMPTOUTPUT',
      }],
      totalAmount: 30,
    });
  });

  it('bills the full item total on a low-cat board', () => {
    const { ctx } = lineItemContext([serviceItem()], { isLowCatBoard: true });
    const { lineItems, totalAmount } = buildParticipantTaxLineItems(ctx);

    expect(lineItems[0].lineAmount).toBe(120);
    expect(lineItems[0].unitAmount).toBe(60);
    expect(totalAmount).toBe(120);
  });

  it('falls back to the item total when participantContribution is absent', () => {
    const item = serviceItem({ quantity: 4, totalAmount: 80 });
    delete item.participantContribution;
    const { ctx } = lineItemContext([item]);
    const { lineItems } = buildParticipantTaxLineItems(ctx);

    expect(lineItems[0].lineAmount).toBe(80);
    expect(lineItems[0].unitAmount).toBe(20);
  });

  it('drops zero-value lines and sums only the lines it kept', () => {
    const { ctx } = lineItemContext([
      serviceItem({ id: 'itm_a', participantContribution: 0 }),
      serviceItem({ id: 'itm_b', participantContribution: 25, quantity: 1 }),
      serviceItem({ id: 'itm_c', participantContribution: 12.5, quantity: 1 }),
    ]);
    const { lineItems, totalAmount } = buildParticipantTaxLineItems(ctx);

    expect(lineItems).toHaveLength(2);
    expect(lineItems.map((l) => l.lineAmount)).toEqual([25, 12.5]);
    expect(totalAmount).toBe(37.5);
  });

  it('returns nothing for an empty item list', () => {
    const { ctx } = lineItemContext([]);
    expect(buildParticipantTaxLineItems(ctx)).toEqual({ lineItems: [], totalAmount: 0 });
  });

  it('treats a zero quantity as one unit', () => {
    const { ctx } = lineItemContext([serviceItem({ quantity: 0, participantContribution: 42 })]);
    const { lineItems } = buildParticipantTaxLineItems(ctx);

    expect(lineItems[0].quantity).toBe(1);
    expect(lineItems[0].unitAmount).toBe(42);
  });

  it('takes the absolute value of a negative quantity', () => {
    const { ctx } = lineItemContext([serviceItem({ quantity: -2, participantContribution: 50 })]);
    const { lineItems } = buildParticipantTaxLineItems(ctx);

    expect(lineItems[0].quantity).toBe(2);
    expect(lineItems[0].unitAmount).toBe(25);
  });

  it('coerces a string quantity', () => {
    const { ctx } = lineItemContext([serviceItem({ quantity: '3', participantContribution: 90 })]);
    const { lineItems } = buildParticipantTaxLineItems(ctx);

    expect(lineItems[0].quantity).toBe(3);
    expect(lineItems[0].unitAmount).toBe(30);
  });

  it('emits a NaN quantity and the item unit price when the quantity is not numeric', () => {
    const { ctx } = lineItemContext([
      serviceItem({ quantity: 'two', unitPrice: 45, participantContribution: 90 }),
    ]);
    const { lineItems } = buildParticipantTaxLineItems(ctx);

    expect(Number.isNaN(lineItems[0].quantity)).toBe(true);
    expect(lineItems[0].unitAmount).toBe(45);
    expect(lineItems[0].lineAmount).toBe(90);
  });

  it('falls back to the line amount when the quantity is not numeric and there is no unit price', () => {
    const { ctx } = lineItemContext([
      serviceItem({ quantity: 'two', unitPrice: 0, participantContribution: 90 }),
    ]);
    const { lineItems } = buildParticipantTaxLineItems(ctx);

    expect(lineItems[0].unitAmount).toBe(90);
  });

  it('rounds the derived unit amount to four decimal places, leaving the line amount at two', () => {
    const { ctx } = lineItemContext([serviceItem({ quantity: 3, participantContribution: 100 })]);
    const { lineItems } = buildParticipantTaxLineItems(ctx);

    expect(lineItems[0].unitAmount).toBe(33.3333);
    expect(lineItems[0].lineAmount).toBe(100);
  });

  it('uses the service name, then the de-tagged notes, then the worker, then "Service"', () => {
    const { ctx } = lineItemContext([
      serviceItem({ id: 'a', service: '   ', notes: '<p>Respite <b>overnight</b></p>' }),
      serviceItem({ id: 'b', service: '', notes: '   ', worker: '  Ann Reyes  ' }),
      serviceItem({ id: 'c', service: null, notes: null, worker: null }),
      serviceItem({ id: 'd', service: 42, notes: undefined, worker: undefined }),
    ]);
    const { lineItems } = buildParticipantTaxLineItems(ctx);

    expect(lineItems.map((l) => l.description)).toEqual([
      'Respite overnight - 01/06/2026',
      'Ann Reyes - 01/06/2026',
      'Service - 01/06/2026',
      'Service - 01/06/2026',
    ]);
  });

  it('omits the date suffix when the row has no service date', () => {
    const item = serviceItem({ scheduledServiceDate: '', serviceDeliveryDate: '' });
    const { ctx } = lineItemContext([item]);
    const { lineItems } = buildParticipantTaxLineItems(ctx);

    expect(lineItems[0].description).toBe('Community access support');
  });

  it('formats the row date in the business head-office timezone', () => {
    const { ctx, timezonesSeen } = lineItemContext([serviceItem()], {
      business: { headOfficeTimezone: 'Australia/Perth' },
    });
    buildParticipantTaxLineItems(ctx);

    expect(timezonesSeen).toEqual(['Australia/Perth']);
  });

  it('defaults to Australia/Sydney when the business has no timezone', () => {
    const { ctx: noTz, timezonesSeen: seenA } = lineItemContext([serviceItem()], { business: null });
    buildParticipantTaxLineItems(noTz);
    expect(seenA).toEqual(['Australia/Sydney']);

    const { ctx: blankTz, timezonesSeen: seenB } = lineItemContext([serviceItem()], {
      business: { headOfficeTimezone: '' },
    });
    buildParticipantTaxLineItems(blankTz);
    expect(seenB).toEqual(['Australia/Sydney']);
  });
});
