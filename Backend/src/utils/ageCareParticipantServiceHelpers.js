import { buildIsoPlusV2ItemUrl } from './securityHelpers.js';

export function buildParticipantNamePrefix(participantsProfileValues) {
  let fullName = '';
  if (!participantsProfileValues) {
    return fullName;
  }

  fullName = participantsProfileValues?.fullName;
  if (fullName === '' || fullName == null || fullName === undefined) {
    if (participantsProfileValues?.firstName) {
      fullName = participantsProfileValues.firstName;
    }
    if (participantsProfileValues?.lastName) {
      fullName = (fullName ? `${fullName} ` : '') + participantsProfileValues.lastName;
    }
  }

  return fullName ? `${fullName} - ` : '';
}

export function createAttributeIdResolver(itemValuesWithAttributeId) {
  return (attributeName) => {
    const attributeValue = itemValuesWithAttributeId.find((value) => value.attribute?.name === attributeName);
    return attributeValue?.attribute?.id;
  };
}

function buildAtServicePlanId(fullName, wraparoundValues, serviceName) {
  return wraparoundValues?.wraparoundDescription
    ? `${fullName}${wraparoundValues.wraparoundDescription} for ${serviceName}`
    : fullName + serviceName;
}

function resolveHomeSupportSelection(fullName, homeSupportValues) {
  if (!homeSupportValues) return { selectedMainService: null, servicePlanIdValue: '' };
  return { selectedMainService: homeSupportValues, servicePlanIdValue: fullName + homeSupportValues.service };
}

function resolveWraparoundCategorySelection(context) {
  const {
    fullName,
    assistiveTechnologyShortTermValues,
    assistiveTechnologyOngoingValues,
    homeModificationValues,
    healthProfessionalValues,
    homeSupportValues,
    wraparoundValues,
  } = context;

  const selectedMainService = assistiveTechnologyShortTermValues
    || assistiveTechnologyOngoingValues
    || homeModificationValues
    || healthProfessionalValues
    || homeSupportValues
    || null;

  if (!wraparoundValues?.wraparoundDescription) {
    return { selectedMainService, servicePlanIdValue: '' };
  }

  const companionService = assistiveTechnologyShortTermValues?.service
    || assistiveTechnologyOngoingValues?.service
    || homeModificationValues?.service
    || healthProfessionalValues?.service;

  return {
    selectedMainService,
    servicePlanIdValue: companionService
      ? `${fullName}${wraparoundValues.wraparoundDescription} for ${companionService}`
      : `${fullName}${wraparoundValues.wraparoundDescription}`,
  };
}

const SERVICE_CATEGORY_RESOLVERS = {
  '🧑‍⚕️ Home Support (HS)': (context) => resolveHomeSupportSelection(context.fullName, context.homeSupportValues),
  '🦽 Assistive Technology (AT) - Short-term': (context) => {
    const service = context.assistiveTechnologyShortTermValues;
    if (!service) return { selectedMainService: null, servicePlanIdValue: '' };
    return {
      selectedMainService: service,
      servicePlanIdValue: buildAtServicePlanId(context.fullName, context.wraparoundValues, service.service),
    };
  },
  '🦼 Assistive Technology (AT) - Ongoing': (context) => {
    const service = context.assistiveTechnologyOngoingValues;
    if (!service) return { selectedMainService: null, servicePlanIdValue: '' };
    return {
      selectedMainService: service,
      servicePlanIdValue: buildAtServicePlanId(context.fullName, context.wraparoundValues, service.service),
    };
  },
  '🛠️ Home Modification (HM)': (context) => {
    const service = context.homeModificationValues;
    if (!service) return { selectedMainService: null, servicePlanIdValue: '' };
    return {
      selectedMainService: service,
      servicePlanIdValue: buildAtServicePlanId(context.fullName, context.wraparoundValues, service.service),
    };
  },
  '🩺 AT Health Professional': (context) => resolveHealthProfessionalSelection(context),
  '🩺 HM Health Professional': (context) => resolveHealthProfessionalSelection(context),
  '📌 AT Wraparound': (context) => resolveWraparoundCategorySelection(context),
  '📌 HM Wraparound': (context) => resolveWraparoundCategorySelection(context),
};

