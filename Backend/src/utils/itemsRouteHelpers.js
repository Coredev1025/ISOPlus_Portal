function compareServiceItemsByDate(a, b, useDeliveryDate, serviceSortOrder) {
  const aDate = useDeliveryDate ? a.actualEndDate : a.scheduledStartDate;
  const bDate = useDeliveryDate ? b.actualEndDate : b.scheduledStartDate;
  if (!aDate && !bDate) return 0;
  if (!aDate) return 1;
  if (!bDate) return -1;
  const aTime = aDate instanceof Date ? aDate.getTime() : aDate;
  const bTime = bDate instanceof Date ? bDate.getTime() : bDate;
  const cmp = aTime < bTime ? -1 : (aTime > bTime ? 1 : 0);
  return serviceSortOrder === 'desc' ? -cmp : cmp;
}

function compareServiceItemsByUpdated(a, b) {
  const aUpdated = a.item.updatedAt || a.item.createdAt || new Date(0);
  const bUpdated = b.item.updatedAt || b.item.createdAt || new Date(0);
  const aUpdTime = aUpdated instanceof Date ? aUpdated.getTime() : new Date(aUpdated).getTime();
  const bUpdTime = bUpdated instanceof Date ? bUpdated.getTime() : new Date(bUpdated).getTime();
  if (aUpdTime < bUpdTime) return 1;
  if (aUpdTime > bUpdTime) return -1;
  return 0;
}

export function compareServiceItems(a, b, { sortByDate, useDeliveryDate, serviceSortOrder }) {
  if (sortByDate) {
    return compareServiceItemsByDate(a, b, useDeliveryDate, serviceSortOrder);
  }
  return compareServiceItemsByUpdated(a, b);
}

export function resolveInvoiceIssuedValue(status) {
  const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : null;
  if (normalizedStatus === 'invoiced') return true;
  if (normalizedStatus === 'pending' || normalizedStatus === 'not invoiced') return false;
  return undefined;
}

export function parseListPagination(page, limitParam) {
  const hasLimitParam = limitParam !== undefined && limitParam !== null && limitParam !== '';
  let limitNumber = null;
  let applyPagination = false;
  if (hasLimitParam) {
    const limitValue = limitParam.toString().toLowerCase();
    if (limitValue !== 'all') {
      const parsedLimit = parseInt(limitParam, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        limitNumber = parsedLimit;
        applyPagination = true;
      }
    }
  }
  const pageNumber = applyPagination ? (parseInt(page, 10) > 0 ? parseInt(page, 10) : 1) : 1;
  const skip = applyPagination && limitNumber ? (pageNumber - 1) * limitNumber : 0;
  return { limitNumber, applyPagination, pageNumber, skip };
}

export function matchesStatusFilter(names, raw, filterValue) {
  if (Array.isArray(names) && names.length > 0) {
    if (names.some((name) => filterValue == String(name))) {
      return true;
    }
  } else if (names && !Array.isArray(names)) {
    if (filterValue == String(names)) {
      return true;
    }
  }
  if (raw) {
    const rawStr = Array.isArray(raw)
      ? raw.map((v) => String(v)).join(' ')
      : String(raw);
    if (filterValue == rawStr) {
      return true;
    }
  }
  return false;
}

export function applyInvoiceStatusUpdates(item, { invoiceIssuedValue, invoiceNumber, fileUrl }, info) {
  let changed = false;

  const updateAttribute = (attributeName, newData, options = { required: true }) => {
    const currentData = item.data[attributeName];
    const nextData = typeof newData === 'function' ? newData(currentData) : newData;

    if (nextData !== undefined && nextData !== currentData) {
      item.data[attributeName] = nextData;
      changed = true;
      return true;
    }
    return false;
  };

  if (invoiceIssuedValue !== undefined) {
    updateAttribute('Invoice Issued and Sent', invoiceIssuedValue);
  }

  if (invoiceNumber) {
    updateAttribute('Generated Invoice Number', invoiceNumber);
  }

  if (fileUrl) {
    const optionalFileAttributes = [
      'Invoice File URL',
      'Invoice PDF Link',
      'Generated Invoice File URL',
      'Generated Invoice Link',
    ];
    const fileAttrUpdated = optionalFileAttributes.some((attr) =>
      updateAttribute(attr, fileUrl, { required: false }),
    );
    if (!fileAttrUpdated) {
      info('Items-Service', 'No matching attribute found for invoice file URL', {
        itemId: item.itemId,
        workspaceId: item.workspaceId,
        boardId: item.boardId,
      });
    }
  }

  return changed;
}
