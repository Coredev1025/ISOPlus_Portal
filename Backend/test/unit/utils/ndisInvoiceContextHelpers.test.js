import { describe, it, expect } from 'vitest';
import { collectInvoiceRefIdsFromMasterItems } from '../../../src/utils/ndisInvoiceContextHelpers.js';

/*
 * collectInvoiceRefIdsFromMasterItems() is the fan-out step of NDIS invoicing:
 * it reads a batch of Master Plan items and returns the ids of every referenced
 * item the invoice will need to resolve (service plan, participant profile,
 * cancellation type/reason, allowances, non-face-to-face, delivery mode).
 *
 * ISO+ stores a reference as an array of `{ id, ... }` objects, so the tests
 * below mirror that shape rather than passing bare strings, except where a bare
 * string is what the guard is there for.
 */

const SP_ID = '11111111-1111-4111-8111-111111111111';
const SP_ID_2 = '11111111-2222-4111-8111-111111111111';
const PP_ID = '22222222-1111-4111-8111-222222222222';
const PP_ID_2 = '22222222-2222-4111-8111-222222222222';
const CT_ID = '33333333-1111-4111-8111-333333333333';
const ALLOWANCE_ID = '44444444-1111-4111-8111-444444444444';
const ALLOWANCE_ID_2 = '44444444-2222-4111-8111-444444444444';
const NF2F_ID = '55555555-1111-4111-8111-555555555555';
const SDM_ID = '66666666-1111-4111-8111-666666666666';
const CR_ID = '77777777-1111-4111-8111-777777777777';

const ref = (id, name = 'ref') => ({ id, name });

/** A Master Plan item as stored in Mongo: `data` keyed by ISO+ attribute name. */
const masterItem = (data) => ({ itemId: 'mp-1', workspaceId: '55369', boardId: 'board-1', data });

const fullyReferencedItem = () => masterItem({
  'Service Plan': [ref(SP_ID, 'Service Plan A')],
  'Participant Profile': [ref(PP_ID, 'Jane Doe')],
  'Cancellation Type': [ref(CT_ID, 'Short Notice')],
  Allowances: [ref(ALLOWANCE_ID, 'Sleepover')],
  'Non-Face-to-Face Supports': [ref(NF2F_ID, 'Report writing')],
  'Service Delivery Mode': [ref(SDM_ID, 'Telehealth')],
  'Cancellation Reason': [ref(CR_ID, 'Participant health')],
});

const asArrays = (result) => Object.fromEntries(
  Object.entries(result).map(([key, set]) => [key, [...set]]),
);

