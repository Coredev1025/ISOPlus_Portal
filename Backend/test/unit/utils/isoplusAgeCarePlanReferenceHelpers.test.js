import { describe, it, expect, vi } from 'vitest';
import { fetchAgeCareParticipantsServicePlanReferencedItems } from '../../../src/utils/isoplusAgeCarePlanReferenceHelpers.js';

// The module exports a single orchestrator; every builder is private and only
// reachable through a reference whose attribute name selects it. Each test
// therefore drives one attribute name and asserts the slot it lands in.
const value = (name, data) => ({ attribute: { name }, data });

const WS = 'ws-1';
const BOARD = 'board-1';
const ITEM = 'plan-1';

// Positional meaning of the returned tuple, hand-derived from the return statement.
const [PROFILE, HOME_SUPPORT, AT_SHORT, AT_ONGOING, HOME_MOD, HEALTH_PRO, WRAPAROUND] = [0, 1, 2, 3, 4, 5, 6];

function run({ references, attributes = {}, items = {} }) {
  const calls = { getReferences: [], getAttribute: [], getItemValues: [] };
  const promise = fetchAgeCareParticipantsServicePlanReferencedItems({
    workspaceId: WS,
    boardId: BOARD,
    itemId: ITEM,
    getReferences: vi.fn(async (...a) => {
      calls.getReferences.push(a);
      return references;
    }),
    getAttribute: vi.fn(async (...a) => {
      calls.getAttribute.push(a);
      return attributes[a[2]];
    }),
    getItemValues: vi.fn(async (...a) => {
      calls.getItemValues.push(a);
      return items[a[2]];
    }),
  });
  return { promise, calls };
}

/** One reference, wired to `attributeName`, pointing at `item`. */
function single(attributeName, item) {
  return run({
    references: { data: [{ attribute_id: 'attr', to_item_id: 'target' }] },
    attributes: { attr: { name: attributeName } },
    items: { target: item },
  });
}

const fullProfile = {
  id: 'pp-1',
  values: [
    value('Full Name/Preferred Name', 'Margaret Chen'),
    value('First Name', 'Margaret'),
    value('Last Name', 'Chen'),
    value('Email', 'margaret@example.test'),
    value('Primary Phone Number', '0400 111 222'),
    value('Address', '5 Rose Court'),
    value('Suburb', 'Camberwell'),
    value('State', 'VIC'),
    value('Postcode', 3124),
    value('Billing Contact', 'Alan Chen'),
    value('Billing Address', 'PO Box 44'),
  ],
};

const homeSupportItem = {
  id: 'hs-1',
  values: [
    value('Service', 'Domestic assistance'),
    value('Service Type', 'Home Support'),
    value('Unit Type', 'Hour'),
    value('Price ($)', '$68.25'),
    value('Participant Contribution Guideline (%)', '17.5'),
    value('Wraparound', 'No'),
    value('Service ID /  Item ID', 'SVC-001'),
    value('Item ID', 'ITM-001'),
    value('Item', 'Domestic assistance - standard'),
  ],
};

