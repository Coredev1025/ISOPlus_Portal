import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server.js';
import {
  NEW_SERVICE_AREA_MAP,
  loadNdisPricingCatalogItem,
  getQuoteNDISNewPricingReferencedItems,
  getNDISParticipantsServicePlanNewPricingReferencedItems,
  getNDISMasterPlanNewPricingReferencedItems,
} from '../../../src/services/ndisNewPricingIsoplus.js';

// This module is the 2026-27 NDIS pricing read path: it walks an item's ISO+
// references and turns them into the pricing numbers an invoice or quote is
// built from. Everything below drives the real HTTP client through MSW, so the
// assertions cover both the shape returned and the requests actually issued.

const WS = '55369';
const BOARD = 'eNiJpH14PN3';
const BASE = 'https://app.isoplus.online/api/v2';

/** An ISO+ item value: always carries its attribute, as expand[]=values.attribute returns. */
const value = (name, data, type = 'text') => ({
  id: `val_${name.replace(/\W+/g, '_')}`,
  attribute_id: `attr_${name.replace(/\W+/g, '_')}`,
  attribute: { id: `attr_${name.replace(/\W+/g, '_')}`, name, type },
  data,
});

const item = (id, values, folderId = 'BFMUenisoQ4') => ({
  id,
  folder_id: folderId,
  row_version: 4,
  created_at: '2026-08-01T00:00:00.000Z',
  values,
});

const reference = (attributeName, toItemId, fromItemId) => ({
  id: `ref_${attributeName.replace(/\W+/g, '_')}_${toItemId}`,
  from_item_id: fromItemId,
  attribute_id: `attr_${attributeName.replace(/\W+/g, '_')}`,
  to_item_id: toItemId,
});

/**
 * Stub the three ISO+ endpoints this module reads.
 *  items       — itemId  -> item payload, or a numeric status to fail with
 *  attributes  — attributeId -> attribute name, or 404 when absent
 *  references  — fromItemId -> array of reference rows, or a numeric status
 * Returns the list of requests issued, for URL assertions.
 */
function stubIsoPlus({ items = {}, attributeNames = {}, references = {} }) {
  const issued = [];
  server.use(
    http.get(`${BASE}/workspaces/:ws/boards/:board/references`, ({ request }) => {
      const url = new URL(request.url);
      issued.push({ kind: 'references', url: request.url });
      const from = url.searchParams.get('from_item_id');
      const entry = references[from];
      if (typeof entry === 'number') return new HttpResponse(null, { status: entry });
      return HttpResponse.json({ data: entry ?? [], has_more: false });
    }),
    http.get(`${BASE}/workspaces/:ws/boards/:board/attributes/:attributeId`, ({ params, request }) => {
      issued.push({ kind: 'attribute', url: request.url });
      const name = attributeNames[params.attributeId];
      if (!name) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json({ id: params.attributeId, name, type: 'reference' });
    }),
    http.get(`${BASE}/workspaces/:ws/boards/:board/items/:itemId`, ({ params, request }) => {
      issued.push({ kind: 'item', url: request.url, itemId: params.itemId });
      const entry = items[params.itemId];
      if (entry === undefined) return new HttpResponse(null, { status: 404 });
      if (typeof entry === 'number') return new HttpResponse(null, { status: entry });
      return HttpResponse.json(entry);
    }),
  );
  return issued;
}

/** A support-catalogue item as the 2026-27 pricing board stores one. */
const catalogueItem = (id, overrides = []) => item(id, [
  value('Support Item Number', '01_011_0107_1_1'),
  value('Support Item Name', 'Assistance With Self-Care Activities - Standard - Weekday Daytime'),
  value('Unit', 'H'),
  value('National($)', 70.23),
  value('Remote($)', 98.32),
  value('Very Remote($)', 105.35),
  value('Provider Travel', 'Yes'),
  value('NDIA Requested Reports', 'Yes'),
  value('Non-Face-to-Face Support Provision', 'Yes'),
  value('Short Notice Cancellations', 'Yes'),
  ...overrides,
]);

