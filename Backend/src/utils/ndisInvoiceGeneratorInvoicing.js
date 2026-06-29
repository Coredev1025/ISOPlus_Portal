import Item from '../models/Item.js';
import {
  NDIS_MASTERPLAN_ATTR,
  NDIS_SERVICEPLAN_ATTR,
  collectNdisSupportCatalogueRefIds,
  extractAllRefIds,
  extractRefId,
  formatLabelValue,
  getParticipantDisplayName,
  isUuidLike,
} from './ndisServiceRecords.js';
import { resolveNdisPricingRuleForServicePlan } from './ndisPricingRules.js';

export async function bulkFetchReferenceItemsFromDB(workspaceId, boardId, itemIds) {
  if (!itemIds || itemIds.length === 0) return new Map();

  const uniqueIds = [...new Set(itemIds.filter(Boolean).map((id) => String(id)))];
  if (uniqueIds.length === 0) return new Map();

  const sameBoard = await Item.find({
    workspaceId: workspaceId.toString(),
    boardId: boardId.toString(),
    itemId: { $in: uniqueIds },
  }).lean();

  const map = new Map(sameBoard.map((i) => [i.itemId, i]));

  const missing = uniqueIds.filter((id) => !map.has(id));
  if (missing.length > 0) {
    const crossBoard = await Item.find({
      workspaceId: workspaceId.toString(),
      itemId: { $in: missing },
    }).lean();
    for (const i of crossBoard) {
      if (!map.has(i.itemId)) map.set(i.itemId, i);
    }
  }

  return map;
}

function resolveRefDisplayName(refId, refItemsMap) {
  const refItem = refItemsMap.get(refId);
  if (!refItem?.data) return '';
  const candidates = [
    'Cancellation Reason',
    'Cancellation reason',
    'Reason',
    'Name',
    'Definition',
    'Full Name/Preferred Name',
    'Preferred Name',
  ];
  for (const key of candidates) {
    const label = formatLabelValue(refItem.data[key]).trim();
    if (label && !isUuidLike(label)) return label;
  }
  return '';
}

function resolveValueToNames(value, refItemsMap) {
  if (!value) return '';
  const ids = extractAllRefIds(value).filter(isUuidLike);
  if (ids.length > 0) {
    const names = ids.map((id) => resolveRefDisplayName(id, refItemsMap)).filter(Boolean);
    if (names.length > 0) return names.join(', ');
  }
  return formatLabelValue(value).trim();
}

export function getParticipantProfileFields(participantProfileItem) {
  const data = participantProfileItem?.data || {};
  const get = (k) => formatLabelValue(data?.[k]).trim();
  const getMulti = (...keys) => {
    for (const k of keys) {
      const v = formatLabelValue(data?.[k]).trim();
      if (v) return v;
    }
    return '';
  };

  const displayName = getParticipantDisplayName(participantProfileItem);
  const fullName = get('Full Name/Preferred Name');
  let firstName = getMulti('First Name', "Contact Person's First Name", 'ContactPersonsFirstName');
  let lastName = getMulti('Last Name', "Contact Person's Last Name", 'ContactPersonsLastName');

  if ((!firstName || !lastName) && (fullName || displayName)) {
    const nameToParse = (fullName || displayName).trim();
    const parts = nameToParse.split(/\s+/);
    if (parts.length >= 2) {
      if (!firstName) firstName = parts[0];
      if (!lastName) lastName = parts.slice(1).join(' ');
    } else if (parts.length === 1 && parts[0]) {
      if (!firstName) firstName = parts[0];
      if (!lastName) lastName = parts[0];
    }
  }

  return {
    displayName,
    billingContact: get('Billing Contact'),
    billingEmail: get('Billing Email'),
    billingAddress: get('Billing Address'),
    firstName,
    lastName,
    fullName,
    email: get('Email'),
    address: get('Address'),
    suburb: get('Suburb'),
    state: get('State'),
    postcode: get('Postcode'),
    updatedAt: participantProfileItem?.updatedAt,
  };
}

export async function getNdisInvoiceGeneratorContextFromMasterItems({
  workspaceId,
  boardId,
  masterItemIds,
}) {
  const ids = [...new Set((masterItemIds || []).filter(Boolean).map((id) => String(id)))];
  if (ids.length === 0) {
    throw new Error('No items provided for invoice generation.');
  }

  const masterItems = await Item.find({
    workspaceId: workspaceId.toString(),
    boardId: boardId.toString(),
    itemId: { $in: ids },
  }).lean();

  const found = new Set(masterItems.map((i) => i.itemId));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`Some items were not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`);
  }

  const notApproved = masterItems.filter((item) => {
    const approval = formatLabelValue(item?.data?.[NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL]).trim().toLowerCase();
    return approval !== 'approved';
  });
  if (notApproved.length > 0) {
    throw new Error(`Some items are not Timesheet Approved and cannot be invoiced (${notApproved.length}).`);
  }

  const servicePlanIds = new Set();
  const participantProfileIds = new Set();
  const cancellationTypeIds = new Set();
  const allowancesRefIds = new Set();
  const nonFaceToFaceRefIds = new Set();

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
  }

  const refItemsMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, [
    ...servicePlanIds,
    ...participantProfileIds,
    ...cancellationTypeIds,
    ...allowancesRefIds,
    ...nonFaceToFaceRefIds,
  ]);

  const supportItemIds = new Set();
  for (const spId of servicePlanIds) {
    const spItem = refItemsMap.get(spId);
    if (!spItem?.data) continue;
    const pricingRule = await resolveNdisPricingRuleForServicePlan(workspaceId, spItem, boardId);
    collectNdisSupportCatalogueRefIds(spItem.data, pricingRule).forEach((id) => supportItemIds.add(id));
  }
  if (supportItemIds.size > 0) {
    const supportMap = await bulkFetchReferenceItemsFromDB(workspaceId, boardId, [...supportItemIds]);
    for (const [k, v] of supportMap) refItemsMap.set(k, v);
  }

  const normalizedMasterItems = masterItems.map((item) => {
    const allowancesResolved = resolveValueToNames(item?.data?.[NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE], refItemsMap);
    const nf2fResolved = resolveValueToNames(item?.data?.[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS], refItemsMap);
    if (!allowancesResolved && !nf2fResolved) return item;
    return {
      ...item,
      data: {
        ...(item.data || {}),
        [NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE]:
          allowancesResolved || (item?.data?.[NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE] ?? ''),
        [NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS]:
          nf2fResolved || (item?.data?.[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS] ?? ''),
      },
    };
  });

  const uniqueParticipants = [...participantProfileIds];
  if (uniqueParticipants.length !== 1) {
    throw new Error('Please select items for one participant only (multiple participant profiles detected).');
  }
  const participantProfileItem = refItemsMap.get(uniqueParticipants[0]);
  if (!participantProfileItem) {
    throw new Error('Participant Profile information is required but was not found.');
  }

  return {
    masterItems: normalizedMasterItems,
    refItemsMap,
    participantProfileItem,
  };
}
