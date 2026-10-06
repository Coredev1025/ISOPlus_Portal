import { describe, it, expect, vi } from 'vitest';
import { fetchNdisMasterPlanReferencedItems } from '../../../src/utils/isoplusNdisMasterPlanHelpers.js';
import { ITEM_DELETED } from '../../../src/services/isoplus.js';

const value = (name, data) => ({ attribute: { name }, data });

const WS = 'ws-1';
const BOARD = 'board-1';
const ITEM = 'master-1';

// Positional meaning of the returned tuple, hand-derived from the return statement.
const [SERVICE_PLAN, CANCELLATION, FUND, PROFILE, PARTICIPATION] = [0, 1, 2, 3, 4];

function run({ references, attributes = {}, items = {}, planRefs = [null, null, null, null, null] }) {
  const calls = { getReferences: [], getAttribute: [], getItemValues: [], planRefs: [] };
  const promise = fetchNdisMasterPlanReferencedItems({
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
    getParticipantsPlanRefs: vi.fn(async (...a) => {
      calls.planRefs.push(a);
      return typeof planRefs === 'function' ? planRefs(...a) : planRefs;
    }),
  });
  return { promise, calls };
}

function single(attributeName, item, extra = {}) {
  return run({
    references: { data: [{ attribute_id: 'attr', to_item_id: 'target' }] },
    attributes: { attr: { name: attributeName } },
    items: { target: item },
    ...extra,
  });
}

const UNIT_VALUES = [
  value('Unit (Direct Support)', 'Hour'),
  value('Agreed Unit Price for Direct Support ($)', '67.56'),
  value('Unit (Provider Travel - Non-Labour Cost)', 'Kilometre'),
  value('Agreed Unit Price for Non-Labour Travel ($)', '0.97'),
  value('Unit (Activity Based Transport)', 'Kilometre'),
  value('Agreed Price for Activity Based Transport ($)', '1.10'),
  value('Unit (Centre Capital Costs)', 'Hour'),
  value('Agreed Unit Price for Centre Capital Costs($)', '2.36'),
  value('Unit (Labour Travel Time)', 'Hour'),
  value('Agreed Unit Price for Labour Travel Time ($)', '67.56'),
  value('Unit (Allowances)', 'Each'),
  value('Agreed Price for Allowances($)', '15.00'),
  value('Unit (Non-Face-to-Face Support)', 'Hour'),
  value('Agreed Unit Price for Non-Face-to-Face Support($)', '67.56'),
];

const ALL_UNIT_KEYS = [
  'directSupportUnit',
  'directSupportUnitPrice',
  'nonLabourTravelUnit',
  'nonLabourTravelUnitPrice',
  'activityBasedTransportUnit',
  'activityBasedTransportUnitPrice',
  'centreCapitalCostsUnit',
  'centreCapitalCostsUnitPrice',
  'labourTravelTimeUnit',
  'labourTravelTimeUnitPrice',
  'usedAllowanceUnit',
  'usedAllowanceAmount',
  'nonFaceToFaceSupportUnit',
  'nonFaceToFaceSupportUnitPrice',
];

const line = (itemNumber, itemName, shortNoticeCancellations) => ({
  itemNumber,
  itemName,
  shortNoticeCancellations,
});