describe('fetchAgeCareParticipantsServicePlanReferencedItems', () => {
  describe('Participant Profile', () => {
    it('maps every profile field, stringifying non-string data', async () => {
      const { promise } = single('Participant Profile', fullProfile);
      const result = await promise;

      expect(result[PROFILE]).toEqual({
        id: 'pp-1',
        fullName: 'Margaret Chen',
        firstName: 'Margaret',
        lastName: 'Chen',
        email: 'margaret@example.test',
        phone: '0400 111 222',
        address: '5 Rose Court',
        suburb: 'Camberwell',
        state: 'VIC',
        postcode: '3124',
        billingContact: 'Alan Chen',
        billingAddress: 'PO Box 44',
      });
    });

    it('defaults every optional field to an empty string when only the required name is present', async () => {
      const { promise } = single('Participant Profile', {
        id: 'pp-2',
        values: [value('Full Name/Preferred Name', 'Solo')],
      });

      expect(await promise).toEqual([
        {
          id: 'pp-2',
          fullName: 'Solo',
          firstName: '',
          lastName: '',
          email: '',
          phone: '',
          address: '',
          suburb: '',
          state: '',
          postcode: '',
          billingContact: '',
          billingAddress: '',
        },
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
    });

    it('coerces a null data value to an empty string rather than throwing', async () => {
      const { promise } = single('Participant Profile', {
        id: 'pp-3',
        values: [value('Full Name/Preferred Name', 'Solo'), value('Email', null)],
      });
      expect((await promise)[PROFILE].email).toBe('');
    });

    it('throws when Full Name/Preferred Name is absent', async () => {
      const { promise } = single('Participant Profile', { id: 'pp-4', values: [value('First Name', 'Only')] });
      await expect(promise).rejects.toThrow('Full Name/Preferred Name is required');
    });

    it('leaves the slot null when the referenced item cannot be fetched', async () => {
      const { promise } = run({
        references: { data: [{ attribute_id: 'attr', to_item_id: 'gone' }] },
        attributes: { attr: { name: 'Participant Profile' } },
        items: {},
      });
      expect(await promise).toEqual([null, null, null, null, null, null, null]);
    });
  });

  describe('service catalog attributes', () => {
    it('maps a Home Support catalog entry, stripping the dollar sign from the price', async () => {
      const { promise } = single('Home Support (HS)', homeSupportItem);
      const result = await promise;

      expect(result[HOME_SUPPORT]).toEqual({
        id: 'hs-1',
        service: 'Domestic assistance',
        serviceType: 'Home Support',
        unit: 'Hour',
        unitPrice: '68.25',
        participantContributionGuideline: '17.5',
        wraparound: 'No',
        serviceIDItemID: 'SVC-001',
        itemID: 'ITM-001',
        item: 'Domestic assistance - standard',
      });
      expect(result[PROFILE]).toBeNull();
    });

    it.each([
      ['Assistive Technology (AT) - Short Term', AT_SHORT],
      ['Assistive Technology (AT) - Ongoing', AT_ONGOING],
      ['Home Modification (HM)', HOME_MOD],
    ])('routes %s into its own slot', async (attributeName, slot) => {
      const { promise } = single(attributeName, homeSupportItem);
      const result = await promise;

      expect(result[slot]).toMatchObject({ id: 'hs-1', service: 'Domestic assistance', unitPrice: '68.25' });
      expect(result[HOME_SUPPORT]).toBeNull();
    });

    it.each([
      ['$1,200.00', '1,200.00'],
      ['120.5', '120.5'],
      ['$0', '0'],
      ['0', '0'],
      ['$', '0'],
      ['', '0'],
      ['$50 per $hour', '50 per $hour'],
    ])('turns a Price ($) of %j into unitPrice %j', async (price, expected) => {
      const { promise } = single('Home Support (HS)', {
        id: 'p-1',
        values: [value('Service', 'S'), value('Price ($)', price)],
      });
      expect((await promise)[HOME_SUPPORT].unitPrice).toBe(expected);
    });

    it('falls back to "0" when Price ($) is absent entirely', async () => {
      const { promise } = single('Home Support (HS)', { id: 'p-2', values: [value('Service', 'S')] });
      expect((await promise)[HOME_SUPPORT].unitPrice).toBe('0');
    });

    it('throws when Service is absent', async () => {
      const { promise } = single('Home Support (HS)', { id: 'p-3', values: [value('Unit Type', 'Hour')] });
      await expect(promise).rejects.toThrow('Service is required');
    });

    it('adds the two health-professional fields on top of the catalog shape', async () => {
      const { promise } = single('Health Professional', {
        id: 'hp-1',
        values: [
          ...homeSupportItem.values,
          value('Health Professional Type Code', 'HP-12'),
          value('Health Professional Type', 'Physiotherapist'),
        ],
      });
      const result = await promise;

      expect(result[HEALTH_PRO]).toEqual({
        id: 'hp-1',
        service: 'Domestic assistance',
        serviceType: 'Home Support',
        unit: 'Hour',
        unitPrice: '68.25',
        participantContributionGuideline: '17.5',
        wraparound: 'No',
        serviceIDItemID: 'SVC-001',
        itemID: 'ITM-001',
        item: 'Domestic assistance - standard',
        healthProfessionalTypeCode: 'HP-12',
        healthProfessionalTypeOther: 'Physiotherapist',
      });
    });

    it('still requires Service for a Health Professional entry', async () => {
      const { promise } = single('Health Professional', {
        id: 'hp-2',
        values: [value('Health Professional Type Code', 'HP-12')],
      });
      await expect(promise).rejects.toThrow('Service is required');
    });
  });

  describe('Wraparound', () => {
    it('maps the wraparound-specific shape, which is not the catalog shape', async () => {
      const { promise } = single('Wraparound', {
        id: 'wr-1',
        values: [
          value('Wraparound Item ID', 'WR-001'),
          value('Wraparound Description', 'Transport surcharge'),
          value('Unit Type', 'Each'),
          value('Price ($)', '$14.90'),
          value('Participant Contribution Guideline (%)', '0'),
          value('Service', 'ignored'),
        ],
      });
      const result = await promise;

      expect(result[WRAPAROUND]).toEqual({
        id: 'wr-1',
        itemID: 'WR-001',
        wraparoundDescription: 'Transport surcharge',
        unit: 'Each',
        unitPrice: '14.90',
        participantContributionGuideline: '0',
      });
    });

    it('defaults the wraparound price to "0" when absent', async () => {
      const { promise } = single('Wraparound', {
        id: 'wr-2',
        values: [value('Wraparound Description', 'No price')],
      });
      expect((await promise)[WRAPAROUND].unitPrice).toBe('0');
    });

    it('throws when Wraparound Description is absent', async () => {
      const { promise } = single('Wraparound', { id: 'wr-3', values: [value('Wraparound Item ID', 'WR-003')] });
      await expect(promise).rejects.toThrow('Wraparound Description is required');
    });
  });

  describe('reference traversal', () => {
    it('fills several slots from one reference response and passes ids through unchanged', async () => {
      const { promise, calls } = run({
        references: {
          data: [
            { attribute_id: 'a-pp', to_item_id: 'i-pp' },
            { attribute_id: 'a-hs', to_item_id: 'i-hs' },
            { attribute_id: 'a-wr', to_item_id: 'i-wr' },
          ],
        },
        attributes: {
          'a-pp': { name: 'Participant Profile' },
          'a-hs': { name: 'Home Support (HS)' },
          'a-wr': { name: 'Wraparound' },
        },
        items: {
          'i-pp': fullProfile,
          'i-hs': homeSupportItem,
          'i-wr': { id: 'wr-1', values: [value('Wraparound Description', 'Transport')] },
        },
      });
      const result = await promise;

      expect(result[PROFILE].id).toBe('pp-1');
      expect(result[HOME_SUPPORT].id).toBe('hs-1');
      expect(result[WRAPAROUND].id).toBe('wr-1');
      expect([result[AT_SHORT], result[AT_ONGOING], result[HOME_MOD], result[HEALTH_PRO]]).toEqual([
        null,
        null,
        null,
        null,
      ]);

      expect(calls.getReferences).toEqual([[WS, BOARD, ITEM]]);
      expect(calls.getAttribute).toEqual([
        [WS, BOARD, 'a-pp'],
        [WS, BOARD, 'a-hs'],
        [WS, BOARD, 'a-wr'],
      ]);
      expect(calls.getItemValues).toEqual([
        [WS, BOARD, 'i-pp'],
        [WS, BOARD, 'i-hs'],
        [WS, BOARD, 'i-wr'],
      ]);
    });

    it('returns a two-element [null, null] — not the seven-element tuple — when getReferences is falsy', async () => {
      const { promise, calls } = run({ references: null });
      const result = await promise;

      expect(result).toEqual([null, null]);
      expect(result).toHaveLength(2);
      expect(calls.getAttribute).toEqual([]);
    });

    it('returns seven nulls for an empty reference list', async () => {
      const { promise } = run({ references: { data: [] } });
      const result = await promise;
      expect(result).toEqual([null, null, null, null, null, null, null]);
      expect(result).toHaveLength(7);
    });

    it('skips a reference whose attribute cannot be resolved and continues with the rest', async () => {
      const { promise, calls } = run({
        references: {
          data: [
            { attribute_id: 'a-missing', to_item_id: 'ghost' },
            { attribute_id: 'a-hs', to_item_id: 'i-hs' },
          ],
        },
        attributes: { 'a-hs': { name: 'Home Support (HS)' } },
        items: { 'i-hs': homeSupportItem },
      });

      expect((await promise)[HOME_SUPPORT].id).toBe('hs-1');
      expect(calls.getItemValues).toEqual([[WS, BOARD, 'i-hs']]);
    });

    it('ignores an attribute name that is not in the handler map, without fetching its item', async () => {
      const { promise, calls } = run({
        references: { data: [{ attribute_id: 'a-x', to_item_id: 'i-x' }] },
        attributes: { 'a-x': { name: 'Restorative Care' } },
        items: { 'i-x': homeSupportItem },
      });

      expect(await promise).toEqual([null, null, null, null, null, null, null]);
      expect(calls.getItemValues).toEqual([]);
    });

    it('is case-sensitive about attribute names', async () => {
      const { promise } = single('home support (hs)', homeSupportItem);
      expect((await promise)[HOME_SUPPORT]).toBeNull();
    });

    it('keeps an earlier resolved value when a later reference for the same attribute resolves to null', async () => {
      const { promise } = run({
        references: {
          data: [
            { attribute_id: 'a-hs', to_item_id: 'i-hs' },
            { attribute_id: 'a-hs', to_item_id: 'gone' },
          ],
        },
        attributes: { 'a-hs': { name: 'Home Support (HS)' } },
        items: { 'i-hs': homeSupportItem },
      });

      expect((await promise)[HOME_SUPPORT].id).toBe('hs-1');
    });

    it('lets a later reference overwrite an earlier one when it does resolve', async () => {
      const { promise } = run({
        references: {
          data: [
            { attribute_id: 'a-hs', to_item_id: 'first' },
            { attribute_id: 'a-hs', to_item_id: 'second' },
          ],
        },
        attributes: { 'a-hs': { name: 'Home Support (HS)' } },
        items: {
          first: { id: 'first', values: [value('Service', 'A')] },
          second: { id: 'second', values: [value('Service', 'B')] },
        },
      });

      expect((await promise)[HOME_SUPPORT]).toMatchObject({ id: 'second', service: 'B' });
    });

    it('throws when the reference response carries no data array', async () => {
      const { promise } = run({ references: { meta: {} } });
      await expect(promise).rejects.toThrow(TypeError);
    });
  });
});
