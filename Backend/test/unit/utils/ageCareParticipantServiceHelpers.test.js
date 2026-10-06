import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildParticipantNamePrefix,
  createAttributeIdResolver,
  resolveAgeCareServiceCategorySelection,
  appendAgeCarePricingVariableUpdates,
  evaluateAgeCareConfigurationStatus,
  buildAgeCareParticipantServiceUpdates,
  getIsoPlusItemUpdateHeaders,
  resetAgreedUnitPriceFields,
} from '../../../src/utils/ageCareParticipantServiceHelpers.js';

/* Service Category label names, copied byte-for-byte from the resolver map. */
const CATEGORY = {
  HOME_SUPPORT: '🧑‍⚕️ Home Support (HS)',
  AT_SHORT: '🦽 Assistive Technology (AT) - Short-term',
  AT_ONGOING: '🦼 Assistive Technology (AT) - Ongoing',
  HOME_MODIFICATION: '🛠️ Home Modification (HM)',
  AT_HEALTH_PROF: '🩺 AT Health Professional',
  HM_HEALTH_PROF: '🩺 HM Health Professional',
  AT_WRAPAROUND: '📌 AT Wraparound',
  HM_WRAPAROUND: '📌 HM Wraparound',
};

/* Configuration Status colours the evaluator can select. */
const COLOR = {
  RED: '#C60909',
  ORANGE: '#EE691E',
  PINK: '#CA56A8',
  BLUE: '#3578D1',
  AMBER: '#D99C05',
  GREEN: '#388903',
};

/** A participant profile as produced by fetchAgeCareParticipantsServicePlanReferencedItems. */
const profile = (overrides = {}) => ({
  id: 'pp-1',
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane.doe@example.com',
  phone: '0400 000 000',
  address: '1 Test St',
  suburb: 'Testville',
  state: 'NSW',
  postcode: '2000',
  billingContact: 'John Doe',
  billingAddress: '1 Test St',
  ...overrides,
});

/** A service-catalog reference (Home Support / AT / HM / Health Professional). */
const catalog = (overrides = {}) => ({
  id: 'svc-1',
  service: 'Domestic Assistance',
  serviceType: 'Direct',
  unit: 'Per Hour',
  unitPrice: '25.50',
  participantContributionGuideline: '17.5 - 20',
  wraparound: 'Applicable',
  serviceIDItemID: 'HS_DOM_01 / IT_HS_001',
  itemID: 'IT_HS_001',
  item: 'Domestic Assistance',
  ...overrides,
});

/** A Wraparound reference item. */
const wraparound = (overrides = {}) => ({
  id: 'wr-1',
  itemID: 'IT_WR_001',
  wraparoundDescription: 'AT Delivery Fee',
  unit: 'Each',
  unitPrice: '15.00',
  participantContributionGuideline: '0',
  ...overrides,
});

describe('buildParticipantNamePrefix', () => {
  it('returns an empty string when there is no profile', () => {
    expect(buildParticipantNamePrefix(null)).toBe('');
    expect(buildParticipantNamePrefix(undefined)).toBe('');
  });

  it('prefers the full name and appends the " - " separator', () => {
    expect(buildParticipantNamePrefix(profile())).toBe('Jane Doe - ');
  });

  it('falls back to first + last name when the full name is blank', () => {
    expect(buildParticipantNamePrefix(profile({ fullName: '' }))).toBe('Jane Doe - ');
  });

  it('falls back to first + last name when the full name is null', () => {
    expect(buildParticipantNamePrefix(profile({ fullName: null }))).toBe('Jane Doe - ');
  });

  it('uses the last name alone when there is no first name', () => {
    expect(buildParticipantNamePrefix(profile({ fullName: '', firstName: '' }))).toBe('Doe - ');
  });

  it('uses the first name alone when there is no last name', () => {
    expect(buildParticipantNamePrefix(profile({ fullName: '', lastName: '' }))).toBe('Jane - ');
  });

  it('returns an empty string when every name field is blank', () => {
    expect(buildParticipantNamePrefix(profile({ fullName: '', firstName: '', lastName: '' }))).toBe('');
  });
});

describe('createAttributeIdResolver', () => {
  const values = [
    { data: 'x', attribute: { id: 'attr-1', name: 'Service Plan ID' } },
    { data: 0, attribute: { id: 'attr-2', name: 'Agreed Unit Price ($)' } },
  ];

  it('resolves an attribute id by exact name', () => {
    const resolve = createAttributeIdResolver(values);
    expect(resolve('Service Plan ID')).toBe('attr-1');
    expect(resolve('Agreed Unit Price ($)')).toBe('attr-2');
  });

  it('returns undefined for an unknown name', () => {
    expect(createAttributeIdResolver(values)('No Such Attribute')).toBeUndefined();
  });

  it('does not match on a name prefix', () => {
    expect(createAttributeIdResolver(values)('Service Plan')).toBeUndefined();
  });

  it('tolerates entries with no attribute object', () => {
    const resolve = createAttributeIdResolver([{ data: 'x' }, ...values]);
    expect(resolve('Service Plan ID')).toBe('attr-1');
  });

  it('returns undefined for an empty value list', () => {
    expect(createAttributeIdResolver([])('Service Plan ID')).toBeUndefined();
  });
});