describe('fetchNdisMasterPlanReferencedItems', () => {
  describe('Service Plan', () => {
    const fullPlanRefs = [
      { id: 'profile-ignored' },
      line('01_011_0107_1_1', 'Assistance With Self-Care Activities', 'Yes'),
      line('02_051_0108_1_1', 'Provider Travel - Non-Labour Costs', 'No'),
      line('02_052_0108_1_1', 'Activity Based Transport', 'Yes'),
      line('04_599_0104_6_1', 'Centre Capital Costs', 'No'),
    ];

    it('joins the four line-item references with the plan item unit attributes', async () => {
      const { promise, calls } = single(
        'Service Plan',
        { id: 'sp-1', values: UNIT_VALUES },
        { planRefs: fullPlanRefs },
      );
      const result = await promise;

      expect(result[SERVICE_PLAN]).toEqual({
        directSupportItemNumber: '01_011_0107_1_1',
        directSupportItemName: 'Assistance With Self-Care Activities',
        directSupportUnit: 'Hour',
        directSupportUnitPrice: '67.56',
        providerTravelItemNumber: '02_051_0108_1_1',
        providerTravelItemName: 'Provider Travel - Non-Labour Costs',
        nonLabourTravelUnit: 'Kilometre',
        nonLabourTravelUnitPrice: '0.97',
        activityBasedTransportItemNumber: '02_052_0108_1_1',
        activityBasedTransportItemName: 'Activity Based Transport',
        activityBasedTransportUnit: 'Kilometre',
        activityBasedTransportUnitPrice: '1.10',
        centreCapitalCostsItemNumber: '04_599_0104_6_1',
        centreCapitalCostsItemName: 'Centre Capital Costs',
        centreCapitalCostsUnit: 'Hour',
        centreCapitalCostsUnitPrice: '2.36',
        labourTravelTimeUnit: 'Hour',
        labourTravelTimeUnitPrice: '67.56',
        usedAllowanceUnit: 'Each',
        usedAllowanceAmount: '15.00',
        nonFaceToFaceSupportUnit: 'Hour',
        nonFaceToFaceSupportUnitPrice: '67.56',
        directSupportShortNoticeCancellations: 'Yes',
        providerTravelShortNoticeCancellations: 'No',
        activityBasedTransportShortNoticeCancellations: 'Yes',
        centreCapitalCostsShortNoticeCancellations: 'No',
      });

      // The nested lookup is scoped to the referenced service-plan item, not the master plan item.
      expect(calls.planRefs).toEqual([[WS, BOARD, 'target']]);
    });

    it('skips the first element of the nested tuple — the participant profile is not read here', async () => {
      const { promise } = single(
        'Service Plan',
        { id: 'sp-1', values: [] },
        { planRefs: [line('SHOULD_NOT_APPEAR', 'SHOULD_NOT_APPEAR', 'Yes'), null, null, null, null] },
      );
      expect((await promise)[SERVICE_PLAN].directSupportItemNumber).toBe('');
    });

    it('substitutes empty strings for every line-item field when the nested lookup returns nulls', async () => {
      const { promise } = single('Service Plan', { id: 'sp-1', values: UNIT_VALUES }, { planRefs: [null, null] });
      const plan = (await promise)[SERVICE_PLAN];

      expect(plan.directSupportItemNumber).toBe('');
      expect(plan.directSupportItemName).toBe('');
      expect(plan.providerTravelItemNumber).toBe('');
      expect(plan.activityBasedTransportItemName).toBe('');
      expect(plan.centreCapitalCostsItemNumber).toBe('');
      expect(plan.directSupportShortNoticeCancellations).toBe('');
      expect(plan.centreCapitalCostsShortNoticeCancellations).toBe('');
      // Unit fields still come from the item itself.
      expect(plan.directSupportUnitPrice).toBe('67.56');
    });

    it('substitutes empty strings for individually falsy line-item fields', async () => {
      const { promise } = single(
        'Service Plan',
        { id: 'sp-1', values: [] },
        { planRefs: [null, { itemNumber: '', itemName: 0, shortNoticeCancellations: null }, null, null, null] },
      );
      const plan = (await promise)[SERVICE_PLAN];
      expect(plan.directSupportItemNumber).toBe('');
      expect(plan.directSupportItemName).toBe('');
      expect(plan.directSupportShortNoticeCancellations).toBe('');
    });

    it('reports every missing unit attribute as null, not as an empty string', async () => {
      const { promise } = single('Service Plan', { id: 'sp-1', values: [] });
      const plan = (await promise)[SERVICE_PLAN];

      for (const key of ALL_UNIT_KEYS) {
        expect(plan[key], key).toBeNull();
      }
    });

    it('treats a non-array values property as no values at all', async () => {
      const { promise } = single('Service Plan', { id: 'sp-1', values: undefined });
      const plan = (await promise)[SERVICE_PLAN];
      expect(plan.directSupportUnit).toBeNull();
      expect(plan.directSupportItemNumber).toBe('');
    });

    it('stringifies numeric unit data and keeps an empty string distinct from a missing attribute', async () => {
      const { promise } = single('Service Plan', {
        id: 'sp-1',
        values: [value('Agreed Unit Price for Direct Support ($)', 67.56), value('Unit (Direct Support)', '')],
      });
      const plan = (await promise)[SERVICE_PLAN];
      expect(plan.directSupportUnitPrice).toBe('67.56');
      expect(plan.directSupportUnit).toBe('');
      expect(plan.labourTravelTimeUnit).toBeNull();
    });

    it('returns null and skips the nested lookup when the referenced plan was deleted', async () => {
      const { promise, calls } = run({
        references: { data: [{ attribute_id: 'attr', to_item_id: 'target' }] },
        attributes: { attr: { name: 'Service Plan' } },
        items: { target: ITEM_DELETED },
      });

      expect((await promise)[SERVICE_PLAN]).toBeNull();
      expect(calls.planRefs).toEqual([]);
    });

    it('returns null when the referenced plan cannot be fetched', async () => {
      const { promise, calls } = run({
        references: { data: [{ attribute_id: 'attr', to_item_id: 'gone' }] },
        attributes: { attr: { name: 'Service Plan' } },
        items: {},
      });
      expect((await promise)[SERVICE_PLAN]).toBeNull();
      expect(calls.planRefs).toEqual([]);
    });
  });

  describe('Cancellation Type', () => {
    it('maps definition and the two percentage fields', async () => {
      const { promise } = single('Cancellation Type', {
        id: 'ct-1',
        values: [
          value('Definition', 'Cancelled with less than 7 days notice'),
          value('Billable to Client %', 100),
          value('Payable to Worker %', '100'),
          value('Unrelated', 'ignored'),
        ],
      });

      expect((await promise)[CANCELLATION]).toEqual({
        definition: 'Cancelled with less than 7 days notice',
        billableToClient: '100',
        payableToWorker: '100',
      });
    });

    it('defaults every field to an empty string — nothing is required here', async () => {
      const { promise } = single('Cancellation Type', { id: 'ct-2', values: [] });
      expect((await promise)[CANCELLATION]).toEqual({
        definition: '',
        billableToClient: '',
        payableToWorker: '',
      });
    });

    it('returns null for a deleted cancellation type', async () => {
      const { promise } = single('Cancellation Type', ITEM_DELETED);
      expect((await promise)[CANCELLATION]).toBeNull();
    });
  });

  describe('Fund', () => {
    const fundItem = (fundAmount, previouslyUsed, invoicedAndReceived) => ({
      id: 'fund-1',
      values: [
        value('Fund Amount($)', fundAmount),
        value('Previously Used ($)', previouslyUsed),
        value('Invoiced and Received Amount($)', invoicedAndReceived),
      ],
    });

    it('reports only the budget status, discarding the amounts it computed', async () => {
      const { promise } = single('Fund', fundItem(1000, 200, 100));
      expect((await promise)[FUND]).toEqual({ fundingBudgetStatus: '👍 Within Budget' });
    });

    it('reports over budget when spending exceeds the fund', async () => {
      // 1000 - 900 - 200 = -100 remaining
      const { promise } = single('Fund', fundItem(1000, 900, 200));
      expect((await promise)[FUND]).toEqual({ fundingBudgetStatus: '👎 Over Budget' });
    });

    it('reports on budget when the fund is exactly exhausted', async () => {
      // 1000 - 600 - 400 = 0 remaining
      const { promise } = single('Fund', fundItem(1000, 600, 400));
      expect((await promise)[FUND]).toEqual({ fundingBudgetStatus: '👌 On Budget' });
    });

    it('short-circuits a zero fund amount to on budget instead of dividing by zero', async () => {
      const { promise } = single('Fund', fundItem(0, 0, 0));
      expect((await promise)[FUND]).toEqual({ fundingBudgetStatus: '👌 On Budget' });
    });

    it('reports on budget for a zero fund even when money has been spent against it', async () => {
      const { promise } = single('Fund', fundItem(0, 500, 0));
      expect((await promise)[FUND]).toEqual({ fundingBudgetStatus: '👌 On Budget' });
    });

    it('treats missing spend attributes as zero', async () => {
      const { promise } = single('Fund', { id: 'f', values: [value('Fund Amount($)', '2500')] });
      expect((await promise)[FUND]).toEqual({ fundingBudgetStatus: '👍 Within Budget' });
    });

    it('treats a missing fund amount as zero, giving on budget', async () => {
      const { promise } = single('Fund', { id: 'f', values: [value('Previously Used ($)', '10')] });
      expect((await promise)[FUND]).toEqual({ fundingBudgetStatus: '👌 On Budget' });
    });

    it('parses numeric strings', async () => {
      const { promise } = single('Fund', fundItem('1000.50', '0.25', '0.25'));
      expect((await promise)[FUND]).toEqual({ fundingBudgetStatus: '👍 Within Budget' });
    });

    it('falls through to on budget when an amount is unparseable, because every NaN comparison is false', async () => {
      const { promise } = single('Fund', fundItem('n/a', 0, 0));
      expect((await promise)[FUND]).toEqual({ fundingBudgetStatus: '👌 On Budget' });
    });

    it('returns null for a deleted fund', async () => {
      const { promise } = single('Fund', ITEM_DELETED);
      expect((await promise)[FUND]).toBeNull();
    });
  });

  describe('Participant Profile', () => {
    it('maps the profile, including the capital-P Phone key', async () => {
      const { promise } = single('Participant Profile', {
        id: 'pp-1',
        values: [
          value('Billing Contact', 'Alan Chen'),
          value('Billing Address', 'PO Box 44'),
          value('Primary Phone Number', '0400 111 222'),
          value('Email', 'margaret@example.test'),
          value('Address', '5 Rose Court'),
          value('First Name', 'Margaret'),
          value('Last Name', 'Chen'),
          value('Full Name/Preferred Name', 'Maggie'),
        ],
      });

      expect((await promise)[PROFILE]).toEqual({
        billingContact: 'Alan Chen',
        billingAddress: 'PO Box 44',
        Phone: '0400 111 222',
        email: 'margaret@example.test',
        address: '5 Rose Court',
        firstName: 'Margaret',
        lastName: 'Chen',
        fullName: 'Maggie',
      });
    });

    it('does not require a name, unlike the age-care participant profile builder', async () => {
      const { promise } = single('Participant Profile', { id: 'pp-2', values: [] });
      expect((await promise)[PROFILE]).toEqual({
        billingContact: '',
        billingAddress: '',
        Phone: '',
        email: '',
        address: '',
        firstName: '',
        lastName: '',
        fullName: '',
      });
    });

    it('returns null for a deleted profile', async () => {
      const { promise } = single('Participant Profile', ITEM_DELETED);
      expect((await promise)[PROFILE]).toBeNull();
    });
  });

  describe('Participation Type', () => {
    it('maps the participation type and its definition', async () => {
      const { promise } = single('Participation Type', {
        id: 'pt-1',
        values: [value('Participation Type', 'Group'), value('Definition', 'Two or more participants')],
      });
      expect((await promise)[PARTICIPATION]).toEqual({
        participationType: 'Group',
        definition: 'Two or more participants',
      });
    });

    it('returns null for a deleted participation type', async () => {
      const { promise } = single('Participation Type', ITEM_DELETED);
      expect((await promise)[PARTICIPATION]).toBeNull();
    });
  });

  describe('reference traversal', () => {
    it('fills every slot from a single reference response', async () => {
      const { promise, calls } = run({
        references: {
          data: [
            { attribute_id: 'a-sp', to_item_id: 'i-sp' },
            { attribute_id: 'a-ct', to_item_id: 'i-ct' },
            { attribute_id: 'a-fu', to_item_id: 'i-fu' },
            { attribute_id: 'a-pp', to_item_id: 'i-pp' },
            { attribute_id: 'a-pt', to_item_id: 'i-pt' },
          ],
        },
        attributes: {
          'a-sp': { name: 'Service Plan' },
          'a-ct': { name: 'Cancellation Type' },
          'a-fu': { name: 'Fund' },
          'a-pp': { name: 'Participant Profile' },
          'a-pt': { name: 'Participation Type' },
        },
        items: {
          'i-sp': { id: 'i-sp', values: UNIT_VALUES },
          'i-ct': { id: 'i-ct', values: [value('Definition', 'D')] },
          'i-fu': { id: 'i-fu', values: [value('Fund Amount($)', 500)] },
          'i-pp': { id: 'i-pp', values: [value('First Name', 'Margaret')] },
          'i-pt': { id: 'i-pt', values: [value('Participation Type', 'Group')] },
        },
      });
      const result = await promise;

      expect(result).toHaveLength(5);
      expect(result[SERVICE_PLAN].directSupportUnit).toBe('Hour');
      expect(result[CANCELLATION].definition).toBe('D');
      expect(result[FUND].fundingBudgetStatus).toBe('👍 Within Budget');
      expect(result[PROFILE].firstName).toBe('Margaret');
      expect(result[PARTICIPATION].participationType).toBe('Group');

      expect(calls.getReferences).toEqual([[WS, BOARD, ITEM]]);
      expect(calls.getAttribute.map((a) => a[2])).toEqual(['a-sp', 'a-ct', 'a-fu', 'a-pp', 'a-pt']);
    });

    it('returns a two-element [null, null] — not the five-element tuple — when getReferences is falsy', async () => {
      const { promise, calls } = run({ references: null });
      const result = await promise;

      expect(result).toEqual([null, null]);
      expect(result).toHaveLength(2);
      expect(calls.getAttribute).toEqual([]);
    });

    it('returns five nulls for an empty reference list', async () => {
      const { promise } = run({ references: { data: [] } });
      expect(await promise).toEqual([null, null, null, null, null]);
    });

    it('tolerates a reference response with no data array, unlike the client helper', async () => {
      const { promise } = run({ references: { meta: {} } });
      expect(await promise).toEqual([null, null, null, null, null]);
    });

    it('skips a reference whose attribute cannot be resolved and continues', async () => {
      const { promise, calls } = run({
        references: {
          data: [
            { attribute_id: 'a-missing', to_item_id: 'ghost' },
            { attribute_id: 'a-pt', to_item_id: 'i-pt' },
          ],
        },
        attributes: { 'a-pt': { name: 'Participation Type' } },
        items: { 'i-pt': { id: 'i-pt', values: [value('Participation Type', 'Group')] } },
      });

      expect((await promise)[PARTICIPATION].participationType).toBe('Group');
      expect(calls.getItemValues).toEqual([[WS, BOARD, 'i-pt']]);
    });

    it('ignores an attribute name outside the handler map without fetching its item', async () => {
      const { promise, calls } = run({
        references: { data: [{ attribute_id: 'a-x', to_item_id: 'i-x' }] },
        attributes: { 'a-x': { name: 'Service Fee Type' } },
        items: { 'i-x': { id: 'i-x', values: [] } },
      });

      expect(await promise).toEqual([null, null, null, null, null]);
      expect(calls.getItemValues).toEqual([]);
    });

    it('keeps an earlier resolved value when a later reference for the same attribute is deleted', async () => {
      const { promise } = run({
        references: {
          data: [
            { attribute_id: 'a-pt', to_item_id: 'first' },
            { attribute_id: 'a-pt', to_item_id: 'second' },
          ],
        },
        attributes: { 'a-pt': { name: 'Participation Type' } },
        items: {
          first: { id: 'first', values: [value('Participation Type', 'Group')] },
          second: ITEM_DELETED,
        },
      });

      expect((await promise)[PARTICIPATION].participationType).toBe('Group');
    });

    it('lets a later reference overwrite an earlier one when it resolves', async () => {
      const { promise } = run({
        references: {
          data: [
            { attribute_id: 'a-pt', to_item_id: 'first' },
            { attribute_id: 'a-pt', to_item_id: 'second' },
          ],
        },
        attributes: { 'a-pt': { name: 'Participation Type' } },
        items: {
          first: { id: 'first', values: [value('Participation Type', 'Group')] },
          second: { id: 'second', values: [value('Participation Type', 'Individual')] },
        },
      });

      expect((await promise)[PARTICIPATION].participationType).toBe('Individual');
    });
  });
});