/** The catalogue fields the builder always emits, for the item above. */
const CATALOGUE_FIELDS = {
  itemName: 'Assistance With Self-Care Activities - Standard - Weekday Daytime',
  itemNumber: '01_011_0107_1_1',
  unit: 'H',
  'National($)': '70.23',
  'ACT($)': '',
  'NSW($)': '',
  'NT($)': '',
  'QLD($)': '',
  'SA($)': '',
  'TAS($)': '',
  'VIC($)': '',
  'WA($)': '',
  'Remote($)': '98.32',
  'Very Remote($)': '105.35',
  providerTravel: 'Yes',
  ndiaRequestedReports: 'Yes',
  nonFaceToFaceSupportProvision: 'Yes',
  shortNoticeCancellations: 'Yes',
};

describe('NEW_SERVICE_AREA_MAP', () => {
  it('collapses every non-remote state onto the single national price column', () => {
    // This is the whole point of the 2026-27 schedule: state columns were
    // replaced by one national price. A stray state mapping here would read a
    // column the new catalogue no longer has, and price the line at "".
    for (const state of ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']) {
      expect(NEW_SERVICE_AREA_MAP[`Non-Remote (${state})`]).toBe('National($)');
    }
  });

  it('keeps remote loadings on their own columns', () => {
    expect(NEW_SERVICE_AREA_MAP['Remote']).toBe('Remote($)');
    expect(NEW_SERVICE_AREA_MAP['Very Remote']).toBe('Very Remote($)');
  });

  it('treats a blank service area as national', () => {
    expect(NEW_SERVICE_AREA_MAP['']).toBe('National($)');
  });
});

describe('loadNdisPricingCatalogItem', () => {
  it('returns null for a missing catalog item id without calling ISO+', async () => {
    const issued = stubIsoPlus({});

    expect(await loadNdisPricingCatalogItem(WS, BOARD, null)).toBeNull();
    expect(await loadNdisPricingCatalogItem(WS, BOARD, '')).toBeNull();
    expect(await loadNdisPricingCatalogItem(WS, BOARD, undefined)).toBeNull();
    expect(issued).toEqual([]);
  });

  it('reads the catalogue item and returns it keyed by id', async () => {
    const issued = stubIsoPlus({ items: { itm_cat_1: catalogueItem('itm_cat_1') } });

    const result = await loadNdisPricingCatalogItem(WS, BOARD, 'itm_cat_1');

    expect(result).toEqual({ id: 'itm_cat_1', ...CATALOGUE_FIELDS });
    expect(issued[0].url).toBe(
      `${BASE}/workspaces/55369/boards/eNiJpH14PN3/items/itm_cat_1?expand[]=values.attribute`
    );
  });

  it('falls back to the plain Item Number / Name attributes', async () => {
    // Older catalogue boards label the same two columns differently; both
    // spellings have to resolve or the line prices as an empty item number.
    const issued = stubIsoPlus({
      items: {
        itm_cat_2: item('itm_cat_2', [
          value('Item Number', '01_099_0125_1_1'),
          value('Name', 'Provider Travel - Non-Labour Costs'),
        ]),
      },
    });

    const result = await loadNdisPricingCatalogItem(WS, BOARD, 'itm_cat_2');

    expect(result.itemNumber).toBe('01_099_0125_1_1');
    expect(result.itemName).toBe('Provider Travel - Non-Labour Costs');
    expect(result.unit).toBe('');
    expect(result.providerTravel).toBe('NA');
    expect(result.ndiaRequestedReports).toBe('NA');
    expect(result.nonFaceToFaceSupportProvision).toBe('NA');
    expect(result.shortNoticeCancellations).toBe('NA');
    expect(issued).toHaveLength(1);
  });

  it('returns null when the catalogue item was deleted in ISO+', async () => {
    stubIsoPlus({ items: {} }); // any id 404s

    expect(await loadNdisPricingCatalogItem(WS, BOARD, 'itm_gone')).toBeNull();
  });

  it('returns null when ISO+ fails the read', async () => {
    stubIsoPlus({ items: { itm_cat_1: 500 } });

    expect(await loadNdisPricingCatalogItem(WS, BOARD, 'itm_cat_1')).toBeNull();
  });

  it('returns null when the payload carries no values array', async () => {
    stubIsoPlus({ items: { itm_cat_1: { id: 'itm_cat_1', folder_id: 'f1' } } });

    expect(await loadNdisPricingCatalogItem(WS, BOARD, 'itm_cat_1')).toBeNull();
  });
});

