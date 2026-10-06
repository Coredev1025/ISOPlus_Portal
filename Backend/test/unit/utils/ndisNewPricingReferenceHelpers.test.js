import { describe, it, expect, vi } from 'vitest';
import { ITEM_DELETED } from '../../../src/services/isoplus.js';
import {
  buildNdisPricingCatalogFromValues,
  createNewParticipantsPlanReferenceHandlers,
  fetchNewNdisParticipantsPlanReferencedItems,
  buildNewMasterPlanServicePlanValues,
  resolveMasterPlanNewReference,
  fetchNewNdisMasterPlanReferencedItems,
} from '../../../src/utils/ndisNewPricingReferenceHelpers.js';

const WS = '55369';
const BOARD = 'eNiJpH14PN3';

// Same row shape ISO+ returns from POST /items/values.
let valueSeq = 0;
const value = (name, data, type = 'text') => ({
  id: `value-${++valueSeq}`,
  attribute: { id: `attr-${name}`, name, type },
  data,
});

const ref = (attributeId, toItemId) => ({
  id: `reference-${attributeId}`,
  attribute_id: attributeId,
  from_item_id: 'master-plan-1',
  to_item_id: toItemId,
});

const itemValuesFrom = (table) => vi.fn(async (_ws, _board, itemId) => table[itemId]);

// The 2026 catalogue carries a National column instead of the eight state ones.
const supportCatalogueValues = () => [
  value('Support Item Number', '01_011_0107_1_1'),
  value('Support Item Name', 'Assistance With Self-Care Activities - Standard - Weekday Daytime'),
  value('Unit', 'H'),
  value('National($)', 67.56, 'number'),
  value('Remote($)', 94.58, 'number'),
  value('Very Remote($)', 101.34, 'number'),
  value('Short Notice Cancellations', 'Y'),
  value('Registration Group Number', '0107'),
];

const supportCatalogue = {
  itemName: 'Assistance With Self-Care Activities - Standard - Weekday Daytime',
  itemNumber: '01_011_0107_1_1',
  unit: 'H',
  'National($)': '67.56',
  'ACT($)': '',
  'NSW($)': '',
  'NT($)': '',
  'QLD($)': '',
  'SA($)': '',
  'TAS($)': '',
  'VIC($)': '',
  'WA($)': '',
  'Remote($)': '94.58',
  'Very Remote($)': '101.34',
  providerTravel: 'NA',
  ndiaRequestedReports: 'NA',
  nonFaceToFaceSupportProvision: 'NA',
  shortNoticeCancellations: 'Y',
};

describe('buildNdisPricingCatalogFromValues', () => {
  it('reads a 2026 catalogue row, defaulting the four policy flags to NA', () => {
    expect(buildNdisPricingCatalogFromValues(supportCatalogueValues())).toEqual(supportCatalogue);
  });

  it('falls back from Support Item Number to Item Number', () => {
    const catalog = buildNdisPricingCatalogFromValues([value('Item Number', '01_799_0107_1_1')]);
    expect(catalog.itemNumber).toBe('01_799_0107_1_1');
  });

  it('prefers Support Item Number when both are present', () => {
    const catalog = buildNdisPricingCatalogFromValues([
      value('Item Number', 'fallback'),
      value('Support Item Number', '01_011_0107_1_1'),
    ]);
    expect(catalog.itemNumber).toBe('01_011_0107_1_1');
  });

  it('falls back from Support Item Name to Name', () => {
    expect(buildNdisPricingCatalogFromValues([value('Name', 'Centre Capital Cost')]).itemName).toBe('Centre Capital Cost');
  });

  it('returns an empty item number rather than throwing on a blank row', () => {
    const catalog = buildNdisPricingCatalogFromValues([]);
    expect(catalog.itemNumber).toBe('');
    expect(catalog.itemName).toBe('');
    expect(catalog.unit).toBe('');
    expect(catalog['National($)']).toBe('');
    expect(catalog.shortNoticeCancellations).toBe('NA');
  });

  it('carries all four policy flags through when set', () => {
    const catalog = buildNdisPricingCatalogFromValues([
      value('Support Item Number', '01_011_0107_1_1'),
      value('Provider Travel', 'Y'),
      value('NDIA Requested Reports', 'N'),
      value('Non-Face-to-Face Support Provision', 'Y'),
      value('Short Notice Cancellations', 'N'),
    ]);
    expect(catalog.providerTravel).toBe('Y');
    expect(catalog.ndiaRequestedReports).toBe('N');
    expect(catalog.nonFaceToFaceSupportProvision).toBe('Y');
    expect(catalog.shortNoticeCancellations).toBe('N');
  });

  it('treats an empty-string flag as unset and falls back to NA', () => {
    const catalog = buildNdisPricingCatalogFromValues([value('Provider Travel', '')]);
    expect(catalog.providerTravel).toBe('NA');
  });

  it('keeps a zero price as the string "0"', () => {
    const catalog = buildNdisPricingCatalogFromValues([value('National($)', 0, 'number')]);
    expect(catalog['National($)']).toBe('0');
  });

  it('blanks a null price rather than emitting "null"', () => {
    const catalog = buildNdisPricingCatalogFromValues([value('National($)', null, 'number')]);
    expect(catalog['National($)']).toBe('');
  });

  it('survives a value row with no attribute descriptor', () => {
    const catalog = buildNdisPricingCatalogFromValues([{ id: 'v', data: 'orphan' }, value('Support Item Number', '01_011_0107_1_1')]);
    expect(catalog.itemNumber).toBe('01_011_0107_1_1');
  });
});