describe('collectInvoiceRefIdsFromMasterItems', () => {
  // Breaks if the function returns undefined/null sets, or omits a key.
  it('returns all seven empty sets for no items', () => {
    const result = collectInvoiceRefIdsFromMasterItems([]);

    expect(Object.keys(result).sort()).toEqual([
      'allowancesRefIds',
      'cancellationReasonIds',
      'cancellationTypeIds',
      'nonFaceToFaceRefIds',
      'participantProfileIds',
      'serviceDeliveryModeIds',
      'servicePlanIds',
    ]);
    for (const value of Object.values(result)) {
      expect(value).toBeInstanceOf(Set);
      expect(value.size).toBe(0);
    }
  });

  // Breaks if any attribute is wired to the wrong set (e.g. delivery mode ids
  // landing in allowances), which would send the wrong ids to the bulk fetch.
  it('routes each attribute to its own set', () => {
    const result = collectInvoiceRefIdsFromMasterItems([fullyReferencedItem()]);

    expect(asArrays(result)).toEqual({
      servicePlanIds: [SP_ID],
      participantProfileIds: [PP_ID],
      cancellationTypeIds: [CT_ID],
      allowancesRefIds: [ALLOWANCE_ID],
      nonFaceToFaceRefIds: [NF2F_ID],
      serviceDeliveryModeIds: [SDM_ID],
      cancellationReasonIds: [CR_ID],
    });
  });

  // Breaks if the isUuidLike guard is dropped: plain labels would be fetched as
  // if they were item ids.
  it('drops values that are not uuid-shaped', () => {
    const result = collectInvoiceRefIdsFromMasterItems([masterItem({
      'Service Plan': 'Service Plan A',
      'Participant Profile': [{ id: 'not-a-uuid' }],
      'Cancellation Type': 12345,
      Allowances: ['Sleepover', ALLOWANCE_ID],
      'Non-Face-to-Face Supports': ['Report writing'],
      'Service Delivery Mode': [{ id: 'face-to-face' }],
      'Cancellation Reason': ['Participant health'],
    })]);

    expect(asArrays(result)).toEqual({
      servicePlanIds: [],
      participantProfileIds: [],
      cancellationTypeIds: [],
      allowancesRefIds: [ALLOWANCE_ID],
      nonFaceToFaceRefIds: [],
      serviceDeliveryModeIds: [],
      cancellationReasonIds: [],
    });
  });

  // Breaks if the accumulator stops being a Set (duplicates re-fetched) or is
  // reset per item (only the last item's ids survive).
  it('accumulates across items and de-duplicates', () => {
    const result = collectInvoiceRefIdsFromMasterItems([
      masterItem({
        'Service Plan': [ref(SP_ID)],
        'Participant Profile': [ref(PP_ID)],
        Allowances: [ref(ALLOWANCE_ID), ref(ALLOWANCE_ID_2)],
      }),
      masterItem({
        'Service Plan': [ref(SP_ID)],
        'Participant Profile': [ref(PP_ID_2)],
        Allowances: [ref(ALLOWANCE_ID_2)],
      }),
      masterItem({
        'Service Plan': [ref(SP_ID_2)],
        'Participant Profile': [ref(PP_ID)],
      }),
    ]);

    expect(asArrays(result)).toEqual({
      servicePlanIds: [SP_ID, SP_ID_2],
      participantProfileIds: [PP_ID, PP_ID_2],
      cancellationTypeIds: [],
      allowancesRefIds: [ALLOWANCE_ID, ALLOWANCE_ID_2],
      nonFaceToFaceRefIds: [],
      serviceDeliveryModeIds: [],
      cancellationReasonIds: [],
    });
  });

  // Breaks if extractRefId/extractAllRefIds are swapped: the single-reference
  // fields deliberately take only the first id, the multi fields take them all.
  it('takes only the first id for single-reference fields and every id for multi fields', () => {
    const result = collectInvoiceRefIdsFromMasterItems([masterItem({
      'Service Plan': [ref(SP_ID), ref(SP_ID_2)],
      'Participant Profile': [ref(PP_ID), ref(PP_ID_2)],
      Allowances: [ref(ALLOWANCE_ID), ref(ALLOWANCE_ID_2)],
    })]);

    expect(asArrays(result).servicePlanIds).toEqual([SP_ID]);
    expect(asArrays(result).participantProfileIds).toEqual([PP_ID]);
    expect(asArrays(result).allowancesRefIds).toEqual([ALLOWANCE_ID, ALLOWANCE_ID_2]);
  });

  // Breaks if the optional chaining on item?.data is removed — a sparse batch
  // (an item that synced with no values) would throw mid-invoice.
  it('skips null items and items with no data without throwing', () => {
    const result = collectInvoiceRefIdsFromMasterItems([
      null,
      undefined,
      { itemId: 'mp-empty' },
      masterItem({}),
      masterItem({ 'Service Plan': [ref(SP_ID)] }),
    ]);

    expect(asArrays(result).servicePlanIds).toEqual([SP_ID]);
    expect(result.participantProfileIds.size).toBe(0);
  });

  // Characterizes the one input it does not tolerate: the list itself.
  it('throws when the item list is missing entirely', () => {
    expect(() => collectInvoiceRefIdsFromMasterItems(null)).toThrow(TypeError);
    expect(() => collectInvoiceRefIdsFromMasterItems(undefined)).toThrow(TypeError);
  });

  // Breaks if the literal 'Cancellation Type' key is changed to the
  // 'Cancellation Reason' constant — the two are different ISO+ attributes and
  // the reason drives the NDIS claim code.
  it('reads Cancellation Type and Cancellation Reason as separate attributes', () => {
    const result = collectInvoiceRefIdsFromMasterItems([masterItem({
      'Cancellation Type': [ref(CT_ID)],
      'Cancellation Reason': [ref(CR_ID)],
    })]);

    expect([...result.cancellationTypeIds]).toEqual([CT_ID]);
    expect([...result.cancellationReasonIds]).toEqual([CR_ID]);
  });
});