describe('resolveAgeCareServiceCategorySelection', () => {
  const fullName = 'Jane Doe - ';

  it('returns no selection for an unrecognised category', () => {
    expect(resolveAgeCareServiceCategorySelection('Something Else', { fullName, homeSupportValues: catalog() }))
      .toEqual({ selectedMainService: null, servicePlanIdValue: '' });
  });

  it('returns no selection for an empty category name', () => {
    expect(resolveAgeCareServiceCategorySelection('', { fullName }))
      .toEqual({ selectedMainService: null, servicePlanIdValue: '' });
  });

  it('builds the Home Support service plan id from name + service', () => {
    const homeSupportValues = catalog();
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.HOME_SUPPORT, { fullName, homeSupportValues }))
      .toEqual({ selectedMainService: homeSupportValues, servicePlanIdValue: 'Jane Doe - Domestic Assistance' });
  });

  it('ignores the wraparound description for Home Support', () => {
    const homeSupportValues = catalog();
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.HOME_SUPPORT, {
      fullName,
      homeSupportValues,
      wraparoundValues: wraparound(),
    }).servicePlanIdValue).toBe('Jane Doe - Domestic Assistance');
  });

  it('returns no selection for Home Support with nothing referenced', () => {
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.HOME_SUPPORT, { fullName, homeSupportValues: null }))
      .toEqual({ selectedMainService: null, servicePlanIdValue: '' });
  });

  it('builds the AT Short-term id from name + service when there is no wraparound', () => {
    const assistiveTechnologyShortTermValues = catalog({ service: 'Shower Chair' });
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.AT_SHORT, { fullName, assistiveTechnologyShortTermValues }))
      .toEqual({ selectedMainService: assistiveTechnologyShortTermValues, servicePlanIdValue: 'Jane Doe - Shower Chair' });
  });

  it('inserts "<wraparound> for <service>" when a wraparound is referenced', () => {
    const assistiveTechnologyShortTermValues = catalog({ service: 'Shower Chair' });
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.AT_SHORT, {
      fullName,
      assistiveTechnologyShortTermValues,
      wraparoundValues: wraparound(),
    }).servicePlanIdValue).toBe('Jane Doe - AT Delivery Fee for Shower Chair');
  });

  it('handles AT Ongoing, Home Modification and both Health Professional categories', () => {
    const assistiveTechnologyOngoingValues = catalog({ service: 'Walker' });
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.AT_ONGOING, { fullName, assistiveTechnologyOngoingValues }))
      .toEqual({ selectedMainService: assistiveTechnologyOngoingValues, servicePlanIdValue: 'Jane Doe - Walker' });

    const homeModificationValues = catalog({ service: 'Grab Rails' });
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.HOME_MODIFICATION, { fullName, homeModificationValues }))
      .toEqual({ selectedMainService: homeModificationValues, servicePlanIdValue: 'Jane Doe - Grab Rails' });

    const healthProfessionalValues = catalog({ service: 'OT Assessment' });
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.AT_HEALTH_PROF, { fullName, healthProfessionalValues }))
      .toEqual({ selectedMainService: healthProfessionalValues, servicePlanIdValue: 'Jane Doe - OT Assessment' });
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.HM_HEALTH_PROF, { fullName, healthProfessionalValues }))
      .toEqual({ selectedMainService: healthProfessionalValues, servicePlanIdValue: 'Jane Doe - OT Assessment' });
  });

  it('returns no selection when the matching reference is missing for each category', () => {
    for (const name of [CATEGORY.AT_SHORT, CATEGORY.AT_ONGOING, CATEGORY.HOME_MODIFICATION, CATEGORY.AT_HEALTH_PROF, CATEGORY.HM_HEALTH_PROF]) {
      expect(resolveAgeCareServiceCategorySelection(name, { fullName })).toEqual({
        selectedMainService: null,
        servicePlanIdValue: '',
      });
    }
  });

  it('pairs a wraparound category with the first companion service in priority order', () => {
    const assistiveTechnologyOngoingValues = catalog({ service: 'Walker' });
    const homeModificationValues = catalog({ service: 'Grab Rails' });

    expect(resolveAgeCareServiceCategorySelection(CATEGORY.AT_WRAPAROUND, {
      fullName,
      assistiveTechnologyOngoingValues,
      homeModificationValues,
      wraparoundValues: wraparound(),
    })).toEqual({
      selectedMainService: assistiveTechnologyOngoingValues,
      servicePlanIdValue: 'Jane Doe - AT Delivery Fee for Walker',
    });
  });

  it('omits the "for <service>" suffix when only Home Support accompanies the wraparound', () => {
    const homeSupportValues = catalog();
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.HM_WRAPAROUND, {
      fullName,
      homeSupportValues,
      wraparoundValues: wraparound({ wraparoundDescription: 'HM Travel' }),
    })).toEqual({
      selectedMainService: homeSupportValues,
      servicePlanIdValue: 'Jane Doe - HM Travel',
    });
  });

  it('returns the selected service but no id when the wraparound has no description', () => {
    const homeModificationValues = catalog({ service: 'Grab Rails' });
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.AT_WRAPAROUND, {
      fullName,
      homeModificationValues,
      wraparoundValues: wraparound({ wraparoundDescription: '' }),
    })).toEqual({ selectedMainService: homeModificationValues, servicePlanIdValue: '' });
  });

  it('returns nothing selected for a wraparound category with no references at all', () => {
    expect(resolveAgeCareServiceCategorySelection(CATEGORY.AT_WRAPAROUND, { fullName }))
      .toEqual({ selectedMainService: null, servicePlanIdValue: '' });
  });
});