describe('createNewParticipantsPlanReferenceHandlers', () => {
  const ctx = { workspaceId: WS, boardId: BOARD, itemId: 'plan-1' };
  const handlers = (warn = vi.fn()) => createNewParticipantsPlanReferenceHandlers(
    warn,
    ctx,
    buildNdisPricingCatalogFromValues,
    { 'Non-Remote (NSW)': 'National($)', Remote: 'Remote($)', '': 'National($)' },
  );

  it('resolves the Support Item Number column into the support catalog with its id', async () => {
    const getItemValues = itemValuesFrom({ 'sup-1': { id: 'sup-1', values: supportCatalogueValues() } });
    await expect(handlers()['Support Item Number'].handler(WS, BOARD, ref('a', 'sup-1'), getItemValues))
      .resolves.toEqual({ id: 'sup-1', ...supportCatalogue });
  });

  it('exposes the four other 2026 catalogue columns', async () => {
    const map = handlers();
    expect(map['Provider Travel - Non-Labour Cost Item Number'].resultKey).toBe('providerTravelValues');
    expect(map['Provider Travel - Labour Travel Time Costs Item Number'].resultKey).toBe('labourTravelTimeValues');
    expect(map['Cancellation Item Number'].resultKey).toBe('cancellationValues');
    expect(map['Activity Based Transport Item Number'].resultKey).toBe('activityBasedTransportValues');

    const getItemValues = itemValuesFrom({
      'cancel-1': {
        id: 'cancel-1',
        values: [value('Support Item Number', '01_011_0107_1_1'), value('Short Notice Cancellations', 'Y')],
      },
    });
    const cancellation = await map['Cancellation Item Number'].handler(WS, BOARD, ref('a', 'cancel-1'), getItemValues);
    expect(cancellation.id).toBe('cancel-1');
    expect(cancellation.itemNumber).toBe('01_011_0107_1_1');
    expect(cancellation.shortNoticeCancellations).toBe('Y');
  });

  it('drops a catalogue reference with no item number', async () => {
    const getItemValues = itemValuesFrom({ 'sup-1': { id: 'sup-1', values: [value('Unit', 'H')] } });
    await expect(handlers()['Support Item Number'].handler(WS, BOARD, ref('a', 'sup-1'), getItemValues)).resolves.toBeNull();
  });

  it('maps the service area through the supplied map', async () => {
    const getItemValues = itemValuesFrom({ 'sa-1': { id: 'sa-1', values: [value('Service Area', 'Non-Remote (NSW)')] } });
    await expect(handlers()['Service Area'].handler(WS, BOARD, ref('a', 'sa-1'), getItemValues))
      .resolves.toEqual({ serviceArea: 'Non-Remote (NSW)', serviceAreaType: 'National($)' });
  });

  it('reads the three participant name fields off the intake form', async () => {
    const getItemValues = itemValuesFrom({
      'intake-1': {
        id: 'intake-1',
        values: [
          value('Full Name/Preferred Name', 'Jordan Fixture'),
          value('First Name', 'Jordan'),
          value('Last Name', 'Fixture'),
          value('Email', 'jordan@example.invalid'),
        ],
      },
    });
    await expect(handlers()['Participant Intake Form'].handler(WS, BOARD, ref('a', 'intake-1'), getItemValues))
      .resolves.toEqual({ fullName: 'Jordan Fixture', firstName: 'Jordan', lastName: 'Fixture' });
  });

  it('warns and returns null when the intake form was deleted', async () => {
    const warn = vi.fn();
    await expect(handlers(warn)['Participant Intake Form'].handler(WS, BOARD, ref('a', 'gone'), async () => ITEM_DELETED))
      .resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('ISO+™ Service', 'Referenced item deleted in ISO+', {
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1',
      referenceName: 'Participant Intake Form', referencedItemId: 'gone',
    });
  });
});

