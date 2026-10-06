import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTE_NAMES,
  FUNDING_SOURCE_TYPES,
  BUDGET_CATEGORY_CONFIG,
  BUDGET_CATEGORY_ORDER,
  DELIVERED_BY_TYPES,
  TRANSACTION_STATUS_USE_ACTUAL_END,
  REF_ATTRIBUTE_NAMES,
} from '../../../src/constants/monthlyStatementAttributes.js';

/**
 * These constants are the contract between the monthly-statement code and the
 * attribute names ISO+ sends. The tests below assert the structural invariants
 * that a copy/paste slip would break — a duplicated budget code, a config entry
 * missing its profileKey, an order array that drifts from the config it is
 * derived from. They deliberately do not restate each literal string, which
 * would only detect intentional edits.
 */

describe('BUDGET_CATEGORY_CONFIG', () => {
  it('gives every category a code, folderName and profileKey', () => {
    for (const entry of BUDGET_CATEGORY_CONFIG) {
      expect(typeof entry.code).toBe('string');
      expect(entry.code.length).toBeGreaterThan(0);
      expect(typeof entry.folderName).toBe('string');
      expect(entry.folderName.length).toBeGreaterThan(0);
      expect(typeof entry.profileKey).toBe('string');
      expect(entry.profileKey.length).toBeGreaterThan(0);
    }
  });

  it('keeps every code unique so lookups cannot collide', () => {
    const codes = BUDGET_CATEGORY_CONFIG.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('keeps every profileKey unique so budgets cannot overwrite each other', () => {
    const keys = BUDGET_CATEGORY_CONFIG.map((c) => c.profileKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every folderName unique so a statement folder maps to one category', () => {
    const names = BUDGET_CATEGORY_CONFIG.map((c) => c.folderName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('sources each folderName from FUNDING_SOURCE_TYPES except care management', () => {
    const knownSources = new Set(Object.values(FUNDING_SOURCE_TYPES));
    const unsourced = BUDGET_CATEGORY_CONFIG
      .filter((c) => !knownSources.has(c.folderName))
      .map((c) => c.code);
    expect(unsourced).toEqual(['HSCM']);
  });

  it('covers every funding source type with a budget category', () => {
    const folderNames = new Set(BUDGET_CATEGORY_CONFIG.map((c) => c.folderName));
    for (const source of Object.values(FUNDING_SOURCE_TYPES)) {
      expect(folderNames.has(source)).toBe(true);
    }
  });
});

describe('BUDGET_CATEGORY_ORDER', () => {
  it('lists the codes in the order the config declares them', () => {
    expect(BUDGET_CATEGORY_ORDER).toEqual(['HSQ', 'HSCM', 'ATS', 'ATO', 'HMB', 'RCP', 'EOL']);
  });

  it('stays the same length as the config it is derived from', () => {
    expect(BUDGET_CATEGORY_ORDER).toHaveLength(BUDGET_CATEGORY_CONFIG.length);
  });

  it('places home support before the pathway budgets', () => {
    expect(BUDGET_CATEGORY_ORDER.indexOf('HSQ')).toBeLessThan(BUDGET_CATEGORY_ORDER.indexOf('RCP'));
    expect(BUDGET_CATEGORY_ORDER.indexOf('HSQ')).toBeLessThan(BUDGET_CATEGORY_ORDER.indexOf('EOL'));
  });
});

describe('FUNDING_SOURCE_TYPES', () => {
  it('keeps every funding source label distinct', () => {
    const values = Object.values(FUNDING_SOURCE_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('distinguishes the short-term and ongoing assistive technology budgets', () => {
    expect(FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_SHORT)
      .not.toBe(FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_ONGOING);
  });
});

describe('DELIVERED_BY_TYPES', () => {
  it('is lower-cased, because callers compare against a lower-cased attribute value', () => {
    for (const value of Object.values(DELIVERED_BY_TYPES)) {
      expect(value).toBe(value.toLowerCase());
    }
  });

  it('distinguishes company workforce from associated providers', () => {
    expect(DELIVERED_BY_TYPES.COMPANY_WORKFORCE)
      .not.toBe(DELIVERED_BY_TYPES.ASSOCIATED_PROVIDERS);
  });
});

describe('TRANSACTION_STATUS_USE_ACTUAL_END', () => {
  it('is the exact ISO+ status string, trailing full stop included', () => {
    // Month filtering switches on an equality check against the raw ISO+ value,
    // so a missing full stop silently sends every shift down the other branch.
    expect(TRANSACTION_STATUS_USE_ACTUAL_END).toBe('Delivered - To be claimed and invoiced.');
  });
});

describe('ATTRIBUTE_NAMES', () => {
  it('maps every key to a non-empty string or a list of alias strings', () => {
    for (const [key, value] of Object.entries(ATTRIBUTE_NAMES)) {
      const aliases = Array.isArray(value) ? value : [value];
      expect(aliases.length, `${key} should not be empty`).toBeGreaterThan(0);
      for (const alias of aliases) {
        expect(typeof alias, `${key} should hold strings`).toBe('string');
        expect(alias.length, `${key} should have no empty alias`).toBeGreaterThan(0);
      }
    }
  });

  it('has no leading or trailing whitespace, which would break attribute matching', () => {
    for (const [key, value] of Object.entries(ATTRIBUTE_NAMES)) {
      const aliases = Array.isArray(value) ? value : [value];
      for (const alias of aliases) {
        expect(alias, `${key} should be trimmed`).toBe(alias.trim());
      }
    }
  });

  it('gives each alias list at least two spellings and no duplicates', () => {
    // The alias lists exist because different ISO+ boards label the same field
    // differently; a list that collapsed to one entry would silently stop
    // matching the other spelling.
    const aliasKeys = Object.entries(ATTRIBUTE_NAMES)
      .filter(([, value]) => Array.isArray(value))
      .map(([key]) => key);

    expect(aliasKeys).toEqual([
      'COMMONWEALTH_UNSPENT_FUNDS',
      'PROVIDER_UNSPENT_FUNDS',
      'PARTICIPANT_UNSPENT_FUNDS',
      'AT_SHORT_TERM_DELIVERED',
      'AT_ONGOING_DELIVERED',
      'HOME_MODIFICATION_DELIVERED',
    ]);

    for (const key of aliasKeys) {
      const aliases = ATTRIBUTE_NAMES[key];
      expect(aliases.length, `${key} should list alternatives`).toBeGreaterThanOrEqual(2);
      expect(new Set(aliases).size, `${key} should not repeat an alias`).toBe(aliases.length);
    }
  });

  it('keeps the three unspent-funds alias lists from sharing a spelling', () => {
    const commonwealth = new Set(ATTRIBUTE_NAMES.COMMONWEALTH_UNSPENT_FUNDS);
    const provider = new Set(ATTRIBUTE_NAMES.PROVIDER_UNSPENT_FUNDS);
    const participant = new Set(ATTRIBUTE_NAMES.PARTICIPANT_UNSPENT_FUNDS);

    for (const alias of commonwealth) expect(provider.has(alias)).toBe(false);
    for (const alias of commonwealth) expect(participant.has(alias)).toBe(false);
    for (const alias of provider) expect(participant.has(alias)).toBe(false);
  });

  it('keeps the scheduled and actual shift timestamps distinct', () => {
    expect(ATTRIBUTE_NAMES.SCHEDULED_START).not.toBe(ATTRIBUTE_NAMES.ACTUAL_START);
    expect(ATTRIBUTE_NAMES.ACTUAL_START).not.toBe(ATTRIBUTE_NAMES.ACTUAL_END);
  });

  it('keeps the two My Aged Care ID spellings distinct, since both appear in real boards', () => {
    expect(ATTRIBUTE_NAMES.MY_AGED_CARE_ID).not.toBe(ATTRIBUTE_NAMES.MY_AGED_CARE_ID_ALT);
  });

  it('keeps the two postcode spellings distinct, since both appear in real boards', () => {
    expect(ATTRIBUTE_NAMES.POSTCODE).not.toBe(ATTRIBUTE_NAMES.POST_CODE);
  });

  it('names the money attributes with their dollar suffix, as ISO+ does', () => {
    expect(ATTRIBUTE_NAMES.UNIT_PRICE).toBe('Unit Price ($)');
    expect(ATTRIBUTE_NAMES.TOTAL_AMOUNT).toBe('Total Amount ($)');
    expect(ATTRIBUTE_NAMES.GOV_SUBSIDY).toBe('Government Subsidy ($)');
    expect(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION).toBe('Participant Contribution ($)');
  });
});

describe('REF_ATTRIBUTE_NAMES', () => {
  it('is a flat map of non-empty, trimmed strings', () => {
    for (const [key, value] of Object.entries(REF_ATTRIBUTE_NAMES)) {
      expect(typeof value, `${key} should be a string`).toBe('string');
      expect(value.length, `${key} should not be empty`).toBeGreaterThan(0);
      expect(value, `${key} should be trimmed`).toBe(value.trim());
    }
  });

  it('separates the participant-contribution percentage from the dollar amount', () => {
    expect(REF_ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION).toContain('(%)');
    expect(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION).toContain('($)');
    expect(REF_ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)
      .not.toBe(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION);
  });

  it('keeps both Service ID / Item ID spellings, including the double-spaced one', () => {
    expect(REF_ATTRIBUTE_NAMES.SERVICE_ID_ITEM_ID).toBe('Service ID /  Item ID');
    expect(REF_ATTRIBUTE_NAMES.SERVICE_ID_ITEM_ID_ALT).toBe('Service ID/Item ID');
  });

  it('keeps the wraparound attributes distinct from the plain item attributes', () => {
    expect(REF_ATTRIBUTE_NAMES.WRAPAROUND_ITEM_ID).not.toBe(REF_ATTRIBUTE_NAMES.ITEM_ID);
    expect(REF_ATTRIBUTE_NAMES.WRAPAROUND_DESCRIPTION)
      .not.toBe(REF_ATTRIBUTE_NAMES.ITEM_DESCRIPTION);
    expect(REF_ATTRIBUTE_NAMES.WRAPAROUND_DESCRIPTION_CODE)
      .not.toBe(REF_ATTRIBUTE_NAMES.ITEM_DESCRIPTION_CODE);
  });

  it('agrees with ATTRIBUTE_NAMES on the shared Service Plan ID label', () => {
    expect(REF_ATTRIBUTE_NAMES.SERVICE_PLAN_ID).toBe(ATTRIBUTE_NAMES.SERVICE_PLAN_ID);
  });
});
