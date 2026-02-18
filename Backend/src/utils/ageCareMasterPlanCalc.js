export function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

export function isBlank(value) {
  return normalizeString(value) === '';
}

export function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function parseNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[$,%]/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function isTimeBasedUnit(unit) {
  const unitNorm = normalizeString(unit);
  return unitNorm.includes('hour');
}

export function categorizeTransaction({ transactionStatus, committedATHM }) {
  const statusNorm = normalizeString(transactionStatus);

  // Accept a few plausible label variants (case/spacing/punctuation differences)
  const isAdjustment =
    statusNorm.startsWith('adjustment') ||
    (statusNorm.includes('adjustment') && (statusNorm.includes('refund') || statusNorm.includes('charge')));

  const isCancelled = statusNorm.includes('cancelled');
  const isDelivered = !isAdjustment && statusNorm.includes('delivered');

  // In ISO+, the committed case is represented by Committed ticked + blank Transaction Status
  const isCommitted = Boolean(committedATHM) && statusNorm === '';

  return { statusNorm, isAdjustment, isCancelled, isDelivered, isCommitted };
}

export function shouldAutoUpdateMasterPlanVariables(tx) {
  return !tx.isAdjustment;
}

export function computeMasterPlanQuantity({
  isTimeBased,
  tx,
  actualDuration,
  scheduledDuration,
  quantityNonTimeBased,
}) {
  if (!shouldAutoUpdateMasterPlanVariables(tx)) return null;

  if (!isTimeBased) return round2(quantityNonTimeBased);

  if (tx.isCancelled || tx.isCommitted) return round2(scheduledDuration);
  return round2(actualDuration);
}

export function computeMasterPlanTotalAmount({
  unitPrice,
  quantity,
  tx,
  billableToClientPct,
}) {
  if (!shouldAutoUpdateMasterPlanVariables(tx)) return null;

  const base = parseNumber(unitPrice) * parseNumber(quantity);
  if (tx.isCancelled) {
    return round2(base * (parseNumber(billableToClientPct) / 100));
  }
  return round2(base);
}

export function computeMasterPlanContributions({ totalAmount, participantContributionPct, tx }) {
  if (!shouldAutoUpdateMasterPlanVariables(tx)) return null;

  const total = parseNumber(totalAmount);
  const pct = parseNumber(participantContributionPct);
  const participantContribution = round2((pct / 100) * total);
  const governmentSubsidy = round2(total - participantContribution);

  return { participantContribution, governmentSubsidy };
}

