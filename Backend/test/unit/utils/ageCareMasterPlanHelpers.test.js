import { describe, it, expect } from 'vitest';
import {
  appendMasterPlanVariableUpdate,
  buildMasterPlanVariableUpdates,
} from '../../../src/utils/ageCareMasterPlanHelpers.js';

/**
 * Mirrors the resolver built in routes/ageCare.js:
 * an attribute name -> ISO+ attribute id lookup that returns undefined when absent.
 */
const ATTRIBUTE_IDS = {
  Unit: 'attr-unit',
  Quantity: 'attr-quantity',
  'Unit Price ($)': 'attr-unit-price',
  'Total Amount ($)': 'attr-total-amount',
  'Government Subsidy ($)': 'attr-gov-subsidy',
  'Participant Contribution ($)': 'attr-participant-contribution',
};

const makeResolver = (ids = ATTRIBUTE_IDS) => (attributeName) => ids[attributeName];

/** The shape getAgeCareMasterPlanReferencedItems produces for a Service Plan. */
const servicePlan = (overrides = {}) => ({
  unit: 'Per Hour',
  unitPrice: '25.50',
  participantContribution: '17.5',
  ...overrides,
});

describe('appendMasterPlanVariableUpdate', () => {
  it('pushes a {data, attribute_id} pair when both are present', () => {
    const updates = [];
    appendMasterPlanVariableUpdate(updates, makeResolver(), 'Quantity', 4.5);
    expect(updates).toEqual([{ data: 4.5, attribute_id: 'attr-quantity' }]);
  });

  it('does nothing when the data is null or undefined', () => {
    const updates = [];
    appendMasterPlanVariableUpdate(updates, makeResolver(), 'Quantity', null);
    appendMasterPlanVariableUpdate(updates, makeResolver(), 'Quantity', undefined);
    expect(updates).toEqual([]);
  });

  it('still pushes falsy-but-real values (0 and empty string)', () => {
    const updates = [];
    appendMasterPlanVariableUpdate(updates, makeResolver(), 'Total Amount ($)', 0);
    appendMasterPlanVariableUpdate(updates, makeResolver(), 'Unit', '');
    expect(updates).toEqual([
      { data: 0, attribute_id: 'attr-total-amount' },
      { data: '', attribute_id: 'attr-unit' },
    ]);
  });

  it('does nothing when the board has no such attribute', () => {
    const updates = [];
    appendMasterPlanVariableUpdate(updates, makeResolver({}), 'Quantity', 4.5);
    expect(updates).toEqual([]);
  });

  it('does nothing when the attribute id resolves to an empty string', () => {
    const updates = [];
    appendMasterPlanVariableUpdate(updates, makeResolver({ Quantity: '' }), 'Quantity', 4.5);
    expect(updates).toEqual([]);
  });

  it('appends to an existing list rather than replacing it', () => {
    const updates = [{ data: 'x', attribute_id: 'pre-existing' }];
    appendMasterPlanVariableUpdate(updates, makeResolver(), 'Quantity', 1);
    expect(updates).toEqual([
      { data: 'x', attribute_id: 'pre-existing' },
      { data: 1, attribute_id: 'attr-quantity' },
    ]);
  });
});