describe('appendAgeCarePricingVariableUpdates', () => {
  const attributeIds = {
    unitAttributeId: 'attr-unit',
    agreedUnitPriceAttributeId: 'attr-price',
    participantContributionAttributeId: 'attr-pct',
  };

  it('copies unit, price and contribution percentage from the main service', () => {
    const updates = [];
    appendAgeCarePricingVariableUpdates(updates, {
      ...attributeIds,
      wraparoundValues: null,
      homeSupportValues: catalog(),
      selectedMainService: catalog(),
    });

    expect(updates).toEqual([
      { data: 'Per Hour', attribute_id: 'attr-unit' },
      { data: 25.5, attribute_id: 'attr-price' },
      { data: 17.5, attribute_id: 'attr-pct' },
    ]);
  });

  it('takes the leading number of a "min - max" guideline range', () => {
    const updates = [];
    appendAgeCarePricingVariableUpdates(updates, {
      ...attributeIds,
      wraparoundValues: null,
      selectedMainService: catalog({ participantContributionGuideline: '5-95' }),
    });
    expect(updates[2]).toEqual({ data: 5, attribute_id: 'attr-pct' });
  });

  it('treats a blank or unparseable guideline as 0%', () => {
    for (const guideline of ['', null, undefined, 'N/A', 'no charge']) {
      const updates = [];
      appendAgeCarePricingVariableUpdates(updates, {
        ...attributeIds,
        wraparoundValues: null,
        selectedMainService: catalog({ participantContributionGuideline: guideline }),
      });
      expect(updates[2]).toEqual({ data: 0, attribute_id: 'attr-pct' });
    }
  });

  it('prefers the wraparound pricing over the main service when a wraparound is selected', () => {
    const updates = [];
    appendAgeCarePricingVariableUpdates(updates, {
      ...attributeIds,
      wraparoundValues: wraparound(),
      homeSupportValues: null,
      selectedMainService: catalog({ service: 'Shower Chair' }),
    });

    expect(updates).toEqual([
      { data: 'Each', attribute_id: 'attr-unit' },
      { data: 15, attribute_id: 'attr-price' },
      { data: 0, attribute_id: 'attr-pct' },
    ]);
  });

  it('zeroes the pricing when a wraparound is paired with Home Support', () => {
    const updates = [];
    appendAgeCarePricingVariableUpdates(updates, {
      ...attributeIds,
      wraparoundValues: wraparound(),
      homeSupportValues: catalog(),
      selectedMainService: catalog(),
    });

    expect(updates).toEqual([
      { data: '0', attribute_id: 'attr-unit' },
      { data: 0, attribute_id: 'attr-price' },
      { data: 0, attribute_id: 'attr-pct' },
    ]);
  });

  it('zeroes the pricing when the main service says wraparound is not applicable', () => {
    for (const wraparoundText of ['Not Applicable', 'NOT APPLICABLE for this service', 'N/A']) {
      const updates = [];
      appendAgeCarePricingVariableUpdates(updates, {
        ...attributeIds,
        wraparoundValues: wraparound(),
        homeSupportValues: null,
        selectedMainService: catalog({ wraparound: wraparoundText }),
      });
      expect(updates).toEqual([
        { data: '0', attribute_id: 'attr-unit' },
        { data: 0, attribute_id: 'attr-price' },
        { data: 0, attribute_id: 'attr-pct' },
      ]);
    }
  });

  it('keeps the wraparound pricing when the main service permits wraparound', () => {
    const updates = [];
    appendAgeCarePricingVariableUpdates(updates, {
      ...attributeIds,
      wraparoundValues: wraparound(),
      homeSupportValues: null,
      selectedMainService: catalog({ wraparound: 'Applicable' }),
    });
    expect(updates[1]).toEqual({ data: 15, attribute_id: 'attr-price' });
  });

  it('pushes nothing when neither a wraparound nor a main service is selected', () => {
    const updates = [];
    appendAgeCarePricingVariableUpdates(updates, {
      ...attributeIds,
      wraparoundValues: null,
      homeSupportValues: null,
      selectedMainService: null,
    });
    expect(updates).toEqual([]);
  });

  it('skips the unit when the pricing source has none', () => {
    const updates = [];
    appendAgeCarePricingVariableUpdates(updates, {
      ...attributeIds,
      wraparoundValues: null,
      selectedMainService: catalog({ unit: null }),
    });
    expect(updates).toEqual([
      { data: 25.5, attribute_id: 'attr-price' },
      { data: 17.5, attribute_id: 'attr-pct' },
    ]);
  });

  it('skips the price when it is missing or negative, keeping unit and percentage', () => {
    for (const unitPrice of [undefined, 'not a price', '-5']) {
      const updates = [];
      appendAgeCarePricingVariableUpdates(updates, {
        ...attributeIds,
        wraparoundValues: null,
        selectedMainService: catalog({ unitPrice }),
      });
      expect(updates).toEqual([
        { data: 'Per Hour', attribute_id: 'attr-unit' },
        { data: 17.5, attribute_id: 'attr-pct' },
      ]);
    }
  });

  it('writes a zero price rather than dropping it', () => {
    const updates = [];
    appendAgeCarePricingVariableUpdates(updates, {
      ...attributeIds,
      wraparoundValues: null,
      selectedMainService: catalog({ unitPrice: '0' }),
    });
    expect(updates[1]).toEqual({ data: 0, attribute_id: 'attr-price' });
  });

  it('writes only the attributes the board exposes', () => {
    const updates = [];
    appendAgeCarePricingVariableUpdates(updates, {
      unitAttributeId: undefined,
      agreedUnitPriceAttributeId: 'attr-price',
      participantContributionAttributeId: undefined,
      wraparoundValues: null,
      selectedMainService: catalog(),
    });
    expect(updates).toEqual([{ data: 25.5, attribute_id: 'attr-price' }]);
  });

  it('appends to an existing update list', () => {
    const updates = [{ data: 'Jane Doe - Domestic Assistance', attribute_id: 'attr-service-plan-id' }];
    appendAgeCarePricingVariableUpdates(updates, {
      ...attributeIds,
      wraparoundValues: null,
      selectedMainService: catalog(),
    });
    expect(updates).toHaveLength(4);
    expect(updates[0]).toEqual({ data: 'Jane Doe - Domestic Assistance', attribute_id: 'attr-service-plan-id' });
  });
});

