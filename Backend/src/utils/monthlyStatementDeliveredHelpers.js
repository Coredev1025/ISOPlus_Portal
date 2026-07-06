const DELIVERED_ATTRS_BY_CODE = {
  ATS: {
    minus: ['AT - Short-term Delivered During the Month ($-)', 'Assistive Technology - Short-term Delivered During the Month ($-)'],
    primary: 'Assistive Technology - Short-term Delivered During the Month',
  },
  ATO: {
    minus: ['AT - Ongoing Delivered During the Month ($-)', 'Assistive Technology - Ongoing Delivered During the Month ($-)'],
    primary: 'Assistive Technology - Ongoing Delivered During the Month',
  },
  HMB: {
    minus: ['Home Modification Delivered During the Month ($-)'],
    primary: 'Home Modification Delivered During the Month',
  },
  RCP: {
    minus: ['Restorative Care Delivered During the Month ($-)'],
    primary: 'Restorative Care Delivered During the Month',
  },
  EOL: {
    minus: ['End-of-Life Care Delivered During the Month ($-)'],
    primary: 'End-of-Life Care Delivered During the Month',
  },
};

export function getDeliveredAmountForCategoryCode(code, item, getValue, parseNumber, toOutflow) {
  const config = DELIVERED_ATTRS_BY_CODE[code];
  if (config) {
    for (const attr of config.minus) {
      const minusVal = getValue(item, attr);
      if (minusVal !== null && minusVal !== undefined) {
        return toOutflow(parseNumber(minusVal));
      }
    }
    return toOutflow(parseNumber(getValue(item, config.primary)));
  }

  const minusVal = getValue(item, 'Home Support Delivered During the Month ($-)');
  if (minusVal !== null && minusVal !== undefined) {
    return toOutflow(parseNumber(minusVal));
  }
  return toOutflow(parseNumber(getValue(item, 'Home Support Delivered During the Month')));
}

export function buildServiceItemDateQuery(startD, endD, scheduledKey, actualEndKey) {
  if (!startD && !endD) return null;

  const rangeIso = {};
  const startIso = startD ? startD.toISOString() : null;
  const endIso = endD ? endD.toISOString() : null;
  if (startIso) rangeIso.$gte = startIso;
  if (endIso) rangeIso.$lte = endIso;

  const rangeDate = {};
  if (startD) rangeDate.$gte = startD;
  if (endD) rangeDate.$lte = endD;

  return {
    $or: [
      { [scheduledKey]: rangeIso },
      { [scheduledKey]: rangeDate },
      { [actualEndKey]: rangeIso },
      { [actualEndKey]: rangeDate },
      { updatedAt: rangeDate },
      { createdAt: rangeDate },
    ],
  };
}
