function enrichNumericFieldFromCategory(aggregate, aggKey, catKey, category, parseNumberValue) {
  if (Math.abs(aggregate[aggKey] || 0) >= 0.001) {
    return;
  }
  const catVal = parseNumberValue(category[catKey]);
  if (Math.abs(catVal) >= 0.001) {
    aggregate[aggKey] = catVal;
  }
}

function enrichMappedFieldFromCategory(aggregate, aggField, catFields, category, parseNumberValue) {
  if (Math.abs(aggregate[aggField] || 0) >= 0.001) {
    return;
  }
  for (const catField of catFields) {
    const catVal = parseNumberValue(category[catField]);
    if (Math.abs(catVal) >= 0.001) {
      aggregate[aggField] = catVal;
      break;
    }
  }
}

export function enrichNumericAggregateFields(aggregate, category, numericFields, mappedFields, parseNumberValue) {
  for (const [aggKey, catKey] of Object.entries(numericFields)) {
    enrichNumericFieldFromCategory(aggregate, aggKey, catKey, category, parseNumberValue);
  }

  for (const { aggField, catFields } of mappedFields) {
    enrichMappedFieldFromCategory(aggregate, aggField, catFields, category, parseNumberValue);
  }
}

export function enrichLabelAggregateFields(aggregate, category, safeString) {
  if (!aggregate.primarySupplementLabel) {
    aggregate.primarySupplementLabel = safeString(category.primarySupplementLabel) || '';
  }
  if (!aggregate.fund) {
    aggregate.fund = safeString(category.fund) || '';
  }
  if (!aggregate.fundClassification) {
    aggregate.fundClassification = safeString(category.fundClassification) || '';
  }
  if (!aggregate.fundingStartDate && category.fundingStartDate) {
    aggregate.fundingStartDate = category.fundingStartDate;
  }
  if (!aggregate.fundingEndDate && category.fundingEndDate) {
    aggregate.fundingEndDate = category.fundingEndDate;
  }
}