describe('evaluateAgeCareConfigurationStatus', () => {
  const evaluate = (overrides) => evaluateAgeCareConfigurationStatus({
    itemsValues: {},
    categoryLabelName: '',
    wraparoundCategoryLabelName: '',
    homeSupportValues: null,
    assistiveTechnologyShortTermValues: null,
    assistiveTechnologyOngoingValues: null,
    homeModificationValues: null,
    healthProfessionalValues: null,
    wraparoundValues: null,
    ...overrides,
  });

  it('reports a misaligned category when a category is set but nothing is selected', () => {
    expect(evaluate({ categoryLabelName: CATEGORY.HOME_SUPPORT })).toEqual({
      statusColor: COLOR.RED,
      integrationMsg: 'Error: Misalignment of Service Category. The selected service does not match the assigned service category.',
    });
  });

  it('returns a blank status when neither a category nor a service is set', () => {
    expect(evaluate({})).toEqual({ statusColor: '', integrationMsg: '' });
  });

  it('reports multiple services in a group before anything else', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.HOME_SUPPORT,
      itemsValues: { 'Home Support (HS)': ['hs-1', 'hs-2'] },
      homeSupportValues: catalog(),
    })).toEqual({
      statusColor: COLOR.ORANGE,
      integrationMsg: 'Error: Multiple Services within a Group. Please select only one service in each group.',
    });
  });

  it('reports multiple wraparound items as multiple services in a group', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.AT_SHORT,
      itemsValues: {
        'Assistive Technology (AT) - Short Term': ['at-1'],
        Wraparound: ['wr-1', 'wr-2'],
      },
      assistiveTechnologyShortTermValues: catalog(),
      wraparoundValues: wraparound(),
    }).statusColor).toBe(COLOR.ORANGE);
  });

  it('reports multiple service groups', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.HOME_SUPPORT,
      itemsValues: {
        'Home Support (HS)': ['hs-1'],
        'Home Modification (HM)': ['hm-1'],
      },
      homeSupportValues: catalog(),
      homeModificationValues: catalog({ service: 'Grab Rails' }),
    })).toEqual({
      statusColor: COLOR.ORANGE,
      integrationMsg: 'Error: Multiple Service Groups. Please select only one service group (Wraparound can be combined with other categories except Home Support).',
    });
  });

  it('rejects a standalone wraparound', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.AT_WRAPAROUND,
      wraparoundCategoryLabelName: CATEGORY.AT_WRAPAROUND,
      itemsValues: { Wraparound: ['wr-1'] },
      wraparoundValues: wraparound(),
    })).toEqual({
      statusColor: COLOR.PINK,
      integrationMsg: 'Error: Wraparound cannot be chosen as a Standalone Service. Please select a service category (except Home Support).',
    });
  });

  it('rejects a wraparound combined with Home Support', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.HOME_SUPPORT,
      wraparoundCategoryLabelName: CATEGORY.AT_WRAPAROUND,
      itemsValues: { 'Home Support (HS)': ['hs-1'], Wraparound: ['wr-1'] },
      homeSupportValues: catalog(),
      wraparoundValues: wraparound(),
    })).toEqual({
      statusColor: COLOR.BLUE,
      integrationMsg: 'Error: Wraparound is NOT Applicable. The selected service does not support Wraparound according to Aged Care Pricing guidelines.',
    });
  });

  it('rejects a wraparound on a service marked "Not Applicable"', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.AT_SHORT,
      wraparoundCategoryLabelName: CATEGORY.AT_WRAPAROUND,
      itemsValues: { 'Assistive Technology (AT) - Short Term': ['at-1'], Wraparound: ['wr-1'] },
      assistiveTechnologyShortTermValues: catalog({ wraparound: 'Not Applicable' }),
      wraparoundValues: wraparound(),
    })).toEqual({
      statusColor: COLOR.BLUE,
      integrationMsg: 'Error: Wraparound is NOT Applicable. The selected service does not support Wraparound according to Aged Care Pricing guidelines.',
    });
  });

  it('rejects a wraparound on a service marked "N/A"', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.AT_SHORT,
      wraparoundCategoryLabelName: CATEGORY.AT_WRAPAROUND,
      itemsValues: { 'Assistive Technology (AT) - Short Term': ['at-1'], Wraparound: ['wr-1'] },
      assistiveTechnologyShortTermValues: catalog({ wraparound: 'n/a' }),
      wraparoundValues: wraparound(),
    }).statusColor).toBe(COLOR.BLUE);
  });

  it('flags a wraparound category whose prefix differs from the selected service group', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.AT_SHORT,
      wraparoundCategoryLabelName: CATEGORY.HM_WRAPAROUND,
      itemsValues: { 'Assistive Technology (AT) - Short Term': ['at-1'], Wraparound: ['wr-1'] },
      assistiveTechnologyShortTermValues: catalog(),
      wraparoundValues: wraparound(),
    })).toEqual({
      statusColor: COLOR.AMBER,
      integrationMsg: 'Error: Misalignment of Wraparound Category. The starting letters of the selected Wraparound do not match the Wraparound Category.',
    });
  });

  it('flags a wraparound description whose prefix differs from the wraparound category', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.AT_SHORT,
      wraparoundCategoryLabelName: CATEGORY.AT_WRAPAROUND,
      itemsValues: { 'Assistive Technology (AT) - Short Term': ['at-1'], Wraparound: ['wr-1'] },
      assistiveTechnologyShortTermValues: catalog(),
      wraparoundValues: wraparound({ wraparoundDescription: 'HM Travel Fee' }),
    }).statusColor).toBe(COLOR.AMBER);
  });

  it('reads "AT" ahead of "HM" when the wraparound description mentions both', () => {
    // Category and service group both say HM; the description mentions AT, which wins the prefix.
    expect(evaluate({
      categoryLabelName: CATEGORY.HOME_MODIFICATION,
      wraparoundCategoryLabelName: CATEGORY.HM_WRAPAROUND,
      itemsValues: { 'Home Modification (HM)': ['hm-1'], Wraparound: ['wr-1'] },
      homeModificationValues: catalog({ service: 'Grab Rails' }),
      wraparoundValues: wraparound({ wraparoundDescription: 'HM Install with AT parts' }),
    })).toEqual({
      statusColor: COLOR.AMBER,
      integrationMsg: 'Error: Misalignment of Wraparound Category. The starting letters of the selected Wraparound do not match the Wraparound Category.',
    });
  });

  it('accepts a wraparound whose category, service group and description all agree', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.AT_SHORT,
      wraparoundCategoryLabelName: CATEGORY.AT_WRAPAROUND,
      itemsValues: { 'Assistive Technology (AT) - Short Term': ['at-1'], Wraparound: ['wr-1'] },
      assistiveTechnologyShortTermValues: catalog(),
      wraparoundValues: wraparound(),
    })).toEqual({ statusColor: COLOR.GREEN, integrationMsg: 'Aligned and Correct Selection.' });
  });

  it('infers the HM prefix from the selected items when the category is a wraparound category', () => {
    // categoryLabelName is a Wraparound label, so the prefix is inferred from the HM count.
    expect(evaluate({
      categoryLabelName: CATEGORY.AT_WRAPAROUND,
      wraparoundCategoryLabelName: CATEGORY.AT_WRAPAROUND,
      itemsValues: { 'Home Modification (HM)': ['hm-1'], Wraparound: ['wr-1'] },
      homeModificationValues: catalog({ service: 'Grab Rails' }),
      wraparoundValues: wraparound(),
    }).statusColor).toBe(COLOR.AMBER);
  });

  it('reports a misaligned category when the single selected group is the wrong one', () => {
    expect(evaluate({
      categoryLabelName: CATEGORY.HOME_SUPPORT,
      itemsValues: { 'Home Modification (HM)': ['hm-1'] },
      homeModificationValues: catalog({ service: 'Grab Rails' }),
    })).toEqual({
      statusColor: COLOR.RED,
      integrationMsg: 'Error: Misalignment of Service Category. The selected service does not match the assigned service category.',
    });
  });

  it('accepts each category paired with its matching service group', () => {
    const pairs = [
      [CATEGORY.HOME_SUPPORT, 'Home Support (HS)'],
      [CATEGORY.AT_SHORT, 'Assistive Technology (AT) - Short Term'],
      [CATEGORY.AT_ONGOING, 'Assistive Technology (AT) - Ongoing'],
      [CATEGORY.HOME_MODIFICATION, 'Home Modification (HM)'],
      [CATEGORY.AT_HEALTH_PROF, 'Health Professional'],
    ];
    for (const [categoryLabelName, itemsKey] of pairs) {
      expect(evaluate({ categoryLabelName, itemsValues: { [itemsKey]: ['id-1'] } }))
        .toEqual({ statusColor: COLOR.GREEN, integrationMsg: 'Aligned and Correct Selection.' });
    }
  });

  it('accepts any single group when the category is a wraparound category', () => {
    // expectedKey === 'wraparound' short-circuits the single-group alignment check.
    expect(evaluate({
      categoryLabelName: CATEGORY.HM_WRAPAROUND,
      itemsValues: { 'Assistive Technology (AT) - Short Term': ['at-1'] },
      assistiveTechnologyShortTermValues: catalog(),
    })).toEqual({ statusColor: COLOR.GREEN, integrationMsg: 'Aligned and Correct Selection.' });
  });

  it('accepts a selection with no configured category', () => {
    expect(evaluate({
      categoryLabelName: '',
      itemsValues: { 'Home Support (HS)': ['hs-1'] },
      homeSupportValues: catalog(),
    })).toEqual({ statusColor: COLOR.GREEN, integrationMsg: 'Aligned and Correct Selection.' });
  });
});