describe('getQuoteNDISNewPricingReferencedItems', () => {
  const serviceAreaItem = (area) => item('itm_area', [value('Service Area', area, 'label')]);

  it('resolves service area, support and provider travel from one reference set', async () => {
    stubIsoPlus({
      references: {
        quote_1: [
          reference('Service Area', 'itm_area', 'quote_1'),
          reference('Support Item Number', 'itm_support', 'quote_1'),
          reference('Provider Travel - Non-Labour Cost Item Number', 'itm_travel', 'quote_1'),
        ],
      },
      attributeNames: {
        attr_Service_Area: 'Service Area',
        attr_Support_Item_Number: 'Support Item Number',
        attr_Provider_Travel_Non_Labour_Cost_Item_Number: 'Provider Travel - Non-Labour Cost Item Number',
      },
      items: {
        itm_area: serviceAreaItem('Non-Remote (VIC)'),
        itm_support: catalogueItem('itm_support'),
        itm_travel: item('itm_travel', [
          value('Support Item Number', '01_099_0125_1_1'),
          value('Support Item Name', 'Provider Travel - Non-Labour Costs'),
          value('Unit', 'EA'),
          value('National($)', '0.99'),
        ]),
      },
    });

    const [serviceArea, support, providerTravel] =
      await getQuoteNDISNewPricingReferencedItems(WS, BOARD, 'quote_1');

    expect(serviceArea).toEqual({
      serviceArea: 'Non-Remote (VIC)',
      serviceAreaType: 'National($)',
    });
    expect(support).toEqual({ id: 'itm_support', ...CATALOGUE_FIELDS });
    expect(providerTravel.itemNumber).toBe('01_099_0125_1_1');
    expect(providerTravel['National($)']).toBe('0.99');
    expect(providerTravel.unit).toBe('EA');
  });

  it('defaults an unrecognised service area to the national column', async () => {
    stubIsoPlus({
      references: { quote_1: [reference('Service Area', 'itm_area', 'quote_1')] },
      attributeNames: { attr_Service_Area: 'Service Area' },
      items: { itm_area: serviceAreaItem('Non-Remote (NEW STATE)') },
    });

    const [serviceArea] = await getQuoteNDISNewPricingReferencedItems(WS, BOARD, 'quote_1');

    expect(serviceArea).toEqual({
      serviceArea: 'Non-Remote (NEW STATE)',
      serviceAreaType: 'National($)',
    });
  });

  it('returns three nulls when the references call fails', async () => {
    stubIsoPlus({ references: { quote_1: 500 } });

    expect(await getQuoteNDISNewPricingReferencedItems(WS, BOARD, 'quote_1')).toEqual([null, null, null]);
  });

  it('returns three nulls when the item has no references at all', async () => {
    stubIsoPlus({ references: { quote_1: [] } });

    expect(await getQuoteNDISNewPricingReferencedItems(WS, BOARD, 'quote_1')).toEqual([null, null, null]);
  });

  it('skips a reference whose attribute cannot be read', async () => {
    // getAttribute 404s for an attribute deleted from the board; the reference
    // row survives, and must not be dispatched on a guessed name.
    stubIsoPlus({
      references: { quote_1: [reference('Service Area', 'itm_area', 'quote_1')] },
      attributeNames: {},
      items: { itm_area: serviceAreaItem('Remote') },
    });

    expect(await getQuoteNDISNewPricingReferencedItems(WS, BOARD, 'quote_1')).toEqual([null, null, null]);
  });

  it('ignores references on attributes this quote path does not price', async () => {
    stubIsoPlus({
      references: { quote_1: [reference('Cancellation Item Number', 'itm_cancel', 'quote_1')] },
      attributeNames: { attr_Cancellation_Item_Number: 'Cancellation Item Number' },
      items: { itm_cancel: catalogueItem('itm_cancel') },
    });

    expect(await getQuoteNDISNewPricingReferencedItems(WS, BOARD, 'quote_1')).toEqual([null, null, null]);
  });

  it('leaves support null when the referenced catalogue row has no item number', async () => {
    // An empty catalogue row would otherwise price at $0 against no item
    // number, which the NDIA rejects at claim time.
    stubIsoPlus({
      references: { quote_1: [reference('Support Item Number', 'itm_blank', 'quote_1')] },
      attributeNames: { attr_Support_Item_Number: 'Support Item Number' },
      items: { itm_blank: item('itm_blank', [value('Unit', 'H'), value('National($)', '70.23')]) },
    });

    const [, support] = await getQuoteNDISNewPricingReferencedItems(WS, BOARD, 'quote_1');
    expect(support).toBeNull();
  });

  it('leaves support null when the referenced catalogue item was deleted', async () => {
    stubIsoPlus({
      references: { quote_1: [reference('Support Item Number', 'itm_gone', 'quote_1')] },
      attributeNames: { attr_Support_Item_Number: 'Support Item Number' },
      items: {},
    });

    expect(await getQuoteNDISNewPricingReferencedItems(WS, BOARD, 'quote_1')).toEqual([null, null, null]);
  });

  it('rejects when the referenced service-area item has no Service Area value', async () => {
    // Characterizing, not endorsing: this error propagates out of the service
    // rather than degrading to the national default.
    stubIsoPlus({
      references: { quote_1: [reference('Service Area', 'itm_area', 'quote_1')] },
      attributeNames: { attr_Service_Area: 'Service Area' },
      items: { itm_area: item('itm_area', [value('Name', 'Victoria')]) },
    });

    await expect(getQuoteNDISNewPricingReferencedItems(WS, BOARD, 'quote_1'))
      .rejects.toThrow('Service Area is required');
  });
});

