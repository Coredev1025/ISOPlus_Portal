const PARTY_CONTACT_FIELDS = ['Email Address', 'Phone Number', 'Address', 'Suburb', 'State', 'Postcode'];

function requireAttribute(values, attributeName, errorMessage) {
  if (!values.some((value) => value.attribute.name === attributeName)) {
    throw new Error(errorMessage);
  }
}

function requirePartyContactFields(values, partyLabel) {
  requireAttribute(values, partyLabel, `${partyLabel} is required`);
  PARTY_CONTACT_FIELDS.forEach((field) => {
    requireAttribute(values, field, `${partyLabel} ${field.toLowerCase()} is required`);
  });
}

function resolveStateLabel(values) {
  const stateElement = values.find((value) => value.attribute.name === 'State')?.data;
  const stateId = stateElement?.[0]?.toString() || '';
  if (!stateId) return '';
  const stateAttribute = values.find((value) => value.attribute.name === 'State');
  return stateAttribute?.attribute?.settings?.labels?.find((label) => label.id === stateId)?.name || '';
}

function readOptionalString(values, attributeName) {
  return values.some((value) => value.attribute.name === attributeName)
    ? values.find((value) => value.attribute.name === attributeName).data.toString()
    : '';
}

export function buildPartyContactValues(values, partyLabel, outputKey) {
  requirePartyContactFields(values, partyLabel);
  return {
    [outputKey]: values.find((value) => value.attribute.name === partyLabel).data.toString(),
    emailAddress: values.find((value) => value.attribute.name === 'Email Address').data.toString(),
    phoneNumber: values.find((value) => value.attribute.name === 'Phone Number').data.toString(),
    address: values.find((value) => value.attribute.name === 'Address').data.toString(),
    suburb: values.find((value) => value.attribute.name === 'Suburb').data.toString(),
    state: resolveStateLabel(values),
    postcode: parseInt(values.find((value) => value.attribute.name === 'Postcode').data.toString(), 10),
    contactPersonsFirstName: readOptionalString(values, "Contact Person's First Name"),
    contactPersonsLastName: readOptionalString(values, "Contact Person's Last Name"),
    updatedAt: readOptionalString(values, 'Updated At'),
  };
}

export function buildJobTypeValues(values) {
  requireAttribute(values, 'Job Type', 'Job Type is required');
  requireAttribute(values, 'Job Code', 'Job Code is required');
  return {
    jobType: values.find((value) => value.attribute.name === 'Job Type').data.toString(),
    jobCode: values.find((value) => value.attribute.name === 'Job Code').data.toString(),
  };
}

async function resolveJobTypeReference(workspaceId, boardId, reference, getItemValues) {
  const jobTypeItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (!jobTypeItemValues) return null;
  return buildJobTypeValues(jobTypeItemValues.values);
}

async function resolvePartyReference(workspaceId, boardId, reference, getItemValues, partyLabel, outputKey) {
  const itemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (!itemValues) return null;
  return buildPartyContactValues(itemValues.values, partyLabel, outputKey);
}

export async function fetchPartyJobTypeReferencedItems({
  workspaceId,
  boardId,
  itemId,
  partyAttributeName,
  partyLabel,
  outputKey,
  getReferences,
  getAttribute,
  getItemValues,
}) {
  let partyValues = null;
  let jobTypeValues = null;

  const referenceResponse = await getReferences(workspaceId, boardId, itemId);
  if (!referenceResponse) return [null, null];

  for (const reference of referenceResponse.data) {
    const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
    if (!attribute) continue;

    if (attribute.name === partyAttributeName) {
      partyValues = await resolvePartyReference(workspaceId, boardId, reference, getItemValues, partyLabel, outputKey);
    } else if (attribute.name === 'Job Type') {
      jobTypeValues = await resolveJobTypeReference(workspaceId, boardId, reference, getItemValues);
    }
  }

  return [partyValues, jobTypeValues];
}
