import { describe, it, expect, vi } from 'vitest';
import {
  evaluateLegacyServicePlanIntegration,
  buildParticipantNameValue,
  buildLegacyServicePlanVariableUpdates,
  itemNumberContainsSuffix,
  getItemNumberSuffix,
  evaluateNewServicePlanIntegration,
  buildNewServicePlanVariableUpdates,
} from '../../../src/utils/ndisServicePlanVariablesHelpers.js';
import { NDIS_SERVICEPLAN_ATTR } from '../../../src/utils/ndisServiceRecords.js';
import { hasSelectionValue } from '../../../src/utils/ndisPricingRules.js';

/*
 * These helpers decide what the Service Plan board says back to the user: the
 * "Configuration Status" label (red/amber/green) and the derived Service Plan ID
 * / Participant Full Name values written back to ISO+.
 *
 * Every collaborator is injected, so the tests below pass in the *production*
 * implementations copied from src/routes/ndis.js (normalizeStringValue,
 * hasNonZeroValue, resolveConfigurationStatusLabelId) rather than stubs that
 * would let a wrong contract pass unnoticed. `hasSelectionValue` is imported
 * from its real module.
 */

// Copied verbatim from src/routes/ndis.js:144 — the shape of this function is
// part of buildParticipantNameValue's contract.
function normalizeStringValue(value) {
  if (Array.isArray(value)) {
    return value[0]?.toString().trim() || '';
  }
  return value?.toString().trim() || '';
}

// Copied verbatim from src/routes/ndis.js:374.
function hasNonZeroValue(value) {
  const numericValue = Number(value);
  return Math.abs(Number.isFinite(numericValue) ? numericValue : 0) > 0;
}

// Copied verbatim from src/routes/ndis.js:378.
function resolveConfigurationStatusLabelId(statusAttribute, desiredStatusText, fallbackColor) {
  const labels = statusAttribute?.attribute?.settings?.labels || [];
  if (!labels.length) return '';
  const normalizedDesiredText = desiredStatusText.toLowerCase();
  const exactMatch = labels.find((label) => (label.name || '').toLowerCase() === normalizedDesiredText);
  if (exactMatch?.id) return exactMatch.id;
  const includesMatch = labels.find((label) => (label.name || '').toLowerCase().includes(normalizedDesiredText));
  if (includesMatch?.id) return includesMatch.id;
  const colorMatch = labels.find((label) => label.color === fallbackColor);
  return colorMatch?.id || '';
}

const ALIGNED = { integrationMessage: 'Aligned and Correct Selection', fallbackColor: '#388903' };

describe('evaluateLegacyServicePlanIntegration', () => {
  const ok = {
    selectedItem: '01_011_0107_1_1',
    providerTravelClaimable: true,
    labourTravelTimePrice: '65.00',
    ndiaReportsClaimable: true,
    allowancesType: 'NDIA Requested Reports',
    allowancesPrice: '100.00',
    nonFaceToFaceClaimable: true,
    nonFaceToFaceSupportPrice: '60.00',
    hasNonZeroValue,
  };

  it('returns the aligned message and green when every claim is permitted', () => {
    expect(evaluateLegacyServicePlanIntegration(ok)).toEqual(ALIGNED);
  });

  // Breaks if the guard order changes: "no item selected" must be reported
  // before any claimability error, otherwise the user is told to fix a price on
  // an item they have not chosen yet.
  it('reports the missing item number first, before any claimability error', () => {
    expect(evaluateLegacyServicePlanIntegration({
      ...ok,
      selectedItem: '',
      providerTravelClaimable: false,
      nonFaceToFaceClaimable: false,
    })).toEqual({ integrationMessage: 'Error: No Item Number Selected', fallbackColor: '#C60909' });
  });

  // Breaks if a message or its colour is edited — both are written back to the
  // ISO+ Configuration Status label and the colour is the fallback match key.
  it('reports each non-claimable cost with its own message and colour', () => {
    expect(evaluateLegacyServicePlanIntegration({ ...ok, providerTravelClaimable: false })).toEqual({
      integrationMessage: 'Error: Labour Travel Time is not claimable from the NDIA.',
      fallbackColor: '#EE691E',
    });
    expect(evaluateLegacyServicePlanIntegration({ ...ok, ndiaReportsClaimable: false })).toEqual({
      integrationMessage: 'Error: NDIA Requested Reports cost is not claimable from the NDIA.',
      fallbackColor: '#D99C05',
    });
    expect(evaluateLegacyServicePlanIntegration({ ...ok, nonFaceToFaceClaimable: false })).toEqual({
      integrationMessage: 'Error: Non-face-to-face support provision is not claimable from the NDIA.',
      fallbackColor: '#CA56A8',
    });
  });

  // Breaks if the price check is dropped: a non-claimable cost that carries no
  // price is not actually a problem, so flagging it would be a false alarm.
  it('ignores a non-claimable cost that has no price', () => {
    expect(evaluateLegacyServicePlanIntegration({
      ...ok,
      providerTravelClaimable: false,
      labourTravelTimePrice: '0',
      ndiaReportsClaimable: false,
      allowancesPrice: '',
      nonFaceToFaceClaimable: false,
      nonFaceToFaceSupportPrice: null,
    })).toEqual(ALIGNED);
  });

  // Breaks if the allowances rule stops being specific to NDIA Requested
  // Reports: a sleepover allowance is claimable whatever the reports flag says.
  it('applies the reports rule only to the NDIA Requested Reports allowance type', () => {
    expect(evaluateLegacyServicePlanIntegration({
      ...ok,
      ndiaReportsClaimable: false,
      allowancesType: 'Sleepover',
    })).toEqual(ALIGNED);
  });

  // Breaks if a negative price stops counting: a credit is still a value that
  // cannot be claimed.
  it('treats a negative price as a non-zero value', () => {
    expect(evaluateLegacyServicePlanIntegration({
      ...ok,
      providerTravelClaimable: false,
      labourTravelTimePrice: '-1',
    }).fallbackColor).toBe('#EE691E');
  });
});

