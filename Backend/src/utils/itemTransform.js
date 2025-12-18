import { info, warn } from './logger.js';

export function transformValue(valueObj) {
  if (!valueObj || valueObj.data === undefined || valueObj.data === null) {
    return null;
  }

  const { data, attribute } = valueObj;
  const attributeType = attribute?.type;

  switch (attributeType) {
    case 'label':
      if (Array.isArray(data)) {
        const labels = attribute?.settings?.labels || [];
        if (data.length > 0) {
          const firstItem = data[0];
          if (typeof firstItem === 'string') {
            const resolvedLabels = data.map(labelId => {
              const label = labels.find(l => l.id === labelId);
              return label ? { id: label.id, name: label.name, color: label.color } : labelId;
            });
            return resolvedLabels.length === 1 ? resolvedLabels[0] : resolvedLabels;
          } else if (typeof firstItem === 'object' && firstItem.id) {
            return data.length === 1 ? data[0] : data;
          }
        }
        return data;
      } else if (typeof data === 'object' && data.id) {
        return { id: data.id, name: data.name, color: data.color };
      }
      return data;

    case 'reference':
    case 'members':
    case 'checklist':
    case 'attachments':
    case 'formula':
      return data;

    case 'source_folder':
      if (typeof data === 'object' && data.id) {
        return {
          id: data.id,
          name: data.name,
          board_id: data.board_id
        };
      }
      return data;

    case 'text':
    case 'longtext':
    case 'email':
    case 'number':
    case 'date':
    case 'checkbox':
    case 'created_by':
    case 'created_at':
    case 'updated_at':
    default:
      return data;
  }
}

export function transformItemData(isoPlusItem) {
  if (!isoPlusItem || !isoPlusItem.values || !Array.isArray(isoPlusItem.values)) {
    warn('ItemTransform', 'Invalid item data - missing values array', {
      itemId: isoPlusItem?.id
    });
    return {};
  }

  const transformedData = {};

  for (const valueObj of isoPlusItem.values) {
    if (valueObj.deleted) {
      continue;
    }

    const attributeName = valueObj.attribute?.name;
    if (!attributeName) {
      continue;
    }

    try {
      const transformedValue = transformValue(valueObj);
      
      if (transformedValue !== null && transformedValue !== undefined) {
        transformedData[attributeName] = transformedValue;
      }
    } catch (err) {
      warn('ItemTransform', 'Failed to transform value', {
        attributeName,
        attributeType: valueObj.attribute?.type,
        error: err.message
      });
    }
  }

  return transformedData;
}

export function transformItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map(item => ({
    itemId: item.id,
    folderId: item.folder_id,
    data: transformItemData(item)
  }));
}

export function getValueFromTransformedItem(itemData, attributeName) {
  if (!itemData || typeof itemData !== 'object') {
    return null;
  }
  return itemData[attributeName] ?? null;
}

export function getLabelName(labelValue) {
  if (!labelValue) {
    return null;
  }

  if (typeof labelValue === 'string') {
    return labelValue;
  }

  if (Array.isArray(labelValue)) {
    const first = labelValue[0];
    if (typeof first === 'object' && first.name) {
      return first.name;
    }
    return String(first);
  }

  if (typeof labelValue === 'object' && labelValue.name) {
    return labelValue.name;
  }

  return null;
}

export function getLabelNames(labelValue) {
  if (!labelValue) {
    return [];
  }

  if (typeof labelValue === 'string') {
    return [labelValue];
  }

  if (Array.isArray(labelValue)) {
    return labelValue.map(item => {
      if (typeof item === 'object' && item.name) {
        return item.name;
      }
      return String(item);
    });
  }

  if (typeof labelValue === 'object' && labelValue.name) {
    return [labelValue.name];
  }

  return [];
}

export function getReferenceIds(refValue) {
  if (!refValue) {
    return [];
  }

  if (Array.isArray(refValue)) {
    return refValue.map(id => String(id));
  }

  return [String(refValue)];
}

export function getFirstReferenceId(refValue) {
  const ids = getReferenceIds(refValue);
  return ids.length > 0 ? ids[0] : null;
}

export function parseNumber(value) {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function parseDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export default {
  transformItemData,
  transformItems,
  getValueFromTransformedItem,
  getLabelName,
  getLabelNames,
  getReferenceIds,
  getFirstReferenceId,
  parseNumber,
  parseDate,
  transformValue
};