describe('fetchNewNdisParticipantsPlanReferencedItems', () => {
  const table = {
    'sa-1': { id: 'sa-1', values: [value('Service Area', 'Remote')] },
    'sup-1': { id: 'sup-1', values: supportCatalogueValues() },
    'pt-1': { id: 'pt-1', values: [value('Support Item Number', '01_799_0107_1_1'), value('Unit', 'E')] },
    'ltt-1': { id: 'ltt-1', values: [value('Support Item Number', '01_799_0107_2_1'), value('Unit', 'H')] },
    'cancel-1': { id: 'cancel-1', values: [value('Support Item Number', '01_011_0107_1_1'), value('Short Notice Cancellations', 'Y')] },
    'abt-1': { id: 'abt-1', values: [value('Support Item Number', '02_051_0108_1_1'), value('Unit', 'E')] },
    'intake-1': { id: 'intake-1', values: [value('Full Name/Preferred Name', 'Jordan Fixture')] },
  };
  const names = {
    'ref-sa': 'Service Area',
    'ref-sup': 'Support Item Number',
    'ref-pt': 'Provider Travel - Non-Labour Cost Item Number',
    'ref-ltt': 'Provider Travel - Labour Travel Time Costs Item Number',
    'ref-cancel': 'Cancellation Item Number',
    'ref-abt': 'Activity Based Transport Item Number',
    'ref-intake': 'Participant Intake Form',
    'ref-pdf': 'Generated PDF Link',
  };

  function run(refs, warn = vi.fn()) {
    return fetchNewNdisParticipantsPlanReferencedItems({
      workspaceId: WS,
      boardId: BOARD,
      itemId: 'plan-1',
      getReferences: async () => (refs === null ? null : { data: refs }),
      getAttribute: async (_ws, _b, attributeId) => (names[attributeId] ? { id: attributeId, name: names[attributeId] } : null),
      getItemValues: itemValuesFrom(table),
      warn,
      buildCatalogFromValues: buildNdisPricingCatalogFromValues,
      newServiceAreaMap: { Remote: 'Remote($)', '': 'National($)' },
    });
  }

  it('warns and returns seven nulls when there are no references', async () => {
    const warn = vi.fn();
    await expect(run([], warn)).resolves.toEqual([null, null, null, null, null, null, null]);
    expect(warn).toHaveBeenCalledWith('ISO+™ Service', 'Missing references for Participants Service Plan item', {
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1',
    });
  });

  it('warns and returns seven nulls when getReferences answers nothing', async () => {
    const warn = vi.fn();
    await expect(run(null, warn)).resolves.toEqual([null, null, null, null, null, null, null]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns the seven buckets in order regardless of reference order', async () => {
    const result = await run([
      ref('ref-abt', 'abt-1'),
      ref('ref-intake', 'intake-1'),
      ref('ref-cancel', 'cancel-1'),
      ref('ref-ltt', 'ltt-1'),
      ref('ref-pt', 'pt-1'),
      ref('ref-sup', 'sup-1'),
      ref('ref-sa', 'sa-1'),
    ]);

    expect(result).toHaveLength(7);
    expect(result[0]).toEqual({ serviceArea: 'Remote', serviceAreaType: 'Remote($)' });
    expect(result[1]).toEqual({ id: 'sup-1', ...supportCatalogue });
    expect(result[2].itemNumber).toBe('01_799_0107_1_1');
    expect(result[3]).toEqual({ fullName: 'Jordan Fixture', firstName: '', lastName: '' });
    expect(result[4].itemNumber).toBe('01_799_0107_2_1');
    expect(result[5].shortNoticeCancellations).toBe('Y');
    expect(result[6].itemNumber).toBe('02_051_0108_1_1');
  });

  it('leaves unreferenced buckets null and skips unhandled attributes', async () => {
    const result = await run([ref('ref-pdf', 'x'), ref('ref-sup', 'sup-1')]);
    expect(result[0]).toBeNull();
    expect(result[1]).toEqual({ id: 'sup-1', ...supportCatalogue });
    expect(result.slice(2)).toEqual([null, null, null, null, null]);
  });

  it('skips a reference whose attribute cannot be loaded', async () => {
    await expect(run([ref('ref-unknown-id', 'sup-1')])).resolves.toEqual([null, null, null, null, null, null, null]);
  });
});

describe('buildNewMasterPlanServicePlanValues', () => {
  const servicePlanValues = () => [
    value('Support Item Number', '01_011_0107_1_1'),
    value('Unit (Support)', 'H'),
    value('Agreed Unit Price for Support ($)', 67.56, 'number'),
    value('Unit (Provider Travel - Non-Labour Cost)', 'E'),
    value('Agreed Unit Price for Non-Labour Travel ($)', 0.99, 'number'),
    value('Unit (Activity Based Transport)', 'E'),
    value('Agreed Price for Activity Based Transport ($)', 0.97, 'number'),
    value('Unit (Labour Travel Time)', 'H'),
    value('Agreed Unit Price for Labour Travel Time ($)', 67.56, 'number'),
    value('Unit (Allowances)', 'E'),
    value('Agreed Price for Allowances($)', 25, 'number'),
    value('Unit (Cancellation)', 'H'),
    value('Agreed Unit Price for Cancellation ($)', 67.56, 'number'),
  ];

  // [serviceArea, support, providerTravel, participantProfile, labourTravelTime, cancellation, activityTransport]
  const nestedRefs = () => [
    { serviceArea: 'Remote', serviceAreaType: 'Remote($)' },
    { id: 'sup-1', itemNumber: '01_011_0107_1_1', itemName: 'Self-Care Weekday Daytime' },
    { id: 'pt-1', itemNumber: '01_799_0107_1_1', itemName: 'Provider Travel - Non Labour Costs', unit: 'E' },
    { fullName: 'Jordan Fixture', firstName: 'Jordan', lastName: 'Fixture' },
    { id: 'ltt-1', itemNumber: '01_799_0107_2_1', itemName: 'Labour Travel Time', unit: 'H' },
    { id: 'cancel-1', itemNumber: '01_011_0107_1_1', shortNoticeCancellations: 'Y' },
    { id: 'abt-1', itemNumber: '02_051_0108_1_1', itemName: 'Activity Based Transport', shortNoticeCancellations: 'N' },
  ];

  it('flattens the service plan and the nested catalogue references into one row', () => {
    expect(buildNewMasterPlanServicePlanValues({ id: 'plan-1', values: servicePlanValues() }, nestedRefs())).toEqual({
      supportItemNumber: '01_011_0107_1_1',
      supportUnit: 'H',
      supportUnitPrice: '67.56',
      providerTravelItemNumber: '01_799_0107_1_1',
      providerTravelItemName: 'Provider Travel - Non Labour Costs',
      nonLabourTravelUnit: 'E',
      nonLabourTravelUnitPrice: '0.99',
      activityBasedTransportItemNumber: '02_051_0108_1_1',
      activityBasedTransportItemName: 'Activity Based Transport',
      activityBasedTransportUnit: 'E',
      activityBasedTransportUnitPrice: '0.97',
      activityBasedTransportShortNoticeCancellations: 'N',
      labourTravelTimeUnit: 'H',
      labourTravelTimeUnitPrice: '67.56',
      usedAllowanceUnit: 'E',
      usedAllowanceAmount: '25',
      cancellationUnit: 'H',
      cancellationUnitPrice: '67.56',
      cancellationShortNoticeCancellations: 'Y',
    });
  });

  it('takes the item numbers and names from the nested references, not the plan row', () => {
    const refs = nestedRefs();
    refs[2] = { itemNumber: 'PT-OVERRIDE', itemName: 'Overridden Travel' };
    refs[6] = { itemNumber: 'ABT-OVERRIDE', itemName: 'Overridden Transport', shortNoticeCancellations: 'Y' };
    const row = buildNewMasterPlanServicePlanValues({ values: servicePlanValues() }, refs);
    expect(row.providerTravelItemNumber).toBe('PT-OVERRIDE');
    expect(row.providerTravelItemName).toBe('Overridden Travel');
    expect(row.activityBasedTransportItemNumber).toBe('ABT-OVERRIDE');
    expect(row.activityBasedTransportItemName).toBe('Overridden Transport');
    expect(row.activityBasedTransportShortNoticeCancellations).toBe('Y');
  });

  it('nulls every unit and price the plan row does not set, but blanks the reference-derived fields', () => {
    expect(buildNewMasterPlanServicePlanValues({ values: [] }, [null, null, null, null, null, null, null])).toEqual({
      supportItemNumber: '',
      supportUnit: null,
      supportUnitPrice: null,
      providerTravelItemNumber: '',
      providerTravelItemName: '',
      nonLabourTravelUnit: null,
      nonLabourTravelUnitPrice: null,
      activityBasedTransportItemNumber: '',
      activityBasedTransportItemName: '',
      activityBasedTransportUnit: null,
      activityBasedTransportUnitPrice: null,
      activityBasedTransportShortNoticeCancellations: '',
      labourTravelTimeUnit: null,
      labourTravelTimeUnitPrice: null,
      usedAllowanceUnit: null,
      usedAllowanceAmount: null,
      cancellationUnit: null,
      cancellationUnitPrice: null,
      cancellationShortNoticeCancellations: '',
    });
  });

  it('falls back to the labour travel catalogue unit when the plan row does not set one', () => {
    const refs = nestedRefs();
    const withoutUnit = servicePlanValues().filter((v) => v.attribute.name !== 'Unit (Labour Travel Time)');
    expect(buildNewMasterPlanServicePlanValues({ values: withoutUnit }, refs).labourTravelTimeUnit).toBe('H');

    refs[4] = { id: 'ltt-1', itemNumber: 'x' };
    expect(buildNewMasterPlanServicePlanValues({ values: withoutUnit }, refs).labourTravelTimeUnit).toBeNull();
  });

  it('keeps a zero agreed price as the string "0" rather than dropping it', () => {
    const row = buildNewMasterPlanServicePlanValues({
      values: [value('Agreed Unit Price for Support ($)', 0, 'number')],
    }, []);
    expect(row.supportUnitPrice).toBe('0');
  });

  it('preserves a negative agreed price', () => {
    const row = buildNewMasterPlanServicePlanValues({
      values: [value('Agreed Unit Price for Cancellation ($)', -12.5, 'number')],
    }, []);
    expect(row.cancellationUnitPrice).toBe('-12.5');
  });

  it('nulls a price whose stored value is null', () => {
    const row = buildNewMasterPlanServicePlanValues({
      values: [value('Agreed Unit Price for Support ($)', null, 'number')],
    }, []);
    expect(row.supportUnitPrice).toBeNull();
  });

  it('treats a non-array values property as empty', () => {
    const row = buildNewMasterPlanServicePlanValues({ values: 'oops' }, []);
    expect(row.supportItemNumber).toBe('');
    expect(row.supportUnit).toBeNull();
  });

  it('throws a TypeError on a value row with no attribute descriptor', () => {
    expect(() => buildNewMasterPlanServicePlanValues({ values: [{ id: 'v', data: 'orphan' }] }, []))
      .toThrow(TypeError);
  });
});

describe('resolveMasterPlanNewReference', () => {
  const fetchParticipantsPlanRefs = vi.fn(async () => [null, null, null, null, null, null, null]);

  it('builds the service plan row and pulls its nested references from the same board', async () => {
    const nested = [null, null, { itemNumber: 'PT-1', itemName: 'Travel' }, null, null, null, null];
    const fetchRefs = vi.fn(async () => nested);
    const getItemValues = itemValuesFrom({
      'plan-1': { id: 'plan-1', values: [value('Support Item Number', '01_011_0107_1_1'), value('Unit (Support)', 'H')] },
    });

    const { kind, value: row } = await resolveMasterPlanNewReference(
      'Service Plan', ref('a', 'plan-1'), WS, BOARD, getItemValues, fetchRefs,
    );
    expect(kind).toBe('servicePlan');
    expect(row.supportItemNumber).toBe('01_011_0107_1_1');
    expect(row.supportUnit).toBe('H');
    expect(row.providerTravelItemNumber).toBe('PT-1');
    expect(fetchRefs).toHaveBeenCalledWith(WS, BOARD, 'plan-1');
  });

  it('returns a null service plan without fetching nested references when the plan was deleted', async () => {
    const fetchRefs = vi.fn();
    await expect(resolveMasterPlanNewReference('Service Plan', ref('a', 'gone'), WS, BOARD, async () => ITEM_DELETED, fetchRefs))
      .resolves.toEqual({ kind: 'servicePlan', value: null });
    await expect(resolveMasterPlanNewReference('Service Plan', ref('a', 'gone'), WS, BOARD, async () => null, fetchRefs))
      .resolves.toEqual({ kind: 'servicePlan', value: null });
    expect(fetchRefs).not.toHaveBeenCalled();
  });

  it('reads the cancellation type definition and both percentages', async () => {
    const getItemValues = itemValuesFrom({
      'ct-1': {
        id: 'ct-1',
        values: [
          value('Definition', 'Cancelled with less than 7 clear days notice'),
          value('Billable to Client %', 100, 'number'),
          value('Payable to Worker %', 100, 'number'),
          value('Cancellation Type', 'Short Notice'),
        ],
      },
    });
    await expect(resolveMasterPlanNewReference('Cancellation Type', ref('a', 'ct-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({
        kind: 'cancellationType',
        value: {
          definition: 'Cancelled with less than 7 clear days notice',
          billableToClient: '100',
          payableToWorker: '100',
        },
      });
  });

  it('blanks missing cancellation type fields', async () => {
    const getItemValues = itemValuesFrom({ 'ct-1': { id: 'ct-1', values: [] } });
    await expect(resolveMasterPlanNewReference('Cancellation Type', ref('a', 'ct-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({ kind: 'cancellationType', value: { definition: '', billableToClient: '', payableToWorker: '' } });
  });

  const fund = (fundAmount, previouslyUsed, invoiced) => ({
    id: 'fund-1',
    values: [
      value('Fund Amount($)', fundAmount, 'number'),
      value('Previously Used ($)', previouslyUsed, 'number'),
      value('Invoiced and Received Amount($)', invoiced, 'number'),
      value('Fund Name', 'Core Supports'),
    ],
  });

  it.each([
    // 12000 - 3000 - 2000 = 7000 remaining, 58.33% of the fund -> within budget
    [12000, 3000, 2000, '👍 Within Budget'],
    // 10000 - 8000 - 4000 = -2000 remaining, -20% -> over budget
    [10000, 8000, 4000, '👎 Over Budget'],
    // 10000 - 6000 - 4000 = 0 remaining, exactly 0% -> on budget
    [10000, 6000, 4000, '👌 On Budget'],
    // 1 cent left out of 10000 is still positive -> within budget
    [10000, 6000, 3999.99, '👍 Within Budget'],
  ])('reports %s - %s - %s as %s', async (amount, used, invoiced, expected) => {
    const getItemValues = itemValuesFrom({ 'fund-1': fund(amount, used, invoiced) });
    await expect(resolveMasterPlanNewReference('Fund', ref('a', 'fund-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({ kind: 'fund', value: { fundingBudgetStatus: expected } });
  });

  it('avoids dividing by a zero fund amount and calls it on budget', async () => {
    const getItemValues = itemValuesFrom({ 'fund-1': fund(0, 500, 0) });
    await expect(resolveMasterPlanNewReference('Fund', ref('a', 'fund-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({ kind: 'fund', value: { fundingBudgetStatus: '👌 On Budget' } });
  });

  it('coerces string amounts, which is how ISO+ sends them', async () => {
    const getItemValues = itemValuesFrom({ 'fund-1': fund('10000', '8000', '4000') });
    await expect(resolveMasterPlanNewReference('Fund', ref('a', 'fund-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({ kind: 'fund', value: { fundingBudgetStatus: '👎 Over Budget' } });
  });

  it('treats missing fund values as zero and reports on budget', async () => {
    const getItemValues = itemValuesFrom({ 'fund-1': { id: 'fund-1', values: [value('Fund Name', 'Core Supports')] } });
    await expect(resolveMasterPlanNewReference('Fund', ref('a', 'fund-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({ kind: 'fund', value: { fundingBudgetStatus: '👌 On Budget' } });
  });

  it('reports a negative fund amount as within budget (both sides of the ratio are negative)', async () => {
    const getItemValues = itemValuesFrom({ 'fund-1': fund(-500, 0, 0) });
    await expect(resolveMasterPlanNewReference('Fund', ref('a', 'fund-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({ kind: 'fund', value: { fundingBudgetStatus: '👍 Within Budget' } });
  });

  it('reports a formatted, unparseable fund amount as on budget', async () => {
    const getItemValues = itemValuesFrom({ 'fund-1': fund('$12,000', 0, 0) });
    await expect(resolveMasterPlanNewReference('Fund', ref('a', 'fund-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({ kind: 'fund', value: { fundingBudgetStatus: '👌 On Budget' } });
  });

  it('reads the eight participant profile fields', async () => {
    const getItemValues = itemValuesFrom({
      'pp-1': {
        id: 'pp-1',
        values: [
          value('Billing Contact', 'Alex Fixture'),
          value('Billing Address', '4 Sample Road, Testville NSW 2000'),
          value('Primary Phone Number', '0400 000 000'),
          value('Email', 'jordan@example.invalid'),
          value('Address', '2 Sample Road, Testville NSW 2000'),
          value('First Name', 'Jordan'),
          value('Last Name', 'Fixture'),
          value('Full Name/Preferred Name', 'Jordan Fixture'),
          value('NDIS Number', '430000000'),
        ],
      },
    });
    await expect(resolveMasterPlanNewReference('Participant Profile', ref('a', 'pp-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({
        kind: 'participantProfile',
        value: {
          billingContact: 'Alex Fixture',
          billingAddress: '4 Sample Road, Testville NSW 2000',
          Phone: '0400 000 000',
          email: 'jordan@example.invalid',
          address: '2 Sample Road, Testville NSW 2000',
          firstName: 'Jordan',
          lastName: 'Fixture',
          fullName: 'Jordan Fixture',
        },
      });
  });

  it('blanks missing participant profile fields', async () => {
    const getItemValues = itemValuesFrom({ 'pp-1': { id: 'pp-1', values: [value('First Name', 'Jordan')] } });
    const { value: profile } = await resolveMasterPlanNewReference(
      'Participant Profile', ref('a', 'pp-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs,
    );
    expect(profile).toEqual({
      billingContact: '', billingAddress: '', Phone: '', email: '', address: '',
      firstName: 'Jordan', lastName: '', fullName: '',
    });
  });

  it('reads the participation type and its definition', async () => {
    const getItemValues = itemValuesFrom({
      'pt-1': {
        id: 'pt-1',
        values: [value('Participation Type', '1:1'), value('Definition', 'One worker to one participant')],
      },
    });
    await expect(resolveMasterPlanNewReference('Participation Type', ref('a', 'pt-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({ kind: 'participationType', value: { participationType: '1:1', definition: 'One worker to one participant' } });
  });

  it.each(['Cancellation Type', 'Fund', 'Participant Profile', 'Participation Type'])(
    'returns a null %s value when the reference was deleted',
    async (attributeName) => {
      const { value: resolved } = await resolveMasterPlanNewReference(
        attributeName, ref('a', 'gone'), WS, BOARD, async () => ITEM_DELETED, fetchParticipantsPlanRefs,
      );
      expect(resolved).toBeNull();
    },
  );

  it.each([
    ['Cancellation Type', 'cancellationType', { definition: '', billableToClient: '', payableToWorker: '' }],
    // No amounts at all: 0 - 0 - 0 = 0 available against a 0 fund, so the
    // divide-by-zero guard reports on budget rather than NaN.
    ['Fund', 'fund', { fundingBudgetStatus: '👌 On Budget' }],
    ['Participant Profile', 'participantProfile', {
      billingContact: '', billingAddress: '', Phone: '', email: '',
      address: '', firstName: '', lastName: '', fullName: '',
    }],
    ['Participation Type', 'participationType', { participationType: '', definition: '' }],
  ])('builds a fully blank %s value when the row carries no values array', async (attributeName, kind, expected) => {
    const getItemValues = itemValuesFrom({ 'row-1': { id: 'row-1' } });
    await expect(
      resolveMasterPlanNewReference(attributeName, ref('a', 'row-1'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs),
    ).resolves.toEqual({ kind, value: expected });
  });

  it('classifies an unhandled attribute as unknown without loading anything', async () => {
    const getItemValues = vi.fn();
    await expect(resolveMasterPlanNewReference('Generated PDF Link', ref('a', 'x'), WS, BOARD, getItemValues, fetchParticipantsPlanRefs))
      .resolves.toEqual({ kind: 'unknown', value: null });
    expect(getItemValues).not.toHaveBeenCalled();
  });
});

describe('fetchNewNdisMasterPlanReferencedItems', () => {
  const table = {
    'plan-1': { id: 'plan-1', values: [value('Support Item Number', '01_011_0107_1_1')] },
    'ct-1': { id: 'ct-1', values: [value('Definition', 'Short notice'), value('Billable to Client %', 100, 'number')] },
    'fund-1': {
      id: 'fund-1',
      values: [
        value('Fund Amount($)', 12000, 'number'),
        value('Previously Used ($)', 3000, 'number'),
        value('Invoiced and Received Amount($)', 2000, 'number'),
      ],
    },
    'pp-1': { id: 'pp-1', values: [value('Full Name/Preferred Name', 'Jordan Fixture')] },
    'ptype-1': { id: 'ptype-1', values: [value('Participation Type', '1:1'), value('Definition', 'One to one')] },
  };
  const names = {
    'ref-plan': 'Service Plan',
    'ref-ct': 'Cancellation Type',
    'ref-fund': 'Fund',
    'ref-pp': 'Participant Profile',
    'ref-ptype': 'Participation Type',
    'ref-pdf': 'Generated PDF Link',
  };

  function run(refs) {
    return fetchNewNdisMasterPlanReferencedItems({
      workspaceId: WS,
      boardId: BOARD,
      itemId: 'master-plan-1',
      getReferences: async () => (refs === null ? null : { data: refs }),
      getAttribute: async (_ws, _b, attributeId) => (names[attributeId] ? { name: names[attributeId] } : null),
      getItemValues: itemValuesFrom(table),
      fetchParticipantsPlanRefs: async () => [null, null, null, null, null, null, null],
    });
  }

  it('returns five nulls when getReferences answers nothing', async () => {
    await expect(run(null)).resolves.toEqual([null, null, null, null, null]);
  });

  it('returns five nulls when the reference response has no data array', async () => {
    await expect(fetchNewNdisMasterPlanReferencedItems({
      workspaceId: WS,
      boardId: BOARD,
      itemId: 'master-plan-1',
      getReferences: async () => ({ status: 200 }),
      getAttribute: vi.fn(),
      getItemValues: vi.fn(),
      fetchParticipantsPlanRefs: vi.fn(),
    })).resolves.toEqual([null, null, null, null, null]);
  });

  it('returns five nulls when there are no references', async () => {
    await expect(run([])).resolves.toEqual([null, null, null, null, null]);
  });

  it('fills the five master plan buckets in order', async () => {
    const result = await run([
      ref('ref-ptype', 'ptype-1'),
      ref('ref-pp', 'pp-1'),
      ref('ref-fund', 'fund-1'),
      ref('ref-ct', 'ct-1'),
      ref('ref-plan', 'plan-1'),
    ]);
    expect(result).toHaveLength(5);
    expect(result[0].supportItemNumber).toBe('01_011_0107_1_1');
    expect(result[1]).toEqual({ definition: 'Short notice', billableToClient: '100', payableToWorker: '' });
    expect(result[2]).toEqual({ fundingBudgetStatus: '👍 Within Budget' });
    expect(result[3].fullName).toBe('Jordan Fixture');
    expect(result[4]).toEqual({ participationType: '1:1', definition: 'One to one' });
  });

  it('leaves a bucket null when its reference resolves to nothing', async () => {
    const result = await fetchNewNdisMasterPlanReferencedItems({
      workspaceId: WS,
      boardId: BOARD,
      itemId: 'master-plan-1',
      getReferences: async () => ({ data: [ref('ref-plan', 'plan-1'), ref('ref-fund', 'fund-1')] }),
      getAttribute: async (_ws, _b, attributeId) => ({ name: names[attributeId] }),
      getItemValues: async (_ws, _b, itemId) => (itemId === 'plan-1' ? ITEM_DELETED : table[itemId]),
      fetchParticipantsPlanRefs: async () => [null, null, null, null, null, null, null],
    });
    expect(result[0]).toBeNull();
    expect(result[2]).toEqual({ fundingBudgetStatus: '👍 Within Budget' });
  });

  it('skips references whose attribute cannot be loaded and unhandled attributes', async () => {
    await expect(run([ref('ref-missing', 'plan-1'), ref('ref-pdf', 'plan-1')]))
      .resolves.toEqual([null, null, null, null, null]);
  });
});