describe('buildParticipantNameValue', () => {
  // Breaks if the full name stops winning, or if the first/last join loses its
  // space — this string becomes the Participant Full Name written to ISO+.
  it('prefers the full name, otherwise joins first and last with one space', () => {
    expect(buildParticipantNameValue({ fullName: ' Samuel Rivers ' }, normalizeStringValue))
      .toBe('Samuel Rivers');
    expect(buildParticipantNameValue({ firstName: 'Samuel', lastName: 'Rivers' }, normalizeStringValue))
      .toBe('Samuel Rivers');
  });

  it('handles a missing half of the name and an entirely empty profile', () => {
    expect(buildParticipantNameValue({ firstName: 'Samuel' }, normalizeStringValue)).toBe('Samuel');
    expect(buildParticipantNameValue({ lastName: 'Rivers' }, normalizeStringValue)).toBe('Rivers');
    expect(buildParticipantNameValue({}, normalizeStringValue)).toBe('');
    expect(buildParticipantNameValue(null, normalizeStringValue)).toBe('');
  });

  // Breaks if the array unwrapping is lost — ISO+ sends reference-shaped values
  // as arrays and the raw array would stringify into the name.
  it('unwraps ISO+ array values through the injected normalizer', () => {
    expect(buildParticipantNameValue({ fullName: ['Samuel Rivers'] }, normalizeStringValue))
      .toBe('Samuel Rivers');
  });
});

describe('item number suffixes', () => {
  // Breaks if the leading underscore is dropped from the match: "01_011_0107"
  // contains "01" but must not be read as carrying a suffix.
  it('matches a suffix only when preceded by an underscore', () => {
    expect(itemNumberContainsSuffix('01_011_0107_1_1_TH', 'TH')).toBe(true);
    expect(itemNumberContainsSuffix('01_011_0107_1_1_th', 'th')).toBe(true);
    expect(itemNumberContainsSuffix(' 01_011_0107_1_1_PT ', 'pt')).toBe(true);
    expect(itemNumberContainsSuffix('01_011_0107_1_1TH', 'TH')).toBe(false);
    expect(itemNumberContainsSuffix('', 'TH')).toBe(false);
    expect(itemNumberContainsSuffix('01_011_0107_1_1_TH', '')).toBe(false);
    expect(itemNumberContainsSuffix(null, 'TH')).toBe(false);
  });

  // Breaks if the known-suffix list changes or reorders — TH is checked before
  // NF, RR, PT and CA.
  it('returns the first recognised suffix, or empty for none', () => {
    expect(getItemNumberSuffix('01_011_0107_1_1_TH')).toBe('TH');
    expect(getItemNumberSuffix('01_011_0107_1_1_NF')).toBe('NF');
    expect(getItemNumberSuffix('01_011_0107_1_1_RR')).toBe('RR');
    expect(getItemNumberSuffix('01_799_0107_1_1_PT')).toBe('PT');
    expect(getItemNumberSuffix('01_011_0107_1_1_CA')).toBe('CA');
    expect(getItemNumberSuffix('01_011_0107_1_1')).toBe('');
    expect(getItemNumberSuffix('')).toBe('');
    expect(getItemNumberSuffix(null)).toBe('');
  });

  it('prefers TH when several suffixes are present', () => {
    expect(getItemNumberSuffix('01_011_0107_1_1_PT_TH')).toBe('TH');
  });
});

