import {
  INITIAL_NUMBER_SERIES,
  type InitialNumberSeriesType,
} from "@/constants/documentNumbering";
import { type NumberSequence } from "@/lib/configure-business-helpers";

/** What the user has typed for each first number; empty until they type. */
export type InitialNumbers = Record<InitialNumberSeriesType, string>;

export const EMPTY_INITIAL_NUMBERS: InitialNumbers = {
  invoice: "",
  purchaseOrder: "",
  quote: "",
  statementOfAccount: "",
};

/** Whole number of 1 or more, written as digits only. */
function parseStartingNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** One message per document type that has no usable starting number. */
export function initialNumberErrors(numbers: InitialNumbers): string[] {
  return INITIAL_NUMBER_SERIES.filter(
    ({ type }) => parseStartingNumber(numbers[type]) === null
  ).map(
    ({ label }) =>
      `${label}: enter a starting number of 1 or more (whole number, e.g. 1001)`
  );
}

/** The sequences to send, with each typed number in place of the stored one. */
export function withInitialNumbers<T extends Record<string, NumberSequence>>(
  sequences: T,
  numbers: InitialNumbers
): T {
  const next: Record<string, NumberSequence> = { ...sequences };
  for (const { type } of INITIAL_NUMBER_SERIES) {
    next[type] = {
      ...sequences[type],
      nextNumber: parseStartingNumber(numbers[type]) ?? sequences[type].nextNumber,
    };
  }
  return next as T;
}
