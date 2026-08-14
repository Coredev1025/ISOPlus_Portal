import Item from '../models/Item.js';
import InvoiceNumber from '../models/InvoiceNumber.js';
import Business from '../models/Business.js';
import { bulkFetchReferenceItemsFromDB } from './ndisInvoiceGeneratorInvoicing.js';
import { isUuidLike } from './ndisServiceRecords.js';
import {
  ATTRIBUTE_NAMES,
  REF_ATTRIBUTE_NAMES,
} from '../constants/monthlyStatementAttributes.js';
import { info, error, warn } from './logger.js';

export function getValueFromFlatData(item, attributeName) {
  if (!item?.data) return null;
  const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];
  for (const attrName of attributeNames) {
    if (item.data[attrName] !== undefined && item.data[attrName] !== null) return item.data[attrName];
  }
  return null;
}

export function extractRefId(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === 'object' && first.id) return first.id.toString();
    if (typeof first === 'string') return first;
    return first?.toString();
  }
  if (typeof value === 'object' && value.id) return value.id.toString();
  if (typeof value === 'string') return value;
  return value?.toString();
}

export function extractAllRefIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'object' && entry.id) return entry.id.toString();
      if (typeof entry === 'string') return entry;
      return entry?.toString();
    }).filter(Boolean);
  }
  if (typeof value === 'object' && value.id) return [value.id.toString()];
  if (typeof value === 'string') return [value];
  return value ? [value.toString()] : [];
}

async function noFolderIds() {
  return [];
}

export function ndisInvoiceGeneratorListDeps() {
  return {
    Item,
    Business,
    InvoiceNumber,
    getFolderIds: noFolderIds,
    bulkFetchReferenceItemsFromDB,
    isUuidLike,
    warn,
  };
}

function getMyAgedCareIdFromProfile(profileItem) {
  if (!profileItem) return null;
  const id = getValueFromFlatData(profileItem, [
    REF_ATTRIBUTE_NAMES.PROFILE_MY_AGED_CARE_ID,
    REF_ATTRIBUTE_NAMES.PROFILE_MY_AGED_CARE_ID_ALT,
  ]);
  return id ? String(id) : null;
}

function getFundingSourceNameFromItem(fsItem) {
  if (!fsItem) return null;
  const name = getValueFromFlatData(fsItem, [REF_ATTRIBUTE_NAMES.FS_NAME, REF_ATTRIBUTE_NAMES.FS_DEFINITION]);
  if (!name) return null;
  return (typeof name === 'object' && name.name ? name.name : String(name).trim()) || null;
}

function getServiceFromServicePlan(servicePlanItem) {
  if (!servicePlanItem) return null;
  const serviceAttr = getValueFromFlatData(servicePlanItem, [REF_ATTRIBUTE_NAMES.SERVICE, 'Service']);
  if (serviceAttr) {
    if (typeof serviceAttr === 'object' && serviceAttr.name) return serviceAttr.name;
    return String(serviceAttr).trim();
  }
  return null;
}

function emptyCodedDescription() {
  return { code: '', description: '' };
}

export function ageCareInvoiceGeneratorListDeps() {
  return {
    Item,
    InvoiceNumber,
    getFolderIds: noFolderIds,
    bulkFetchReferenceItemsFromDB,
    getValueFromFlatData,
    extractRefId,
    extractAllRefIds,
    getServiceFromServicePlan,
    getServiceIdentifierFromServicePlan: () => null,
    getItemDescriptionFromServicePlan: emptyCodedDescription,
    getWraparoundDescriptionFromServicePlan: emptyCodedDescription,
    getHealthProfessionalFromServicePlan: () => ({ typeCode: '', typeOther: '' }),
    getMyAgedCareIdFromProfile,
    getFundingSourceNameFromItem,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    info,
    error,
    warn,
  };
}