describe('evaluateNewServicePlanIntegration', () => {
  const base = () => ({
    serviceAreaValues: { serviceArea: 'ACT', serviceAreaType: 'ACT($)' },
    sdm: 'Face to Face',
    hasParticipantIntakeForm: true,
    hasAnyItemNumber: true,
    itemsValues: {
      [NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT]: ['sup-ref'],
      [NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR]: ['pt-ref'],
      [NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME]: ['ltt-ref'],
      [NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION]: ['canc-ref'],
      [NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT]: ['abt-ref'],
    },
    expectedSuffix: '',
    supportSuffix: '',
    resolvedProviderTravelValues: { itemName: 'Provider Travel - Non-Labour Cost' },
    resolvedLabourTravelValues: { itemNumber: '01_799_0107_1_1_PT' },
    resolvedCancellationValues: { itemNumber: '01_011_0107_1_1_CA' },
    resolvedActivityBasedTransportValues: { itemName: 'Activity Based Transport' },
    hasSelectionValue,
    NDIS_SERVICEPLAN_ATTR,
  });

  it('returns aligned when every selection is consistent', () => {
    expect(evaluateNewServicePlanIntegration(base())).toEqual(ALIGNED);
  });

  // Breaks if the guard order changes: the checks run outermost-first (service
  // area, then delivery mode, then intake form, then item number), and each
  // later message would mask the earlier, more actionable one.
  it('reports the prerequisites in order, each with its own colour', () => {
    expect(evaluateNewServicePlanIntegration({ ...base(), serviceAreaValues: {}, sdm: '' }))
      .toEqual({ integrationMessage: 'Error: No Service Area selected', fallbackColor: '#FFB186' });
    expect(evaluateNewServicePlanIntegration({ ...base(), sdm: '', hasParticipantIntakeForm: false }))
      .toEqual({ integrationMessage: 'Error: No Service Delivery Mode selected', fallbackColor: '#FFD3F2' });
    expect(evaluateNewServicePlanIntegration({ ...base(), hasParticipantIntakeForm: false, hasAnyItemNumber: false }))
      .toEqual({ integrationMessage: 'Error: No Participant Intake Form Selected', fallbackColor: '#F36363' });
    expect(evaluateNewServicePlanIntegration({ ...base(), hasAnyItemNumber: false }))
      .toEqual({ integrationMessage: 'Error: No Item Number Selected', fallbackColor: '#C60909' });
  });

  // Breaks if either half of the service-area check goes: only one of the two
  // fields needs a value.
  it('accepts a service area given by either field alone', () => {
    expect(evaluateNewServicePlanIntegration({ ...base(), serviceAreaValues: { serviceArea: 'ACT' } }))
      .toEqual(ALIGNED);
    expect(evaluateNewServicePlanIntegration({ ...base(), serviceAreaValues: { serviceAreaType: 'ACT($)' } }))
      .toEqual(ALIGNED);
    expect(evaluateNewServicePlanIntegration({ ...base(), serviceAreaValues: null }).fallbackColor)
      .toBe('#FFB186');
  });

  // Breaks on a wrong suffix comparison: a telehealth delivery mode must be
  // paired with a _TH item number, and a mismatch would claim the wrong item.
  it('flags a support item number whose suffix disagrees with the delivery mode', () => {
    expect(evaluateNewServicePlanIntegration({ ...base(), expectedSuffix: 'TH', supportSuffix: '' }))
      .toEqual({
        integrationMessage: 'Error: The selected Item Number does not match the selected Service Delivery Mode.',
        fallbackColor: '#EE691E',
      });
    expect(evaluateNewServicePlanIntegration({ ...base(), expectedSuffix: 'TH', supportSuffix: 'TH' }))
      .toEqual(ALIGNED);
  });

  // Breaks if the null sentinel loses its meaning: `null` means "this delivery
  // mode does not constrain the suffix" and must skip the check entirely.
  it('skips the suffix check when the expected suffix is null', () => {
    expect(evaluateNewServicePlanIntegration({ ...base(), expectedSuffix: null, supportSuffix: 'TH' }))
      .toEqual(ALIGNED);
  });

  it('skips the suffix check when no support item is selected', () => {
    const ctx = base();
    ctx.itemsValues[NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT] = [];
    expect(evaluateNewServicePlanIntegration({ ...ctx, expectedSuffix: 'TH', supportSuffix: '' }))
      .toEqual(ALIGNED);
  });

  // Breaks if a per-item validation is dropped or its keyword changes — each
  // one stops a support being claimed against the wrong NDIS item.
  it('validates each cost item against its own expected shape', () => {
    expect(evaluateNewServicePlanIntegration({
      ...base(),
      resolvedProviderTravelValues: { itemName: 'Assistance With Self-Care' },
    })).toEqual({
      integrationMessage: 'Error: The selected Item Number for Provider Travel - Non-Labour Cost is invalid.',
      fallbackColor: '#D99C05',
    });

    expect(evaluateNewServicePlanIntegration({
      ...base(),
      resolvedLabourTravelValues: { itemNumber: '01_011_0107_1_1' },
    })).toEqual({
      integrationMessage: 'Error: The selected Item Number for Provider Travel - Labour Travel Time Costs is invalid.',
      fallbackColor: '#CA56A8',
    });

    expect(evaluateNewServicePlanIntegration({
      ...base(),
      resolvedCancellationValues: { itemNumber: '01_011_0107_1_1' },
    })).toEqual({
      integrationMessage: 'Error: The selected Item Number for Cancellation Costs is invalid.',
      fallbackColor: '#FFA2A2',
    });

    expect(evaluateNewServicePlanIntegration({
      ...base(),
      resolvedActivityBasedTransportValues: { itemName: 'Provider Travel - Non-Labour Cost' },
    })).toEqual({
      integrationMessage: 'Error: The selected Item Number for Activity Based Transport Cost is invalid.',
      fallbackColor: '#FFE197',
    });
  });

  // Breaks if the name check becomes case-sensitive: ISO+ catalogue names are
  // title-cased and the code lowercases before matching.
  it('matches the expected item names case-insensitively', () => {
    expect(evaluateNewServicePlanIntegration({
      ...base(),
      resolvedProviderTravelValues: { itemName: 'PROVIDER TRAVEL - NON-LABOUR COST ITEM' },
      resolvedActivityBasedTransportValues: { itemName: 'ACTIVITY BASED TRANSPORT ITEM' },
    })).toEqual(ALIGNED);
  });

  // Breaks if an unresolved reference starts failing validation: the item is
  // selected but its catalogue row has not been fetched, which is not an error.
  it('skips validation for an item whose reference did not resolve', () => {
    expect(evaluateNewServicePlanIntegration({
      ...base(),
      resolvedProviderTravelValues: null,
      resolvedLabourTravelValues: {},
      resolvedCancellationValues: undefined,
      resolvedActivityBasedTransportValues: { itemName: '' },
    })).toEqual(ALIGNED);
  });
});

