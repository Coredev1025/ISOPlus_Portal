export function appendMasterPlanVariableUpdate(updatevariables, getAttributeId, attributeName, data) {
  if (data === null || data === undefined) return;
  const attributeId = getAttributeId(attributeName);
  if (!attributeId) return;
  updatevariables.push({ data, attribute_id: attributeId });
}

export function buildMasterPlanVariableUpdates({
  getAttributeId,
  servicePlanValues,
  quantity,
  unitPrice,
  totalAmount,
  governmentSubsidy,
  participantContribution,
}) {
  const updatevariables = [];

  if (servicePlanValues.unit != ' ' && servicePlanValues.unit != null && servicePlanValues.unit != undefined) {
    appendMasterPlanVariableUpdate(updatevariables, getAttributeId, 'Unit', servicePlanValues.unit);
  }
  if (quantity !== null) {
    appendMasterPlanVariableUpdate(updatevariables, getAttributeId, 'Quantity', quantity);
  }
  if (unitPrice >= 0) {
    appendMasterPlanVariableUpdate(updatevariables, getAttributeId, 'Unit Price ($)', unitPrice);
  }
  if (totalAmount !== null) {
    appendMasterPlanVariableUpdate(updatevariables, getAttributeId, 'Total Amount ($)', totalAmount);
  }
  appendMasterPlanVariableUpdate(updatevariables, getAttributeId, 'Government Subsidy ($)', governmentSubsidy);
  appendMasterPlanVariableUpdate(updatevariables, getAttributeId, 'Participant Contribution ($)', participantContribution);

  return updatevariables;
}
