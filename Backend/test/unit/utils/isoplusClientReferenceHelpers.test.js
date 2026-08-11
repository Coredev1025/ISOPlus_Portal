import { describe, it, expect, vi } from 'vitest';
import {
  buildPartyContactValues,
  buildJobTypeValues,
  fetchPartyJobTypeReferencedItems,
} from '../../../src/utils/isoplusClientReferenceHelpers.js';

// ISO+ item values are `{ attribute: { name, settings? }, data }`. `State` is a
// select attribute: its `data` is an array of label ids, and the human-readable
// name lives on the attribute's own settings.labels.
const value = (name, data) => ({ attribute: { name }, data });
const selectValue = (name, data, labels) => ({
  attribute: { name, settings: { labels } },
  data,
});

const STATE_LABELS = [
  { id: '1', name: 'NSW' },
  { id: '2', name: 'VIC' },
  { id: '3', name: 'QLD' },
];

function clientValues(overrides = []) {
  return [
    value('Client', 'Acme Care Pty Ltd'),
    value('Email Address', 'billing@acme.test'),
    value('Phone Number', '0400 000 111'),
    value('Address', '12 Smith Street'),
    value('Suburb', 'Richmond'),
    selectValue('State', ['2'], STATE_LABELS),
    value('Postcode', '3121'),
    ...overrides,
  ];
}