function resolveHealthProfessionalSelection(context) {
  const service = context.healthProfessionalValues;
  if (!service) return { selectedMainService: null, servicePlanIdValue: '' };
  return {
    selectedMainService: service,
    servicePlanIdValue: buildAtServicePlanId(context.fullName, context.wraparoundValues, service.service),
  };
}

export function resolveAgeCareServiceCategorySelection(serviceCategoryLabelName, context) {
  const resolver = SERVICE_CATEGORY_RESOLVERS[serviceCategoryLabelName];
  return resolver ? resolver(context) : { selectedMainService: null, servicePlanIdValue: '' };
}

function parseContributionPctFromGuideline(guideline) {
  if (!guideline) return 0;
  const text = guideline.toString();
  const first = text.includes('-') ? text.split('-')[0] : text;
  const parsed = parseFloat(first);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function appendAgeCarePricingVariableUpdates(updatevariables, options) {
  const {
    wraparoundValues,
    selectedMainService,
    homeSupportValues,
    unitAttributeId,
    agreedUnitPriceAttributeId,
    participantContributionAttributeId,
  } = options;

  const wraparoundSelected = !!wraparoundValues;
  const mainServiceWraparoundText = (selectedMainService?.wraparound || '').toString().toLowerCase();
  const wraparoundNotApplicable = wraparoundSelected && (
    !!homeSupportValues
    || (mainServiceWraparoundText && (mainServiceWraparoundText.includes('not applicable') || mainServiceWraparoundText.includes('n/a')))
  );

  const pricingSource = wraparoundSelected ? wraparoundValues : selectedMainService;
  if (!pricingSource && !wraparoundNotApplicable) {
    return;
  }

  const unitToSet = wraparoundNotApplicable ? '0' : (pricingSource?.unit ?? null);
  const unitPriceToSet = wraparoundNotApplicable ? 0 : Number(pricingSource?.unitPrice);
  const contributionPctToSet = wraparoundNotApplicable
    ? 0
    : parseContributionPctFromGuideline(pricingSource?.participantContributionGuideline);

  if (unitAttributeId && unitToSet !== null && unitToSet !== undefined) {
    updatevariables.push({ data: unitToSet, attribute_id: unitAttributeId });
  }
  if (agreedUnitPriceAttributeId && Number(unitPriceToSet) >= 0) {
    updatevariables.push({ data: Number(unitPriceToSet), attribute_id: agreedUnitPriceAttributeId });
  }
  if (participantContributionAttributeId && Number(contributionPctToSet) >= 0) {
    updatevariables.push({ data: Number(contributionPctToSet), attribute_id: participantContributionAttributeId });
  }
}

function inferSelectedMainPrefix(categoryLabelName, countHM, countATShort, countATOngoing) {
  if (categoryLabelName.includes('Home Modification') || categoryLabelName.includes('(HM)') || categoryLabelName.includes('HM Health Professional')) {
    return 'HM';
  }
  if (categoryLabelName.includes('Assistive Technology') || categoryLabelName.includes('(AT)') || categoryLabelName.includes('AT Health Professional')) {
    return 'AT';
  }
  if (categoryLabelName.includes('Wraparound')) {
    if (countHM > 0) return 'HM';
    if (countATShort > 0 || countATOngoing > 0) return 'AT';
  }
  return '';
}

function resolveWraparoundPrefix(wraparoundCategoryLabelName) {
  if (typeof wraparoundCategoryLabelName !== 'string') return '';
  if (wraparoundCategoryLabelName.includes('AT')) return 'AT';
  if (wraparoundCategoryLabelName.includes('HM')) return 'HM';
  return '';
}

function resolveWraparoundDescriptionPrefix(wraparoundValues) {
  if (!wraparoundValues?.wraparoundDescription || typeof wraparoundValues.wraparoundDescription !== 'string') {
    return '';
  }
  if (wraparoundValues.wraparoundDescription.includes('AT')) return 'AT';
  if (wraparoundValues.wraparoundDescription.includes('HM')) return 'HM';
  return '';
}

function checkCategoryMisalignment(numGroupsSelectedExclWrap, countWraparound, expectedKey) {
  if (numGroupsSelectedExclWrap === 0 && countWraparound === 0 && expectedKey) {
    return {
      statusColor: '#C60909',
      integrationMsg: 'Error: Misalignment of Service Category. The selected service does not match the assigned service category.',
    };
  }
  return null;
}

function checkMultipleServices(hasMultipleInAnyGroup) {
  if (!hasMultipleInAnyGroup) return null;
  return {
    statusColor: '#EE691E',
    integrationMsg: 'Error: Multiple Services within a Group. Please select only one service in each group.',
  };
}

function checkMultipleGroups(numGroupsSelectedExclWrap) {
  if (numGroupsSelectedExclWrap <= 1) return null;
  return {
    statusColor: '#EE691E',
    integrationMsg: 'Error: Multiple Service Groups. Please select only one service group (Wraparound can be combined with other categories except Home Support).',
  };
}

function checkStandaloneWraparound(wraparoundSelected, numGroupsSelectedExclWrap) {
  if (!wraparoundSelected || numGroupsSelectedExclWrap !== 0) return null;
  return {
    statusColor: '#CA56A8',
    integrationMsg: 'Error: Wraparound cannot be chosen as a Standalone Service. Please select a service category (except Home Support).',
  };
}

function checkWraparoundWithHomeSupport(wraparoundSelected, countHS) {
  if (!wraparoundSelected || countHS <= 0) return null;
  return {
    statusColor: '#3578D1',
    integrationMsg: 'Error: Wraparound is NOT Applicable. The selected service does not support Wraparound according to Aged Care Pricing guidelines.',
  };
}

function checkWraparoundNotApplicableOnService(wraparoundSelected, selectedService) {
  if (!wraparoundSelected || !selectedService?.wraparound) return null;
  const wraparoundValue = selectedService.wraparound.toLowerCase();
  if (!wraparoundValue.includes('not applicable') && !wraparoundValue.includes('n/a')) return null;
  return {
    statusColor: '#3578D1',
    integrationMsg: 'Error: Wraparound is NOT Applicable. The selected service does not support Wraparound according to Aged Care Pricing guidelines.',
  };
}

function checkWraparoundCategoryAlignment(wraparoundSelected, wraparoundCategoryLabelName, categoryLabelName, wraparoundValues, countHM, countATShort, countATOngoing) {
  if (!wraparoundSelected || !wraparoundCategoryLabelName) return null;
  const wraparoundPrefix = resolveWraparoundPrefix(wraparoundCategoryLabelName);
  const selectedMainPrefix = inferSelectedMainPrefix(categoryLabelName, countHM, countATShort, countATOngoing);
  const wraparoundDescPrefix = resolveWraparoundDescriptionPrefix(wraparoundValues);

  if (wraparoundPrefix && selectedMainPrefix && wraparoundPrefix !== selectedMainPrefix) {
    return {
      statusColor: '#D99C05',
      integrationMsg: 'Error: Misalignment of Wraparound Category. The starting letters of the selected Wraparound do not match the Wraparound Category.',
    };
  }
  if (wraparoundPrefix && wraparoundDescPrefix && wraparoundPrefix !== wraparoundDescPrefix) {
    return {
      statusColor: '#D99C05',
      integrationMsg: 'Error: Misalignment of Wraparound Category. The starting letters of the selected Wraparound do not match the Wraparound Category.',
    };
  }
  return null;
}

function checkSingleGroupCategoryAlignment(numGroupsSelectedExclWrap, nonWrapCounts, expectedKey) {
  if (numGroupsSelectedExclWrap !== 1) return null;
  const selectedKey = ['homeSupport', 'assistiveTechnologyShortTerm', 'assistiveTechnologyOngoing', 'homeModification', 'healthProfessional']
    .filter((_key, idx) => nonWrapCounts[idx] > 0)[0];
  if (!expectedKey || expectedKey === 'wraparound' || selectedKey === expectedKey) return null;
  return {
    statusColor: '#C60909',
    integrationMsg: 'Error: Misalignment of Service Category. The selected service does not match the assigned service category.',
  };
}

function checkAlignedSelection(numGroupsSelectedExclWrap, countWraparound) {
  if ((numGroupsSelectedExclWrap + countWraparound) <= 0) return null;
  return { statusColor: '#388903', integrationMsg: 'Aligned and Correct Selection.' };
}

function firstStatusResult(...checks) {
  for (const check of checks) {
    if (check) return check;
  }
  return { statusColor: '', integrationMsg: '' };
}

export function evaluateAgeCareConfigurationStatus(context) {
  const {
    itemsValues,
    categoryLabelName,
    wraparoundCategoryLabelName,
    homeSupportValues,
    assistiveTechnologyShortTermValues,
    assistiveTechnologyOngoingValues,
    homeModificationValues,
    healthProfessionalValues,
    wraparoundValues,
  } = context;

  const countHS = (itemsValues['Home Support (HS)']?.length || 0);
  const countATShort = (itemsValues['Assistive Technology (AT) - Short Term']?.length || 0);
  const countATOngoing = (itemsValues['Assistive Technology (AT) - Ongoing']?.length || 0);
  const countHM = (itemsValues['Home Modification (HM)']?.length || 0);
  const countHP = (itemsValues['Health Professional']?.length || 0);
  const countWraparound = (itemsValues.Wraparound?.length || 0);

  const nonWrapCounts = [countHS, countATShort, countATOngoing, countHM, countHP];
  const numGroupsSelectedExclWrap = nonWrapCounts.filter((count) => count > 0).length;
  const hasMultipleInAnyGroup = [...nonWrapCounts, countWraparound].some((count) => count > 1);
  const wraparoundSelected = countWraparound > 0;

  let expectedKey = '';
  if (categoryLabelName.includes('Home Support')) expectedKey = 'homeSupport';
  else if (categoryLabelName.includes('Short') || categoryLabelName.includes('Short-term')) expectedKey = 'assistiveTechnologyShortTerm';
  else if (categoryLabelName.includes('Ongoing')) expectedKey = 'assistiveTechnologyOngoing';
  else if (categoryLabelName.includes('Home Modification')) expectedKey = 'homeModification';
  else if (categoryLabelName.includes('Health Professional')) expectedKey = 'healthProfessional';
  else if (categoryLabelName.includes('Wraparound')) expectedKey = 'wraparound';

  const selectedService = homeSupportValues || assistiveTechnologyShortTermValues
    || assistiveTechnologyOngoingValues || homeModificationValues || healthProfessionalValues;

  return firstStatusResult(
    checkCategoryMisalignment(numGroupsSelectedExclWrap, countWraparound, expectedKey),
    checkMultipleServices(hasMultipleInAnyGroup),
    checkMultipleGroups(numGroupsSelectedExclWrap),
    checkStandaloneWraparound(wraparoundSelected, numGroupsSelectedExclWrap),
    checkWraparoundWithHomeSupport(wraparoundSelected, countHS),
    checkWraparoundNotApplicableOnService(wraparoundSelected, selectedService),
    checkWraparoundCategoryAlignment(wraparoundSelected, wraparoundCategoryLabelName, categoryLabelName, wraparoundValues, countHM, countATShort, countATOngoing),
    checkSingleGroupCategoryAlignment(numGroupsSelectedExclWrap, nonWrapCounts, expectedKey),
    checkAlignedSelection(numGroupsSelectedExclWrap, countWraparound),
  );
}

export function buildAgeCareParticipantServiceUpdates({
  itemValuesWithAttributeId,
  itemsValues,
  referencedItems,
}) {
  const [
    participantsProfileValues,
    homeSupportValues,
    assistiveTechnologyShortTermValues,
    assistiveTechnologyOngoingValues,
    homeModificationValues,
    healthProfessionalValues,
    wraparoundValues,
  ] = referencedItems;

  const updatevariables = [];
  const getAttributeIdByName = createAttributeIdResolver(itemValuesWithAttributeId);
  const fullName = buildParticipantNamePrefix(participantsProfileValues);
  const serviceCategory = itemValuesWithAttributeId.find((value) => value.attribute.name === 'Service Category');
  const serviceCategoryLabelId = serviceCategory?.data?.toString();
  const serviceCategoryLabelName = serviceCategoryLabelId
    ? serviceCategory?.attribute?.settings?.labels?.find((label) => label.id === serviceCategoryLabelId)?.name || ''
    : '';

  const { selectedMainService, servicePlanIdValue } = resolveAgeCareServiceCategorySelection(serviceCategoryLabelName, {
    fullName,
    homeSupportValues,
    assistiveTechnologyShortTermValues,
    assistiveTechnologyOngoingValues,
    homeModificationValues,
    healthProfessionalValues,
    wraparoundValues,
  });

  const servicePlanIdAttributeId = getAttributeIdByName('Service Plan ID');
  if (servicePlanIdValue && servicePlanIdAttributeId) {
    updatevariables.push({ data: servicePlanIdValue, attribute_id: servicePlanIdAttributeId });
  }

  appendAgeCarePricingVariableUpdates(updatevariables, {
    wraparoundValues,
    selectedMainService,
    homeSupportValues,
    unitAttributeId: getAttributeIdByName('Unit'),
    agreedUnitPriceAttributeId: getAttributeIdByName('Agreed Unit Price ($)'),
    participantContributionAttributeId: getAttributeIdByName('Participant Contribution (%)'),
  });

  const statusAttribute = itemValuesWithAttributeId.find((value) => value.attribute.name === 'Configuration Status');
  if (!statusAttribute) {
    return { updatevariables, integrationMsg: 'Configuration Status is required.', earlyError: 'Configuration Status is required.' };
  }

  const categoryAttribute = itemValuesWithAttributeId.find((value) => value.attribute.name === 'Service Category');
  const wraparoundAttribute = itemValuesWithAttributeId.find((value) => value.attribute.name === 'Wraparound Category');
  const categoryLabelId = categoryAttribute?.data?.toString();
  const categoryLabelName = categoryAttribute?.attribute?.settings?.labels?.find((label) => label.id === categoryLabelId)?.name || '';
  const wraparoundCategoryLabelId = wraparoundAttribute?.data?.toString();
  const wraparoundCategoryLabelName = wraparoundAttribute
    ? wraparoundAttribute.attribute.settings.labels.find((label) => label.id === wraparoundCategoryLabelId)?.name || ''
    : '';

  const { statusColor, integrationMsg } = evaluateAgeCareConfigurationStatus({
    itemsValues,
    categoryLabelName,
    wraparoundCategoryLabelName,
    homeSupportValues,
    assistiveTechnologyShortTermValues,
    assistiveTechnologyOngoingValues,
    homeModificationValues,
    healthProfessionalValues,
    wraparoundValues,
  });

  if (statusColor) {
    updatevariables.push({
      data: [statusAttribute.attribute.settings.labels.find((label) => label.color === statusColor)?.id || ''],
      attribute_id: statusAttribute.attribute.id,
    });
  }

  return { updatevariables, integrationMsg, earlyError: null };
}

export function getIsoPlusItemUpdateHeaders() {
  return {
    Authorization: `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-API-Version': '2025-02-26.morava',
  };
}

export async function resetAgreedUnitPriceFields(axios, workspaceId, boardId, itemId, itemValuesWithAttributeId) {
  await axios.put(buildIsoPlusV2ItemUrl(workspaceId, boardId, itemId), {
    values: [
      {
        data: 0,
        attribute_id: itemValuesWithAttributeId.find((value) => value.attribute.name === 'Agreed Unit Price ($)').attribute.id,
      },
      {
        data: 0,
        attribute_id: itemValuesWithAttributeId.find((value) => value.attribute.name === 'Participant Contribution (%)').attribute.id,
      },
    ],
  }, { headers: getIsoPlusItemUpdateHeaders() });
}
