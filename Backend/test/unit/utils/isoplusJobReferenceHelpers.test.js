import { describe, it, expect } from 'vitest';
import {
  buildJobPlanningValues,
  buildServiceFeeTypeValues,
} from '../../../src/utils/isoplusJobReferenceHelpers.js';

const value = (name, data) => ({ attribute: { name }, data });

function jobItem(overrides = []) {
  return {
    id: 'item-1',
    values: [
      value('Job Number', 4021),
      value("Client's Order Number", 'PO-77'),
      value('Job Title', 'Weekly support'),
      ...overrides,
    ],
  };
}

describe('buildJobPlanningValues', () => {
  it('returns the id and stringified job fields', () => {
    expect(buildJobPlanningValues(jobItem())).toEqual({
      id: 'item-1',
      jobNumber: '4021',
      clientOrderNumber: 'PO-77',
      jobTitle: 'Weekly support',
    });
  });

  it('throws when Job Number is missing', () => {
    const item = { id: 'x', values: [value("Client's Order Number", 'PO'), value('Job Title', 'T')] };
    expect(() => buildJobPlanningValues(item)).toThrow('Job Number is required');
  });

  it("throws when Client's Order Number is missing", () => {
    const item = { id: 'x', values: [value('Job Number', 1), value('Job Title', 'T')] };
    expect(() => buildJobPlanningValues(item)).toThrow("Client's Order Number is required");
  });

  it('throws when Job Title is missing', () => {
    const item = { id: 'x', values: [value('Job Number', 1), value("Client's Order Number", 'PO')] };
    expect(() => buildJobPlanningValues(item)).toThrow('Job Title is required');
  });

  it('uses the first match when an attribute appears twice', () => {
    const item = jobItem([value('Job Number', 9999)]);
    expect(buildJobPlanningValues(item).jobNumber).toBe('4021');
  });
});

describe('buildServiceFeeTypeValues', () => {
  it('returns the fee type and a parsed rate', () => {
    const item = {
      values: [value('Fee Type', 'Hourly'), value('Rate($) - GST Excl.', '55.75')],
    };
    expect(buildServiceFeeTypeValues(item)).toEqual({ feeType: 'Hourly', rate: 55.75 });
  });

  it('parses a numeric rate', () => {
    const item = { values: [value('Fee Type', 'Fixed'), value('Rate($) - GST Excl.', 120)] };
    expect(buildServiceFeeTypeValues(item).rate).toBe(120);
  });

  it('yields NaN for an unparseable rate rather than throwing', () => {
    const item = { values: [value('Fee Type', 'Fixed'), value('Rate($) - GST Excl.', 'n/a')] };
    expect(buildServiceFeeTypeValues(item).rate).toBeNaN();
  });

  it('throws when Fee Type is missing', () => {
    expect(() => buildServiceFeeTypeValues({ values: [] })).toThrow('Fee Type is required');
  });
});