describe('buildAgeCareParticipantServiceUpdates', () => {
  const labelAttribute = (id, name, labels, data) => ({
    data,
    attribute: { id, name, type: 'label', settings: { labels } },
  });

  const plainAttribute = (id, name, data = '') => ({
    data,
    attribute: { id, name, type: 'text', settings: {} },
  });

  const STATUS_LABELS = [
    { id: 'label-red', name: 'Category Misalignment', color: COLOR.RED },
    { id: 'label-orange', name: 'Multiple Selection', color: COLOR.ORANGE },
    { id: 'label-pink', name: 'Standalone Wraparound', color: COLOR.PINK },
    { id: 'label-blue', name: 'Wraparound Not Applicable', color: COLOR.BLUE },
    { id: 'label-amber', name: 'Wraparound Misalignment', color: COLOR.AMBER },
    { id: 'label-green', name: 'Aligned', color: COLOR.GREEN },
  ];

  const CATEGORY_LABELS = [
    { id: 'cat-hs', name: CATEGORY.HOME_SUPPORT, color: '#111111' },
    { id: 'cat-at-short', name: CATEGORY.AT_SHORT, color: '#222222' },
    { id: 'cat-hm', name: CATEGORY.HOME_MODIFICATION, color: '#333333' },
  ];

  const WRAPAROUND_CATEGORY_LABELS = [
    { id: 'wcat-at', name: CATEGORY.AT_WRAPAROUND, color: '#444444' },
    { id: 'wcat-hm', name: CATEGORY.HM_WRAPAROUND, color: '#555555' },
  ];

  const itemValues = ({ categoryData = ['cat-hs'], wraparoundCategoryData = null, includeStatus = true, extra = [] } = {}) => {
    const values = [
      plainAttribute('attr-service-plan-id', 'Service Plan ID'),
      labelAttribute('attr-service-category', 'Service Category', CATEGORY_LABELS, categoryData),
      plainAttribute('attr-unit', 'Unit'),
      plainAttribute('attr-price', 'Agreed Unit Price ($)', 0),
      plainAttribute('attr-pct', 'Participant Contribution (%)', 0),
      ...extra,
    ];
    if (wraparoundCategoryData !== null) {
      values.push(labelAttribute('attr-wraparound-category', 'Wraparound Category', WRAPAROUND_CATEGORY_LABELS, wraparoundCategoryData));
    }
    if (includeStatus) {
      values.push(labelAttribute('attr-config-status', 'Configuration Status', STATUS_LABELS, []));
    }
    return values;
  };

  /** referencedItems is the positional tuple fetchAgeCareParticipantsServicePlanReferencedItems returns. */
  const refs = ({
    participantsProfileValues = profile(),
    homeSupportValues = null,
    assistiveTechnologyShortTermValues = null,
    assistiveTechnologyOngoingValues = null,
    homeModificationValues = null,
    healthProfessionalValues = null,
    wraparoundValues = null,
  } = {}) => [
    participantsProfileValues,
    homeSupportValues,
    assistiveTechnologyShortTermValues,
    assistiveTechnologyOngoingValues,
    homeModificationValues,
    healthProfessionalValues,
    wraparoundValues,
  ];

  it('builds the service plan id, pricing and a green status for an aligned Home Support plan', () => {
    const result = buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: itemValues(),
      itemsValues: { 'Home Support (HS)': ['hs-1'] },
      referencedItems: refs({ homeSupportValues: catalog() }),
    });

    expect(result).toEqual({
      updatevariables: [
        { data: 'Jane Doe - Domestic Assistance', attribute_id: 'attr-service-plan-id' },
        { data: 'Per Hour', attribute_id: 'attr-unit' },
        { data: 25.5, attribute_id: 'attr-price' },
        { data: 17.5, attribute_id: 'attr-pct' },
        { data: ['label-green'], attribute_id: 'attr-config-status' },
      ],
      integrationMsg: 'Aligned and Correct Selection.',
      earlyError: null,
    });
  });

  it('resolves the category label from a scalar label id as well as an array', () => {
    const result = buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: itemValues({ categoryData: 'cat-hs' }),
      itemsValues: { 'Home Support (HS)': ['hs-1'] },
      referencedItems: refs({ homeSupportValues: catalog() }),
    });

    expect(result.updatevariables[0]).toEqual({
      data: 'Jane Doe - Domestic Assistance',
      attribute_id: 'attr-service-plan-id',
    });
  });

  it('writes the red misalignment label when the wrong group is selected', () => {
    const result = buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: itemValues(),
      itemsValues: { 'Home Modification (HM)': ['hm-1'] },
      referencedItems: refs({ homeModificationValues: catalog({ service: 'Grab Rails' }) }),
    });

    expect(result.integrationMsg).toBe('Error: Misalignment of Service Category. The selected service does not match the assigned service category.');
    expect(result.updatevariables).toContainEqual({ data: ['label-red'], attribute_id: 'attr-config-status' });
    // No Home Support reference, so no service plan id was produced for the HS category.
    expect(result.updatevariables.some((u) => u.attribute_id === 'attr-service-plan-id')).toBe(false);
  });

  it('uses the Wraparound Category attribute when present', () => {
    const result = buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: itemValues({ categoryData: ['cat-at-short'], wraparoundCategoryData: ['wcat-hm'] }),
      itemsValues: { 'Assistive Technology (AT) - Short Term': ['at-1'], Wraparound: ['wr-1'] },
      referencedItems: refs({
        assistiveTechnologyShortTermValues: catalog({ service: 'Shower Chair' }),
        wraparoundValues: wraparound(),
      }),
    });

    expect(result.integrationMsg).toBe('Error: Misalignment of Wraparound Category. The starting letters of the selected Wraparound do not match the Wraparound Category.');
    expect(result.updatevariables).toEqual([
      { data: 'Jane Doe - AT Delivery Fee for Shower Chair', attribute_id: 'attr-service-plan-id' },
      { data: 'Each', attribute_id: 'attr-unit' },
      { data: 15, attribute_id: 'attr-price' },
      { data: 0, attribute_id: 'attr-pct' },
      { data: ['label-amber'], attribute_id: 'attr-config-status' },
    ]);
  });

  it('returns an early error when the board has no Configuration Status attribute', () => {
    const result = buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: itemValues({ includeStatus: false }),
      itemsValues: { 'Home Support (HS)': ['hs-1'] },
      referencedItems: refs({ homeSupportValues: catalog() }),
    });

    expect(result.earlyError).toBe('Configuration Status is required.');
    expect(result.integrationMsg).toBe('Configuration Status is required.');
    // The variables computed before the guard are still returned.
    expect(result.updatevariables).toEqual([
      { data: 'Jane Doe - Domestic Assistance', attribute_id: 'attr-service-plan-id' },
      { data: 'Per Hour', attribute_id: 'attr-unit' },
      { data: 25.5, attribute_id: 'attr-price' },
      { data: 17.5, attribute_id: 'attr-pct' },
    ]);
  });

  it('omits the service plan id when the board has no Service Plan ID attribute', () => {
    const values = itemValues().filter((v) => v.attribute.name !== 'Service Plan ID');
    const result = buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: values,
      itemsValues: { 'Home Support (HS)': ['hs-1'] },
      referencedItems: refs({ homeSupportValues: catalog() }),
    });

    expect(result.updatevariables.some((u) => u.attribute_id === 'attr-service-plan-id')).toBe(false);
    expect(result.updatevariables[0]).toEqual({ data: 'Per Hour', attribute_id: 'attr-unit' });
  });

  it('produces no updates at all when no category is set and nothing is referenced', () => {
    const result = buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: itemValues({ categoryData: [] }),
      itemsValues: {},
      referencedItems: refs({ participantsProfileValues: null }),
    });

    expect(result).toEqual({ updatevariables: [], integrationMsg: '', earlyError: null });
  });

  it('writes an empty label id when no status label carries the computed colour', () => {
    const values = itemValues().map((v) => (
      v.attribute.name === 'Configuration Status'
        ? { data: [], attribute: { ...v.attribute, settings: { labels: [{ id: 'label-other', name: 'Other', color: '#000000' }] } } }
        : v
    ));

    const result = buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: values,
      itemsValues: { 'Home Support (HS)': ['hs-1'] },
      referencedItems: refs({ homeSupportValues: catalog() }),
    });

    expect(result.updatevariables).toContainEqual({ data: [''], attribute_id: 'attr-config-status' });
  });

  it('falls back to an empty prefix when there is no participant profile', () => {
    const result = buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: itemValues(),
      itemsValues: { 'Home Support (HS)': ['hs-1'] },
      referencedItems: refs({ participantsProfileValues: null, homeSupportValues: catalog() }),
    });

    expect(result.updatevariables[0]).toEqual({ data: 'Domestic Assistance', attribute_id: 'attr-service-plan-id' });
  });

  it('does not mutate the referenced items or the item values it is given', () => {
    const values = itemValues();
    const snapshot = JSON.parse(JSON.stringify(values));
    const homeSupportValues = catalog();
    const refsSnapshot = JSON.parse(JSON.stringify(homeSupportValues));

    buildAgeCareParticipantServiceUpdates({
      itemValuesWithAttributeId: values,
      itemsValues: { 'Home Support (HS)': ['hs-1'] },
      referencedItems: refs({ homeSupportValues }),
    });

    expect(values).toEqual(snapshot);
    expect(homeSupportValues).toEqual(refsSnapshot);
  });
});