describe('buildPartyContactValues', () => {
  it('maps every contact field, keys the party name by outputKey, resolves the state label and parses the postcode to a number', () => {
    expect(buildPartyContactValues(clientValues(), 'Client', 'client')).toEqual({
      client: 'Acme Care Pty Ltd',
      emailAddress: 'billing@acme.test',
      phoneNumber: '0400 000 111',
      address: '12 Smith Street',
      suburb: 'Richmond',
      state: 'VIC',
      postcode: 3121,
      contactPersonsFirstName: '',
      contactPersonsLastName: '',
      updatedAt: '',
    });
  });

  it('uses the caller-supplied party label and output key rather than a hard-coded "client"', () => {
    const values = [
      value('Contractor', 'Bob the Builder'),
      value('Email Address', 'bob@build.test'),
      value('Phone Number', '0411 222 333'),
      value('Address', '9 Tool Lane'),
      value('Suburb', 'Preston'),
      selectValue('State', ['1'], STATE_LABELS),
      value('Postcode', '3072'),
    ];
    const result = buildPartyContactValues(values, 'Contractor', 'contractor');
    expect(result.contractor).toBe('Bob the Builder');
    expect(result.client).toBeUndefined();
    expect(result.state).toBe('NSW');
    expect(result.postcode).toBe(3072);
  });

  it('reads the optional contact-person and updated-at fields when present', () => {
    const result = buildPartyContactValues(
      clientValues([
        value("Contact Person's First Name", 'Dana'),
        value("Contact Person's Last Name", 'Reed'),
        value('Updated At', '2026-08-01T09:30:00Z'),
      ]),
      'Client',
      'client',
    );
    expect(result.contactPersonsFirstName).toBe('Dana');
    expect(result.contactPersonsLastName).toBe('Reed');
    expect(result.updatedAt).toBe('2026-08-01T09:30:00Z');
  });

  it('stringifies non-string data, including numeric names and numeric optional fields', () => {
    const values = [
      value('Client', 12345),
      value('Email Address', 'a@b.test'),
      value('Phone Number', 61400000000),
      value('Address', '1 A St'),
      value('Suburb', 'B'),
      selectValue('State', ['3'], STATE_LABELS),
      value('Postcode', 4000),
      value("Contact Person's First Name", 0),
    ];
    const result = buildPartyContactValues(values, 'Client', 'client');
    expect(result.client).toBe('12345');
    expect(result.phoneNumber).toBe('61400000000');
    expect(result.postcode).toBe(4000);
    expect(result.contactPersonsFirstName).toBe('0');
  });

  it('parses a postcode with trailing text and yields NaN for a non-numeric one', () => {
    const trailing = buildPartyContactValues(
      [...clientValues().filter((v) => v.attribute.name !== 'Postcode'), value('Postcode', '3121 VIC')],
      'Client',
      'client',
    );
    expect(trailing.postcode).toBe(3121);

    const unparseable = buildPartyContactValues(
      [...clientValues().filter((v) => v.attribute.name !== 'Postcode'), value('Postcode', 'N/A')],
      'Client',
      'client',
    );
    expect(unparseable.postcode).toBeNaN();
  });

  describe('state label resolution', () => {
    const withState = (stateValue) => [
      ...clientValues().filter((v) => v.attribute.name !== 'State'),
      stateValue,
    ];

    it('returns an empty string when the selected id has no matching label', () => {
      const result = buildPartyContactValues(withState(selectValue('State', ['9'], STATE_LABELS)), 'Client', 'client');
      expect(result.state).toBe('');
    });

    it('returns an empty string when the State data array is empty', () => {
      const result = buildPartyContactValues(withState(selectValue('State', [], STATE_LABELS)), 'Client', 'client');
      expect(result.state).toBe('');
    });

    it('returns an empty string when the attribute carries no settings.labels', () => {
      const result = buildPartyContactValues(withState(value('State', ['2'])), 'Client', 'client');
      expect(result.state).toBe('');
    });

    it('stringifies a numeric selected id before matching, so a numeric label id never matches', () => {
      const stringLabels = buildPartyContactValues(
        withState(selectValue('State', [2], STATE_LABELS)),
        'Client',
        'client',
      );
      expect(stringLabels.state).toBe('VIC');

      // label.id === stateId is strict, and stateId is always a string.
      const numericLabels = buildPartyContactValues(
        withState(selectValue('State', [2], [{ id: 2, name: 'VIC' }])),
        'Client',
        'client',
      );
      expect(numericLabels.state).toBe('');
    });

    it('indexes into a plain string State value, matching on its first character only', () => {
      const result = buildPartyContactValues(
        withState(selectValue('State', 'NSW', [{ id: 'N', name: 'First character' }])),
        'Client',
        'client',
      );
      expect(result.state).toBe('First character');
    });
  });

  describe('required fields', () => {
    const omit = (name) => clientValues().filter((v) => v.attribute.name !== name);

    it('throws when the party attribute itself is missing, naming the party label', () => {
      expect(() => buildPartyContactValues(omit('Client'), 'Client', 'client')).toThrow('Client is required');
      expect(() => buildPartyContactValues(omit('Client'), 'Contractor', 'contractor')).toThrow(
        'Contractor is required',
      );
    });

    it.each([
      ['Email Address', 'Client email address is required'],
      ['Phone Number', 'Client phone number is required'],
      ['Address', 'Client address is required'],
      ['Suburb', 'Client suburb is required'],
      ['State', 'Client state is required'],
      ['Postcode', 'Client postcode is required'],
    ])('throws "%s is required" with a lower-cased field name', (field, message) => {
      expect(() => buildPartyContactValues(omit(field), 'Client', 'client')).toThrow(message);
    });

    it('reports the party attribute before any contact field when several are missing', () => {
      expect(() => buildPartyContactValues([], 'Contractor', 'contractor')).toThrow('Contractor is required');
    });

    it('reports contact fields in declaration order', () => {
      const values = [value('Client', 'Acme')];
      expect(() => buildPartyContactValues(values, 'Client', 'client')).toThrow('Client email address is required');
      expect(() => buildPartyContactValues([...values, value('Email Address', 'a@b')], 'Client', 'client')).toThrow(
        'Client phone number is required',
      );
    });
  });
});