describe('buildMasterPlanVariableUpdates', () => {
  it('builds every variable, in source order, for a fully populated delivered shift', () => {
    const updates = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 4.5,
      unitPrice: 25.5,
      totalAmount: 114.75,
      governmentSubsidy: 94.67,
      participantContribution: 20.08,
    });

    expect(updates).toEqual([
      { data: 'Per Hour', attribute_id: 'attr-unit' },
      { data: 4.5, attribute_id: 'attr-quantity' },
      { data: 25.5, attribute_id: 'attr-unit-price' },
      { data: 114.75, attribute_id: 'attr-total-amount' },
      { data: 94.67, attribute_id: 'attr-gov-subsidy' },
      { data: 20.08, attribute_id: 'attr-participant-contribution' },
    ]);
  });

  it('skips Unit when the service plan unit is a single space', () => {
    const updates = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan({ unit: ' ' }),
      quantity: 1,
      unitPrice: 10,
      totalAmount: 10,
      governmentSubsidy: 10,
      participantContribution: 0,
    });

    expect(updates.some((u) => u.attribute_id === 'attr-unit')).toBe(false);
    expect(updates).toHaveLength(5);
  });

  it('skips Unit when the service plan unit is null or undefined', () => {
    const forNull = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan({ unit: null }),
      quantity: 1,
      unitPrice: 10,
      totalAmount: 10,
      governmentSubsidy: 10,
      participantContribution: 0,
    });
    const forUndefined = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan({ unit: undefined }),
      quantity: 1,
      unitPrice: 10,
      totalAmount: 10,
      governmentSubsidy: 10,
      participantContribution: 0,
    });

    expect(forNull.some((u) => u.attribute_id === 'attr-unit')).toBe(false);
    expect(forUndefined.some((u) => u.attribute_id === 'attr-unit')).toBe(false);
  });

  it('still writes Unit when the unit is the empty string', () => {
    const updates = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan({ unit: '' }),
      quantity: 1,
      unitPrice: 10,
      totalAmount: 10,
      governmentSubsidy: 10,
      participantContribution: 0,
    });

    expect(updates[0]).toEqual({ data: '', attribute_id: 'attr-unit' });
  });

  it('omits Quantity when it is null but keeps a zero quantity', () => {
    const omitted = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: null,
      unitPrice: 25.5,
      totalAmount: 0,
      governmentSubsidy: 0,
      participantContribution: 0,
    });
    expect(omitted.some((u) => u.attribute_id === 'attr-quantity')).toBe(false);

    const kept = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 0,
      unitPrice: 25.5,
      totalAmount: 0,
      governmentSubsidy: 0,
      participantContribution: 0,
    });
    expect(kept).toContainEqual({ data: 0, attribute_id: 'attr-quantity' });
  });

  it('omits Unit Price when it is negative but keeps zero', () => {
    const negative = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 1,
      unitPrice: -0.01,
      totalAmount: -0.01,
      governmentSubsidy: -0.01,
      participantContribution: 0,
    });
    expect(negative.some((u) => u.attribute_id === 'attr-unit-price')).toBe(false);

    const zero = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 1,
      unitPrice: 0,
      totalAmount: 0,
      governmentSubsidy: 0,
      participantContribution: 0,
    });
    expect(zero).toContainEqual({ data: 0, attribute_id: 'attr-unit-price' });
  });

  it('omits Unit Price when it is null, because the null data guard fires after the >= 0 check', () => {
    // `null >= 0` is true, so the branch is entered; appendMasterPlanVariableUpdate then drops it.
    const updates = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 1,
      unitPrice: null,
      totalAmount: 10,
      governmentSubsidy: 10,
      participantContribution: 0,
    });
    expect(updates.some((u) => u.attribute_id === 'attr-unit-price')).toBe(false);
  });

  it('omits Unit Price when it is undefined', () => {
    const updates = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 1,
      unitPrice: undefined,
      totalAmount: 10,
      governmentSubsidy: 10,
      participantContribution: 0,
    });
    expect(updates.some((u) => u.attribute_id === 'attr-unit-price')).toBe(false);
  });

  it('omits Total Amount when it is null but keeps zero', () => {
    const omitted = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 1,
      unitPrice: 25.5,
      totalAmount: null,
      governmentSubsidy: 0,
      participantContribution: 0,
    });
    expect(omitted.some((u) => u.attribute_id === 'attr-total-amount')).toBe(false);

    const kept = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 1,
      unitPrice: 25.5,
      totalAmount: 0,
      governmentSubsidy: 0,
      participantContribution: 0,
    });
    expect(kept).toContainEqual({ data: 0, attribute_id: 'attr-total-amount' });
  });

  it('omits the subsidy and contribution when they are null (the adjustment case)', () => {
    const updates = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 1,
      unitPrice: 25.5,
      totalAmount: 25.5,
      governmentSubsidy: null,
      participantContribution: null,
    });

    expect(updates).toEqual([
      { data: 'Per Hour', attribute_id: 'attr-unit' },
      { data: 1, attribute_id: 'attr-quantity' },
      { data: 25.5, attribute_id: 'attr-unit-price' },
      { data: 25.5, attribute_id: 'attr-total-amount' },
    ]);
  });

  it('writes negative subsidy and contribution values without filtering them', () => {
    const updates = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver(),
      servicePlanValues: servicePlan(),
      quantity: 2,
      unitPrice: 25.5,
      totalAmount: -51,
      governmentSubsidy: -42.08,
      participantContribution: -8.92,
    });

    expect(updates).toContainEqual({ data: -42.08, attribute_id: 'attr-gov-subsidy' });
    expect(updates).toContainEqual({ data: -8.92, attribute_id: 'attr-participant-contribution' });
  });

  it('returns an empty list when the board exposes none of the attributes', () => {
    const updates = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver({}),
      servicePlanValues: servicePlan(),
      quantity: 4.5,
      unitPrice: 25.5,
      totalAmount: 114.75,
      governmentSubsidy: 94.67,
      participantContribution: 20.08,
    });

    expect(updates).toEqual([]);
  });

  it('writes only the attributes the board actually has', () => {
    const updates = buildMasterPlanVariableUpdates({
      getAttributeId: makeResolver({ 'Total Amount ($)': 'attr-total-amount' }),
      servicePlanValues: servicePlan(),
      quantity: 4.5,
      unitPrice: 25.5,
      totalAmount: 114.75,
      governmentSubsidy: 94.67,
      participantContribution: 20.08,
    });

    expect(updates).toEqual([{ data: 114.75, attribute_id: 'attr-total-amount' }]);
  });
});
