import {
  DEFAULT_DOCUMENT_NEXT_NUMBER,
  INITIAL_NUMBER_SERIES,
} from '../constants/documentNumbering.js';

/**
 * KAN-292. The first number of each document type is chosen by the user, once,
 * the first time Finance Settings is saved. These helpers decide whether that
 * has happened and build the write that records it.
 */

function counterOf(business, series) {
  return business?.documentNumbering?.[series]?.nextNumber;
}

/**
 * True once the user has set the first numbers. A business that predates the
 * flag counts as set when any counter has moved off the default: it has already
 * issued documents, and its counters must never be set again.
 */
export function isDocumentNumberingInitialized(business) {
  if (!business) return false;
  if (business.documentNumberingInitialized === true) return true;
  return INITIAL_NUMBER_SERIES.some((series) => {
    const next = counterOf(business, series);
    return next !== undefined && next !== null && next !== DEFAULT_DOCUMENT_NEXT_NUMBER;
  });
}

/** True when the request asks to set the first numbers. */
export function wantsInitialNumbers(body) {
  return body?.initializeDocumentNumbering === 'true' || body?.initializeDocumentNumbering === true;
}

/** Every series carries a whole next number of at least 1. */
export function hasAllInitialNumbers(incoming) {
  return INITIAL_NUMBER_SERIES.every((series) => {
    const next = incoming?.[series]?.nextNumber;
    return Number.isInteger(next) && next >= DEFAULT_DOCUMENT_NEXT_NUMBER;
  });
}

/** The database paths that record the first numbers and the flag. */
export function initialNumberSetPaths(incoming) {
  const paths = { documentNumberingInitialized: true };
  for (const series of INITIAL_NUMBER_SERIES) {
    paths[`documentNumbering.${series}.nextNumber`] = incoming[series].nextNumber;
  }
  return paths;
}

/**
 * The first numbers of a brand-new business: each chosen number, nested the way
 * the schema stores them. Merge into the prefixes.
 */
export function initialNumberingForNewBusiness(numbering, incoming) {
  const merged = { ...numbering };
  for (const series of INITIAL_NUMBER_SERIES) {
    merged[series] = { ...merged[series], nextNumber: incoming[series].nextNumber };
  }
  return merged;
}

/**
 * A filter that matches the business only while no counter has moved and the
 * flag is unset, so the numbers are written only if nothing was issued meanwhile.
 */
export function uninitializedFilter(id) {
  const filter = { _id: id, documentNumberingInitialized: { $ne: true } };
  for (const series of INITIAL_NUMBER_SERIES) {
    filter[`documentNumbering.${series}.nextNumber`] = { $in: [DEFAULT_DOCUMENT_NEXT_NUMBER, null] };
  }
  return filter;
}

/**
 * What this save is allowed to do about the first numbers. `requested` is what
 * the client asked for; `allowed` is also true only while the business is still
 * uninitialized; `initialPaths` is the write, empty unless allowed.
 */
export function planInitialNumbers({ business, body, incomingNumbering }) {
  const requested = wantsInitialNumbers(body);
  const allowed = requested && !isDocumentNumberingInitialized(business);
  return {
    requested,
    allowed,
    initialPaths: allowed ? initialNumberSetPaths(incomingNumbering) : {},
  };
}

/**
 * The reply field telling the client whether the numbers it sent were applied.
 * Present only when the client asked to set them: a save that did not ask has
 * nothing to report. A request that was not applied (already initialized, or a
 * counter moved while the save was in flight) says so instead of looking like a
 * success.
 */
export function initialNumbersReply(plan, written) {
  return plan.requested ? { initialNumbersApplied: Boolean(plan.allowed && written) } : {};
}

/** The numbers that were set, for the audit trail. Plain keys, no dotted paths. */
export function initialNumbersAuditMetadata(incoming) {
  const initialNumbers = {};
  for (const series of INITIAL_NUMBER_SERIES) {
    initialNumbers[series] = incoming[series].nextNumber;
  }
  return { initialNumbers };
}