describe('buildJobTypeValues', () => {
  it('returns the stringified job type and job code', () => {
    expect(buildJobTypeValues([value('Job Type', 'NDIS Support'), value('Job Code', 4402)])).toEqual({
      jobType: 'NDIS Support',
      jobCode: '4402',
    });
  });

  it('throws when Job Type is missing', () => {
    expect(() => buildJobTypeValues([value('Job Code', 'JC1')])).toThrow('Job Type is required');
  });

  it('throws when Job Code is missing', () => {
    expect(() => buildJobTypeValues([value('Job Type', 'NDIS Support')])).toThrow('Job Code is required');
  });

  it('checks Job Type before Job Code', () => {
    expect(() => buildJobTypeValues([])).toThrow('Job Type is required');
  });
});

describe('fetchPartyJobTypeReferencedItems', () => {
  const WS = 'ws-1';
  const BOARD = 'board-1';
  const ITEM = 'item-1';

  function makeDeps({ references, attributes = {}, items = {} } = {}) {
    const calls = { getReferences: [], getAttribute: [], getItemValues: [] };
    return {
      calls,
      args: {
        workspaceId: WS,
        boardId: BOARD,
        itemId: ITEM,
        partyAttributeName: 'Client',
        partyLabel: 'Client',
        outputKey: 'client',
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
      },
    };
  }

  const jobTypeItem = { id: 'jt-1', values: [value('Job Type', 'NDIS Support'), value('Job Code', 'JC-9')] };
  const clientItem = { id: 'cl-1', values: clientValues() };

  it('resolves the party reference and the Job Type reference into a two-element tuple', async () => {
    const { args } = makeDeps({
      references: {
        data: [
          { attribute_id: 'a-client', to_item_id: 'cl-1' },
          { attribute_id: 'a-jobtype', to_item_id: 'jt-1' },
        ],
      },
      attributes: { 'a-client': { name: 'Client' }, 'a-jobtype': { name: 'Job Type' } },
      items: { 'cl-1': clientItem, 'jt-1': jobTypeItem },
    });

    const [party, jobType] = await fetchPartyJobTypeReferencedItems(args);

    expect(party).toEqual({
      client: 'Acme Care Pty Ltd',
      emailAddress: 'billing@acme.test',
      phoneNumber: '0400 000 111',
      address: '12 Smith Street',
      suburb: 'Richmond',
      state: 'VIC',
      postcode: 3121,
      contactPersonsFirstName: '',
      contactPersonsLastName: '',
      updatedAt: '',
    });
    expect(jobType).toEqual({ jobType: 'NDIS Support', jobCode: 'JC-9' });
  });

  it('passes workspace, board and the reference target through to every collaborator', async () => {
    const { calls, args } = makeDeps({
      references: { data: [{ attribute_id: 'a-client', to_item_id: 'cl-1' }] },
      attributes: { 'a-client': { name: 'Client' } },
      items: { 'cl-1': clientItem },
    });

    await fetchPartyJobTypeReferencedItems(args);

    expect(calls.getReferences).toEqual([[WS, BOARD, ITEM]]);
    expect(calls.getAttribute).toEqual([[WS, BOARD, 'a-client']]);
    expect(calls.getItemValues).toEqual([[WS, BOARD, 'cl-1']]);
  });

  it('matches the party by the caller-supplied attribute name, not the literal "Client"', async () => {
    const contractorItem = {
      values: [
        value('Contractor', 'Bob the Builder'),
        value('Email Address', 'bob@build.test'),
        value('Phone Number', '0411'),
        value('Address', '9 Tool Lane'),
        value('Suburb', 'Preston'),
        selectValue('State', ['1'], STATE_LABELS),
        value('Postcode', '3072'),
      ],
    };
    const { args } = makeDeps({
      references: { data: [{ attribute_id: 'a-con', to_item_id: 'con-1' }] },
      attributes: { 'a-con': { name: 'Contractor' } },
      items: { 'con-1': contractorItem },
    });
    args.partyAttributeName = 'Contractor';
    args.partyLabel = 'Contractor';
    args.outputKey = 'contractor';

    const [party, jobType] = await fetchPartyJobTypeReferencedItems(args);
    expect(party.contractor).toBe('Bob the Builder');
    expect(jobType).toBeNull();
  });

  it('returns [null, null] without touching attributes when getReferences is falsy', async () => {
    const { calls, args } = makeDeps({ references: null });
    await expect(fetchPartyJobTypeReferencedItems(args)).resolves.toEqual([null, null]);
    expect(calls.getAttribute).toEqual([]);
    expect(calls.getItemValues).toEqual([]);
  });

  it('returns [null, null] for an empty reference list', async () => {
    const { args } = makeDeps({ references: { data: [] } });
    await expect(fetchPartyJobTypeReferencedItems(args)).resolves.toEqual([null, null]);
  });

  it('skips a reference whose attribute cannot be resolved rather than aborting the loop', async () => {
    const { calls, args } = makeDeps({
      references: {
        data: [
          { attribute_id: 'a-missing', to_item_id: 'ghost' },
          { attribute_id: 'a-jobtype', to_item_id: 'jt-1' },
        ],
      },
      attributes: { 'a-jobtype': { name: 'Job Type' } },
      items: { 'jt-1': jobTypeItem },
    });

    const [party, jobType] = await fetchPartyJobTypeReferencedItems(args);
    expect(party).toBeNull();
    expect(jobType).toEqual({ jobType: 'NDIS Support', jobCode: 'JC-9' });
    expect(calls.getItemValues).toEqual([[WS, BOARD, 'jt-1']]);
  });

  it('ignores references for unrelated attributes', async () => {
    const { calls, args } = makeDeps({
      references: { data: [{ attribute_id: 'a-other', to_item_id: 'x-1' }] },
      attributes: { 'a-other': { name: 'Service Fee Type' } },
    });

    await expect(fetchPartyJobTypeReferencedItems(args)).resolves.toEqual([null, null]);
    expect(calls.getItemValues).toEqual([]);
  });

  it('yields null for a reference whose item cannot be fetched', async () => {
    const { args } = makeDeps({
      references: { data: [{ attribute_id: 'a-client', to_item_id: 'gone' }] },
      attributes: { 'a-client': { name: 'Client' } },
      items: {},
    });
    await expect(fetchPartyJobTypeReferencedItems(args)).resolves.toEqual([null, null]);
  });

  it('lets a later reference of the same attribute overwrite an earlier one, including back to null', async () => {
    const { args } = makeDeps({
      references: {
        data: [
          { attribute_id: 'a-client', to_item_id: 'cl-1' },
          { attribute_id: 'a-client', to_item_id: 'gone' },
        ],
      },
      attributes: { 'a-client': { name: 'Client' } },
      items: { 'cl-1': clientItem },
    });

    const [party] = await fetchPartyJobTypeReferencedItems(args);
    expect(party).toBeNull();
  });

  it('propagates a validation error from the referenced party item', async () => {
    const { args } = makeDeps({
      references: { data: [{ attribute_id: 'a-client', to_item_id: 'bad' }] },
      attributes: { 'a-client': { name: 'Client' } },
      items: { bad: { values: [value('Client', 'Acme')] } },
    });
    await expect(fetchPartyJobTypeReferencedItems(args)).rejects.toThrow('Client email address is required');
  });

  it('propagates a validation error from the referenced Job Type item', async () => {
    const { args } = makeDeps({
      references: { data: [{ attribute_id: 'a-jobtype', to_item_id: 'bad' }] },
      attributes: { 'a-jobtype': { name: 'Job Type' } },
      items: { bad: { values: [value('Job Type', 'NDIS')] } },
    });
    await expect(fetchPartyJobTypeReferencedItems(args)).rejects.toThrow('Job Code is required');
  });

  it('throws when the reference response has no data array — the truthiness guard does not cover it', async () => {
    const { args } = makeDeps({ references: { meta: {} } });
    await expect(fetchPartyJobTypeReferencedItems(args)).rejects.toThrow(TypeError);
  });
});
