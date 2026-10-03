import {
  INITIAL_NUMBER_SERIES,
  type InitialNumberSeriesType,
} from "@/constants/documentNumbering";
import { type NumberSequence } from "@/lib/configure-business-helpers";
import { type BankDetailsForm, type DocumentSequences } from "@/lib/financial-settings-form";

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

/** Shown when the server did not apply the first numbers the user typed. */
export const NUMBERS_NOT_APPLIED_MESSAGE =
  "Your starting numbers were not saved. They may already have been set, from another session or because a document was issued while you were saving, or they could not be applied yet. The numbers shown are the current ones, and the rest of your changes were saved. If this keeps happening, contact support.";

type ProfileFormFields = Record<string, unknown>;

/**
 * The request body for saving Financial Settings.
 *
 * Statement (STM-) is omitted: Document Number Configuration does not edit it,
 * and the server keeps the stored series used by monthly budget statement
 * automation. Sending clone or default STM- values would overwrite a live number.
 *
 * Until the first numbers are set (KAN-292) the typed numbers go in and the
 * request asks the server to set them; afterwards the numbers sent are ignored
 * by the server and only the prefixes matter.
 */
export function buildFinancialSettingsFormData({
  profileForm,
  bankDetails,
  workspaceId,
  sequences,
  numberingInitialized,
  initialNumbers,
}: {
  profileForm: ProfileFormFields;
  bankDetails: BankDetailsForm;
  workspaceId: string;
  sequences: DocumentSequences;
  numberingInitialized: boolean;
  initialNumbers: InitialNumbers;
}): FormData {
  const formData = new FormData();
  const merged: ProfileFormFields = { ...profileForm, ...bankDetails, workspaceId };
  for (const [key, value] of Object.entries(merged)) {
    const isScalar =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean";
    formData.append(key, isScalar ? String(value) : "");
  }
  const toSend = {
    invoice: sequences.invoice,
    purchaseOrder: sequences.purchaseOrder,
    quote: sequences.quote,
    statementOfAccount: sequences.statementOfAccount,
  };
  const numbering = numberingInitialized ? toSend : withInitialNumbers(toSend, initialNumbers);
  formData.append("documentNumbering", JSON.stringify(numbering));
  if (!numberingInitialized) formData.append("initializeDocumentNumbering", "true");
  return formData;
}

type SaveFailure = {
  response?: { data?: { errors?: string[]; message?: string } };
};

/** The messages to show for a failed save: field errors if the server gave any. */
export function describeSaveFailure(
  error: unknown,
  mapErrors: (errors: string[]) => string[]
): { errors: string[]; message: string } {
  const data = (error as SaveFailure).response?.data;
  const rawErrors = data?.errors;
  const errors = Array.isArray(rawErrors) ? mapErrors(rawErrors) : [];
  const message = errors[0] || data?.message || "An unexpected error occurred";
  return { errors, message };
}