describe('getNDISParticipantsServicePlanNewPricingReferencedItems', () => {
  it('returns the seven slots in order for a fully referenced service plan', async () => {
    stubIsoPlus({
      references: {
        plan_1: [
          reference('Service Area', 'itm_area', 'plan_1'),
          reference('Support Item Number', 'itm_support', 'plan_1'),
          reference('Provider Travel - Non-Labour Cost Item Number', 'itm_travel', 'plan_1'),
          reference('Participant Intake Form', 'itm_profile', 'plan_1'),
          reference('Provider Travel - Labour Travel Time Costs Item Number', 'itm_labour', 'plan_1'),
          reference('Cancellation Item Number', 'itm_cancel', 'plan_1'),
          reference('Activity Based Transport Item Number', 'itm_transport', 'plan_1'),
        ],
      },
      attributeNames: {
        attr_Service_Area: 'Service Area',
        attr_Support_Item_Number: 'Support Item Number',
        attr_Provider_Travel_Non_Labour_Cost_Item_Number: 'Provider Travel - Non-Labour Cost Item Number',
        attr_Participant_Intake_Form: 'Participant Intake Form',
        attr_Provider_Travel_Labour_Travel_Time_Costs_Item_Number: 'Provider Travel - Labour Travel Time Costs Item Number',
        attr_Cancellation_Item_Number: 'Cancellation Item Number',
        attr_Activity_Based_Transport_Item_Number: 'Activity Based Transport Item Number',
      },
      items: {
        itm_area: item('itm_area', [value('Service Area', 'Very Remote', 'label')]),
        itm_support: catalogueItem('itm_support'),
        itm_travel: item('itm_travel', [value('Support Item Number', '01_099_0125_1_1'), value('Unit', 'EA')]),
        itm_profile: item('itm_profile', [
          value('Full Name/Preferred Name', 'Jordan Lee'),
          value('First Name', 'Jordan'),
          value('Last Name', 'Lee'),
          value('Email', 'jordan@example.com'),
        ]),
        itm_labour: item('itm_labour', [value('Support Item Number', '01_799_0107_1_1'), value('Unit', 'H')]),
        itm_cancel: item('itm_cancel', [
          value('Support Item Number', '01_011_0107_1_1'),
          value('Short Notice Cancellations', 'Yes'),
        ]),
        itm_transport: item('itm_transport', [value('Support Item Number', '02_051_0108_1_1'), value('Unit', 'EA')]),
      },
    });

    const [
      serviceArea,
      support,
      providerTravel,
      participantProfile,
      labourTravelTime,
      cancellation,
      activityBasedTransport,
    ] = await getNDISParticipantsServicePlanNewPricingReferencedItems(WS, BOARD, 'plan_1');

    expect(serviceArea).toEqual({ serviceArea: 'Very Remote', serviceAreaType: 'Very Remote($)' });
    expect(support).toEqual({ id: 'itm_support', ...CATALOGUE_FIELDS });
    expect(providerTravel.itemNumber).toBe('01_099_0125_1_1');
    expect(participantProfile).toEqual({ fullName: 'Jordan Lee', firstName: 'Jordan', lastName: 'Lee' });
    expect(labourTravelTime.itemNumber).toBe('01_799_0107_1_1');
    expect(cancellation.shortNoticeCancellations).toBe('Yes');
    expect(activityBasedTransport.itemNumber).toBe('02_051_0108_1_1');
  });

  it('returns seven nulls when the plan has no references', async () => {
    stubIsoPlus({ references: { plan_1: [] } });

    expect(await getNDISParticipantsServicePlanNewPricingReferencedItems(WS, BOARD, 'plan_1'))
      .toEqual([null, null, null, null, null, null, null]);
  });

  it('returns seven nulls when the references call fails', async () => {
    stubIsoPlus({ references: { plan_1: 500 } });

    expect(await getNDISParticipantsServicePlanNewPricingReferencedItems(WS, BOARD, 'plan_1'))
      .toEqual([null, null, null, null, null, null, null]);
  });

  it('leaves the participant profile null when the intake form was deleted', async () => {
    stubIsoPlus({
      references: {
        plan_1: [
          reference('Participant Intake Form', 'itm_gone', 'plan_1'),
          reference('Support Item Number', 'itm_support', 'plan_1'),
        ],
      },
      attributeNames: {
        attr_Participant_Intake_Form: 'Participant Intake Form',
        attr_Support_Item_Number: 'Support Item Number',
      },
      items: { itm_support: catalogueItem('itm_support') },
    });

    const result = await getNDISParticipantsServicePlanNewPricingReferencedItems(WS, BOARD, 'plan_1');

    expect(result[3]).toBeNull();
    // The deleted reference must not abandon the rest of the plan.
    expect(result[1].itemNumber).toBe('01_011_0107_1_1');
  });

  it('fills the intake names it can find and blanks the rest', async () => {
    stubIsoPlus({
      references: { plan_1: [reference('Participant Intake Form', 'itm_profile', 'plan_1')] },
      attributeNames: { attr_Participant_Intake_Form: 'Participant Intake Form' },
      items: { itm_profile: item('itm_profile', [value('First Name', 'Jordan')]) },
    });

    const [, , , participantProfile] =
      await getNDISParticipantsServicePlanNewPricingReferencedItems(WS, BOARD, 'plan_1');

    expect(participantProfile).toEqual({ fullName: '', firstName: 'Jordan', lastName: '' });
  });
});