describe('getIsoPlusItemUpdateHeaders', () => {
  const originalToken = process.env.PERSONAL_ACCESS_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.PERSONAL_ACCESS_TOKEN;
    else process.env.PERSONAL_ACCESS_TOKEN = originalToken;
  });

  it('bearer-authorizes with the current PERSONAL_ACCESS_TOKEN', () => {
    process.env.PERSONAL_ACCESS_TOKEN = 'pat-abc-123';
    expect(getIsoPlusItemUpdateHeaders().Authorization).toBe('Bearer pat-abc-123');
  });

  it('reads the token at call time, not at module load', () => {
    process.env.PERSONAL_ACCESS_TOKEN = 'first-token';
    expect(getIsoPlusItemUpdateHeaders().Authorization).toBe('Bearer first-token');
    process.env.PERSONAL_ACCESS_TOKEN = 'second-token';
    expect(getIsoPlusItemUpdateHeaders().Authorization).toBe('Bearer second-token');
  });

  it('pins the JSON content type and the ISO+ API version', () => {
    process.env.PERSONAL_ACCESS_TOKEN = 'pat-abc-123';
    const headers = getIsoPlusItemUpdateHeaders();
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe('application/json');
    expect(headers['X-API-Version']).toBe('2025-02-26.morava');
  });
});

