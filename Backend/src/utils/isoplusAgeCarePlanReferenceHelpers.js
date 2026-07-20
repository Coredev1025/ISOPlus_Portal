function readAttr(values, name) {
  return values.find((v) => v.attribute.name === name)?.data?.toString() || '';
}

function requireAttr(values, name) {
  if (!values.some((v) => v.attribute.name === name)) {
    throw new Error(`${name} is required`);
  }
}

function buildAgeCareServiceCatalog(item, values) {
  requireAttr(values, 'Service');
  return {
    id: item.id,
    service: readAttr(values, 'Service'),
    serviceType: readAttr(values, 'Service Type'),
    unit: readAttr(values, 'Unit Type'),
    unitPrice: readAttr(values, 'Price ($)').replace('$', '') || '0',
    participantContributionGuideline: readAttr(values, 'Participant Contribution Guideline (%)'),
    wraparound: readAttr(values, 'Wraparound'),
    serviceIDItemID: readAttr(values, 'Service ID /  Item ID'),
    itemID: readAttr(values, 'Item ID'),
    item: readAttr(values, 'Item'),
  };
}

function buildHealthProfessionalCatalog(item, values) {
  const catalog = buildAgeCareServiceCatalog(item, values);
  return {
    ...catalog,
    healthProfessionalTypeCode: readAttr(values, 'Health Professional Type Code'),
    healthProfessionalTypeOther: readAttr(values, 'Health Professional Type'),
  };
}

async function resolveParticipantProfile(workspaceId, boardId, reference, getItemValues) {
  const participantsProfile = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (!participantsProfile) return null;
  const values = participantsProfile.values;
  requireAttr(values, 'Full Name/Preferred Name');
  return {
    id: participantsProfile.id,
    fullName: readAttr(values, 'Full Name/Preferred Name'),
    firstName: readAttr(values, 'First Name'),
    lastName: readAttr(values, 'Last Name'),
    email: readAttr(values, 'Email'),
    phone: readAttr(values, 'Primary Phone Number'),
    address: readAttr(values, 'Address'),
    suburb: readAttr(values, 'Suburb'),
    state: readAttr(values, 'State'),
    postcode: readAttr(values, 'Postcode'),
    billingContact: readAttr(values, 'Billing Contact'),
    billingAddress: readAttr(values, 'Billing Address'),
  };
}

async function resolveServiceCatalogReference(workspaceId, boardId, reference, getItemValues, builder = buildAgeCareServiceCatalog) {
  const item = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (!item) return null;
  return builder(item, item.values);
}

async function resolveWraparoundReference(workspaceId, boardId, reference, getItemValues) {
  const wraparound = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (!wraparound) return null;
  const values = wraparound.values;
  requireAttr(values, 'Wraparound Description');
  return {
    id: wraparound.id,
    itemID: readAttr(values, 'Wraparound Item ID'),
    wraparoundDescription: readAttr(values, 'Wraparound Description'),
    unit: readAttr(values, 'Unit Type'),
    unitPrice: readAttr(values, 'Price ($)').replace('$', '') || '0',
    participantContributionGuideline: readAttr(values, 'Participant Contribution Guideline (%)'),
  };
}

function createAgeCarePlanHandlerMap() {
  const catalog = (resultKey) => ({
    resultKey,
    handler: (workspaceId, boardId, reference, getItemValues) =>
      resolveServiceCatalogReference(workspaceId, boardId, reference, getItemValues),
  });

  return {
    'Participant Profile': {
      resultKey: 'participantsProfileValues',
      handler: resolveParticipantProfile,
    },
    'Home Support (HS)': catalog('homeSupportValues'),
    'Assistive Technology (AT) - Short Term': catalog('assistiveTechnologyShortTermValues'),
    'Assistive Technology (AT) - Ongoing': catalog('assistiveTechnologyOngoingValues'),
    'Home Modification (HM)': catalog('homeModificationValues'),
    'Health Professional': {
      resultKey: 'healthProfessionalValues',
      handler: (workspaceId, boardId, reference, getItemValues) =>
        resolveServiceCatalogReference(
          workspaceId,
          boardId,
          reference,
          getItemValues,
          buildHealthProfessionalCatalog,
        ),
    },
    Wraparound: {
      resultKey: 'wraparoundValues',
      handler: resolveWraparoundReference,
    },
  };
}

export async function fetchAgeCareParticipantsServicePlanReferencedItems({
  workspaceId,
  boardId,
  itemId,
  getReferences,
  getAttribute,
  getItemValues,
}) {
  const results = {
    participantsProfileValues: null,
    homeSupportValues: null,
    assistiveTechnologyShortTermValues: null,
    assistiveTechnologyOngoingValues: null,
    homeModificationValues: null,
    healthProfessionalValues: null,
    wraparoundValues: null,
  };

  const referenceResponse = await getReferences(workspaceId, boardId, itemId);
  if (!referenceResponse) return [null, null];

  const handlerMap = createAgeCarePlanHandlerMap();
  for (const reference of referenceResponse.data) {
    const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
    if (!attribute) continue;
    const config = handlerMap[attribute.name];
    if (!config) continue;
    const value = await config.handler(workspaceId, boardId, reference, getItemValues);
    if (value !== null && value !== undefined) {
      results[config.resultKey] = value;
    }
  }

  return [
    results.participantsProfileValues,
    results.homeSupportValues,
    results.assistiveTechnologyShortTermValues,
    results.assistiveTechnologyOngoingValues,
    results.homeModificationValues,
    results.healthProfessionalValues,
    results.wraparoundValues,
  ];
}