describe('getNDISMasterPlanNewPricingReferencedItems', () => {
  const servicePlanItem = item('plan_1', [
    value('Support Item Number', ['itm_support'], 'reference'),
    value('Unit (Support)', 'H'),
    value('Agreed Unit Price for Support ($)', 70.23),
    value('Unit (Provider Travel - Non-Labour Cost)', 'EA'),
    value('Agreed Unit Price for Non-Labour Travel ($)', '0.99'),
    value('Unit (Activity Based Transport)', 'EA'),
    value('Agreed Price for Activity Based Transport ($)', '0.97'),
    value('Unit (Labour Travel Time)', 'H'),
    value('Agreed Unit Price for Labour Travel Time ($)', '70.23'),
    value('Unit (Allowances)', 'EA'),
    value('Agreed Price for Allowances($)', '12.50'),
    value('Unit (Cancellation)', 'H'),
    value('Agreed Unit Price for Cancellation ($)', '70.23'),
  ]);

  const masterPlanStubs = (overrides = {}) => stubIsoPlus({
    references: {
      master_1: [
        reference('Service Plan', 'plan_1', 'master_1'),
        reference('Cancellation Type', 'itm_cxtype', 'master_1'),
        reference('Fund', 'itm_fund', 'master_1'),
        reference('Participant Profile', 'itm_profile', 'master_1'),
        reference('Participation Type', 'itm_ptype', 'master_1'),
      ],
      plan_1: [
        reference('Provider Travel - Non-Labour Cost Item Number', 'itm_travel', 'plan_1'),
        reference('Cancellation Item Number', 'itm_cancel', 'plan_1'),
        reference('Activity Based Transport Item Number', 'itm_transport', 'plan_1'),
      ],
      ...overrides.references,
    },
    attributeNames: {
      attr_Service_Plan: 'Service Plan',
      attr_Cancellation_Type: 'Cancellation Type',
      attr_Fund: 'Fund',
      attr_Participant_Profile: 'Participant Profile',
      attr_Participation_Type: 'Participation Type',
      attr_Provider_Travel_Non_Labour_Cost_Item_Number: 'Provider Travel - Non-Labour Cost Item Number',
      attr_Cancellation_Item_Number: 'Cancellation Item Number',
      attr_Activity_Based_Transport_Item_Number: 'Activity Based Transport Item Number',
      ...overrides.attributeNames,
    },
    items: {
      plan_1: servicePlanItem,
      itm_travel: item('itm_travel', [
        value('Support Item Number', '01_099_0125_1_1'),
        value('Support Item Name', 'Provider Travel - Non-Labour Costs'),
      ]),
      itm_cancel: item('itm_cancel', [
        value('Support Item Number', '01_011_0107_1_1'),
        value('Short Notice Cancellations', 'Yes'),
      ]),
      itm_transport: item('itm_transport', [
        value('Support Item Number', '02_051_0108_1_1'),
        value('Support Item Name', 'Activity Based Transport'),
        value('Short Notice Cancellations', 'No'),
      ]),
      itm_cxtype: item('itm_cxtype', [
        value('Definition', 'Cancelled with less than 7 days notice'),
        value('Billable to Client %', '100'),
        value('Payable to Worker %', '100'),
      ]),
      itm_fund: item('itm_fund', [
        value('Fund Amount($)', '1000'),
        value('Previously Used ($)', '200'),
        value('Invoiced and Received Amount($)', '100'),
      ]),
      itm_profile: item('itm_profile', [
        value('Billing Contact', 'Alex Lee'),
        value('Billing Address', '1 Test St, Melbourne VIC 3000'),
        value('Primary Phone Number', '0400000000'),
        value('Email', 'alex@example.com'),
        value('Address', '1 Test St'),
        value('First Name', 'Jordan'),
        value('Last Name', 'Lee'),
        value('Full Name/Preferred Name', 'Jordan Lee'),
      ]),
      itm_ptype: item('itm_ptype', [
        value('Participation Type', '1:1'),
        value('Definition', 'One participant to one worker'),
      ]),
      ...overrides.items,
    },
  });

  it('assembles the service plan from the plan item and its own nested references', async () => {
    masterPlanStubs();

    const [servicePlanValues] = await getNDISMasterPlanNewPricingReferencedItems(WS, BOARD, 'master_1');

    expect(servicePlanValues).toEqual({
      supportItemNumber: 'itm_support',
      supportUnit: 'H',
      supportUnitPrice: '70.23',
      providerTravelItemNumber: '01_099_0125_1_1',
      providerTravelItemName: 'Provider Travel - Non-Labour Costs',
      nonLabourTravelUnit: 'EA',
      nonLabourTravelUnitPrice: '0.99',
      activityBasedTransportItemNumber: '02_051_0108_1_1',
      activityBasedTransportItemName: 'Activity Based Transport',
      activityBasedTransportUnit: 'EA',
      activityBasedTransportUnitPrice: '0.97',
      activityBasedTransportShortNoticeCancellations: 'No',
      labourTravelTimeUnit: 'H',
      labourTravelTimeUnitPrice: '70.23',
      usedAllowanceUnit: 'EA',
      usedAllowanceAmount: '12.50',
      cancellationUnit: 'H',
      cancellationUnitPrice: '70.23',
      cancellationShortNoticeCancellations: 'Yes',
    });
  });

  it('returns the cancellation type, participant profile and participation type', async () => {
    masterPlanStubs();

    const [, cancellationType, , participantProfile, participationType] =
      await getNDISMasterPlanNewPricingReferencedItems(WS, BOARD, 'master_1');

    expect(cancellationType).toEqual({
      definition: 'Cancelled with less than 7 days notice',
      billableToClient: '100',
      payableToWorker: '100',
    });
    expect(participantProfile).toEqual({
      billingContact: 'Alex Lee',
      billingAddress: '1 Test St, Melbourne VIC 3000',
      Phone: '0400000000',
      email: 'alex@example.com',
      address: '1 Test St',
      firstName: 'Jordan',
      lastName: 'Lee',
      fullName: 'Jordan Lee',
    });
    expect(participationType).toEqual({
      participationType: '1:1',
      definition: 'One participant to one worker',
    });
  });

  it.each([
    ['1000', '200', '100', '👍 Within Budget'],
    ['100', '200', '0', '👎 Over Budget'],
    ['100', '100', '0', '👌 On Budget'],
    ['0', '0', '0', '👌 On Budget'],
  ])('classifies fund %s / used %s / invoiced %s as %s', async (amount, used, invoiced, expected) => {
    masterPlanStubs({
      items: {
        itm_fund: item('itm_fund', [
          value('Fund Amount($)', amount),
          value('Previously Used ($)', used),
          value('Invoiced and Received Amount($)', invoiced),
        ]),
      },
    });

    const [, , fundValues] = await getNDISMasterPlanNewPricingReferencedItems(WS, BOARD, 'master_1');

    expect(fundValues).toEqual({ fundingBudgetStatus: expected });
  });

  it('returns five nulls when the references call fails', async () => {
    stubIsoPlus({ references: { master_1: 500 } });

    expect(await getNDISMasterPlanNewPricingReferencedItems(WS, BOARD, 'master_1'))
      .toEqual([null, null, null, null, null]);
  });

  it('returns five nulls for an item with no references', async () => {
    stubIsoPlus({ references: { master_1: [] } });

    expect(await getNDISMasterPlanNewPricingReferencedItems(WS, BOARD, 'master_1'))
      .toEqual([null, null, null, null, null]);
  });

  it('leaves the service plan null when the plan item was deleted', async () => {
    masterPlanStubs({ items: { plan_1: undefined } });

    const [servicePlanValues, cancellationType] =
      await getNDISMasterPlanNewPricingReferencedItems(WS, BOARD, 'master_1');

    expect(servicePlanValues).toBeNull();
    expect(cancellationType.billableToClient).toBe('100');
  });

  it('falls back to the labour travel catalogue unit when the plan does not carry one', async () => {
    masterPlanStubs({
      references: {
        plan_1: [reference('Provider Travel - Labour Travel Time Costs Item Number', 'itm_labour', 'plan_1')],
      },
      attributeNames: {
        attr_Provider_Travel_Labour_Travel_Time_Costs_Item_Number:
          'Provider Travel - Labour Travel Time Costs Item Number',
      },
      items: {
        plan_1: item('plan_1', [value('Unit (Support)', 'H')]),
        itm_labour: item('itm_labour', [
          value('Support Item Number', '01_799_0107_1_1'),
          value('Unit', 'MIN'),
        ]),
      },
    });

    const [servicePlanValues] = await getNDISMasterPlanNewPricingReferencedItems(WS, BOARD, 'master_1');

    expect(servicePlanValues.labourTravelTimeUnit).toBe('MIN');
    expect(servicePlanValues.labourTravelTimeUnitPrice).toBeNull();
    expect(servicePlanValues.supportItemNumber).toBe('');
  });

  it('ignores references on attributes the master plan does not read', async () => {
    stubIsoPlus({
      references: { master_1: [reference('Timesheet Approval', 'itm_other', 'master_1')] },
      attributeNames: { attr_Timesheet_Approval: 'Timesheet Approval' },
      items: { itm_other: item('itm_other', [value('Name', 'Approved')]) },
    });

    expect(await getNDISMasterPlanNewPricingReferencedItems(WS, BOARD, 'master_1'))
      .toEqual([null, null, null, null, null]);
  });
});