const statusAttribute = (labels) => ({
  attribute: { id: 'attr-status', name: 'Configuration Status', settings: { labels } },
});

const GREEN_LABEL = { id: 'label-green', name: 'Aligned and Correct Selection', color: '#388903' };
const AMBER_LABEL = { id: 'label-amber', name: 'Configuration Error', color: '#EE691E' };

describe.each([
  ['legacy', buildLegacyServicePlanVariableUpdates],
  ['new', buildNewServicePlanVariableUpdates],
])('%s service plan variable updates', (_name, buildUpdates) => {
  const attrIds = {
    'Service Plan ID': 'attr-plan-id',
    'Participant Full Name': 'attr-name',
  };

  const args = (overrides = {}) => ({
    getAttributeIdByName: (name) => attrIds[name],
    participantNameValue: 'Samuel Rivers',
    prioritizedItemNumber: '01_011_0107_1_1',
    itemValuesWithAttributeId: [statusAttribute([GREEN_LABEL, AMBER_LABEL])],
    integrationMessage: 'Aligned and Correct Selection',
    fallbackColor: '#388903',
    resolveConfigurationStatusLabelId,
    ...overrides,
  });

  // Breaks on a changed separator in the Service Plan ID, which is the human
  // key users search the board by.
  it('writes the derived plan id, the participant name and the status label', () => {
    expect(buildUpdates(args())).toEqual({
      updateValues: [
        { data: 'Samuel Rivers - 01_011_0107_1_1', attribute_id: 'attr-plan-id' },
        { data: 'Samuel Rivers', attribute_id: 'attr-name' },
        { data: ['label-green'], attribute_id: 'attr-status' },
      ],
      missingStatus: false,
    });
  });

  // Breaks if the plan id is written from a partial pair: "Samuel Rivers - "
  // with no item number is not a usable key.
  it('omits the plan id when either half is missing', () => {
    expect(buildUpdates(args({ prioritizedItemNumber: '' })).updateValues)
      .toEqual([
        { data: 'Samuel Rivers', attribute_id: 'attr-name' },
        { data: ['label-green'], attribute_id: 'attr-status' },
      ]);

    expect(buildUpdates(args({ participantNameValue: '' })).updateValues)
      .toEqual([{ data: ['label-green'], attribute_id: 'attr-status' }]);
  });

  // Breaks if a missing attribute id starts producing an update with
  // `attribute_id: undefined`, which ISO+ rejects for the whole payload.
  it('skips any attribute the board does not have', () => {
    expect(buildUpdates(args({ getAttributeIdByName: () => undefined })).updateValues)
      .toEqual([{ data: ['label-green'], attribute_id: 'attr-status' }]);
  });

  // Breaks if the missingStatus signal goes: the route turns it into a
  // "Configuration Status is required." message instead of writing a partial
  // update.
  it('reports missingStatus and stops before the label when the column is absent', () => {
    expect(buildUpdates(args({ itemValuesWithAttributeId: [] }))).toEqual({
      updateValues: [
        { data: 'Samuel Rivers - 01_011_0107_1_1', attribute_id: 'attr-plan-id' },
        { data: 'Samuel Rivers', attribute_id: 'attr-name' },
      ],
      missingStatus: true,
    });
  });

  // Breaks if the fallback-by-colour path goes: error messages rarely match a
  // configured label name exactly, so the colour is what picks the red/amber
  // label the user sees.
  it('falls back to the label matching the colour when no name matches', () => {
    const result = buildUpdates(args({
      integrationMessage: 'Error: Labour Travel Time is not claimable from the NDIA.',
      fallbackColor: '#EE691E',
    }));

    expect(result.updateValues.at(-1)).toEqual({ data: ['label-amber'], attribute_id: 'attr-status' });
  });

  // Breaks if an unresolvable status silently writes an empty label array.
  it('writes no status update when neither the name nor the colour matches', () => {
    const result = buildUpdates(args({
      integrationMessage: 'Error: something else entirely',
      fallbackColor: '#000000',
    }));

    expect(result).toEqual({
      updateValues: [
        { data: 'Samuel Rivers - 01_011_0107_1_1', attribute_id: 'attr-plan-id' },
        { data: 'Samuel Rivers', attribute_id: 'attr-name' },
      ],
      missingStatus: false,
    });
  });

  // Breaks if either trim moves. Characterizing an asymmetry: the plan id is
  // trimmed only at its ends, so trailing spaces on the name survive inside it,
  // while the Participant Full Name is trimmed in its own right.
  it('trims the name for its own field but only the ends of the plan id', () => {
    const result = buildUpdates(args({ participantNameValue: '  Samuel Rivers  ' }));

    expect(result.updateValues[0].data).toBe('Samuel Rivers   - 01_011_0107_1_1');
    expect(result.updateValues[1].data).toBe('Samuel Rivers');
  });

  it('passes the message and the fallback colour through to the label resolver', () => {
    const resolver = vi.fn(() => 'label-x');
    buildUpdates(args({
      integrationMessage: 'Error: No Item Number Selected',
      fallbackColor: '#C60909',
      resolveConfigurationStatusLabelId: resolver,
    }));

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ attribute: expect.objectContaining({ id: 'attr-status' }) }),
      'Error: No Item Number Selected',
      '#C60909',
    );
  });
});
