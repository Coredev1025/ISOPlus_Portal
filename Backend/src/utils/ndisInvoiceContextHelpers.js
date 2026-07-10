import {
  NDIS_MASTERPLAN_ATTR,
  extractRefId,
  extractAllRefIds,
  isUuidLike,
} from './ndisServiceRecords.js';

export function collectInvoiceRefIdsFromMasterItems(masterItems) {
  const servicePlanIds = new Set();
  const participantProfileIds = new Set();
  const cancellationTypeIds = new Set();
  const allowancesRefIds = new Set();
  const nonFaceToFaceRefIds = new Set();
  const serviceDeliveryModeIds = new Set();
  const cancellationReasonIds = new Set();

  for (const item of masterItems) {
    const spId = extractRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.SERVICE_PLAN]);
    if (spId && isUuidLike(spId)) servicePlanIds.add(spId);

    const ppId = extractRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
    if (ppId && isUuidLike(ppId)) participantProfileIds.add(ppId);

    const ctId = extractRefId(item?.data?.['Cancellation Type']);
    if (ctId && isUuidLike(ctId)) cancellationTypeIds.add(ctId);

    extractAllRefIds(item?.data?.[NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE])
      .filter(isUuidLike)
      .forEach((id) => allowancesRefIds.add(id));

    extractAllRefIds(item?.data?.[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS])
      .filter(isUuidLike)
      .forEach((id) => nonFaceToFaceRefIds.add(id));

    extractAllRefIds(item?.data?.[NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE])
      .filter(isUuidLike)
      .forEach((id) => serviceDeliveryModeIds.add(id));

    extractAllRefIds(item?.data?.[NDIS_MASTERPLAN_ATTR.CANCELLATION_REASON])
      .filter(isUuidLike)
      .forEach((id) => cancellationReasonIds.add(id));
  }

  return {
    servicePlanIds,
    participantProfileIds,
    cancellationTypeIds,
    allowancesRefIds,
    nonFaceToFaceRefIds,
    serviceDeliveryModeIds,
    cancellationReasonIds,
  };
}
