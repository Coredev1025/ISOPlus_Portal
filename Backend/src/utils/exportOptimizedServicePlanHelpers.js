export function normalizeServiceIdString(serviceId) {
  let idStr = String(serviceId);
  if (idStr.includes('/')) {
    idStr = idStr.split('/')[0].trim();
  }
  return idStr;
}

export function lookupServiceIdFromRefs(servicePlanItem, refItemsMap, serviceRefAttrs, getValue, getValueMulti, extractRefId, idAttrs) {
  for (const refAttr of serviceRefAttrs) {
    const refValue = getValue(servicePlanItem, refAttr);
    const refId = extractRefId(refValue);
    if (!refId) continue;
    const refItem = refItemsMap.get(refId);
    if (!refItem) continue;
    const refServiceId = getValueMulti(refItem, idAttrs);
    if (refServiceId) {
      return normalizeServiceIdString(refServiceId);
    }
  }
  return null;
}

export function normalizeHealthProfessionalTypeOther(typeOther) {
  if (!typeOther) return typeOther;
  const typeOtherStr = String(typeOther);
  if (typeOtherStr.includes(' - Other')) {
    return typeOtherStr.split(' - Other')[0];
  }
  return typeOther;
}

export function lookupHealthProfessionalFromRef(refItemsMap, healthProfRefId, getValueMulti, typeCodeAttrs, typeOtherAttrs) {
  const healthProfItem = refItemsMap.get(healthProfRefId);
  if (!healthProfItem) return null;
  const typeCode = getValueMulti(healthProfItem, typeCodeAttrs) || '';
  const typeOther = normalizeHealthProfessionalTypeOther(getValueMulti(healthProfItem, typeOtherAttrs) || '');
  return { typeCode, typeOther };
}