describe('resetAgreedUnitPriceFields', () => {
  const itemValuesWithAttributeId = [
    { data: 'x', attribute: { id: 'attr-service-plan-id', name: 'Service Plan ID' } },
    { data: 25.5, attribute: { id: 'attr-price', name: 'Agreed Unit Price ($)' } },
    { data: 17.5, attribute: { id: 'attr-pct', name: 'Participant Contribution (%)' } },
  ];

  let axios;
  const originalToken = process.env.PERSONAL_ACCESS_TOKEN;

  beforeEach(() => {
    axios = { put: vi.fn().mockResolvedValue({ status: 200, data: {} }) };
    process.env.PERSONAL_ACCESS_TOKEN = 'pat-abc-123';
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.PERSONAL_ACCESS_TOKEN;
    else process.env.PERSONAL_ACCESS_TOKEN = originalToken;
  });

  it('PUTs zeroes for the price and contribution attributes to the item url', async () => {
    await resetAgreedUnitPriceFields(axios, 'ws-1', 'board-2', 'item-3', itemValuesWithAttributeId);

    expect(axios.put).toHaveBeenCalledTimes(1);
    const [url, body, config] = axios.put.mock.calls[0];
    expect(url).toBe('https://app.isoplus.online/api/v2/workspaces/ws-1/boards/board-2/items/item-3');
    expect(body).toEqual({
      values: [
        { data: 0, attribute_id: 'attr-price' },
        { data: 0, attribute_id: 'attr-pct' },
      ],
    });
    expect(config.headers.Authorization).toBe('Bearer pat-abc-123');
    expect(config.headers['X-API-Version']).toBe('2025-02-26.morava');
  });

  it('url-encodes path segments that need it', async () => {
    await resetAgreedUnitPriceFields(axios, 'ws 1', 'board#2', 'item-3', itemValuesWithAttributeId);

    expect(axios.put.mock.calls[0][0])
      .toBe('https://app.isoplus.online/api/v2/workspaces/ws%201/boards/board%232/items/item-3');
  });

  it('rejects a path-traversal id without issuing a request', async () => {
    await expect(resetAgreedUnitPriceFields(axios, '../admin', 'board-2', 'item-3', itemValuesWithAttributeId))
      .rejects.toThrow('Invalid workspaceId: path traversal sequences are not allowed.');
    expect(axios.put).not.toHaveBeenCalled();
  });

  it('rejects a missing item id without issuing a request', async () => {
    await expect(resetAgreedUnitPriceFields(axios, 'ws-1', 'board-2', '', itemValuesWithAttributeId))
      .rejects.toThrow('Invalid itemId: expected a non-empty string.');
    expect(axios.put).not.toHaveBeenCalled();
  });

  it('throws when the board has no Agreed Unit Price attribute', async () => {
    const withoutPrice = itemValuesWithAttributeId.filter((v) => v.attribute.name !== 'Agreed Unit Price ($)');
    await expect(resetAgreedUnitPriceFields(axios, 'ws-1', 'board-2', 'item-3', withoutPrice))
      .rejects.toThrow(TypeError);
    expect(axios.put).not.toHaveBeenCalled();
  });

  it('propagates a failure from the ISO+ call', async () => {
    axios.put.mockRejectedValue(new Error('Request failed with status code 500'));
    await expect(resetAgreedUnitPriceFields(axios, 'ws-1', 'board-2', 'item-3', itemValuesWithAttributeId))
      .rejects.toThrow('Request failed with status code 500');
  });
});
