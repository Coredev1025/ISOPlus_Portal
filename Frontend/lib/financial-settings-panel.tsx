"use client";

import { useEffect, useState } from "react";
import axios from "@/app/utils/axiosConfig";
import Spinner from "@/components/ui/spin";
import {
  cloneDefaultSequences,
  extractDocumentNumberingSequences,
  mapBusinessProfileToFormData,
} from "@/lib/configure-business-helpers";
import {
  FinancialSettingsForm,
  type BankDetailsForm,
  type DocumentSequenceType,
  type DocumentSequences,
} from "@/lib/financial-settings-form";
import {
  EMPTY_INITIAL_NUMBERS,
  NUMBERS_NOT_APPLIED_MESSAGE,
  buildFinancialSettingsFormData,
  describeSaveFailure,
  initialNumberErrors,
  type InitialNumbers,
} from "@/lib/financial-settings-numbering-helpers";
import { type InitialNumberSeriesType } from "@/constants/documentNumbering";
import {
  showFetchErrorToast,
  showFetchSuccessToast,
  showSaveErrorToast,
  showSaveSuccessToast,
} from "@/lib/toast-utils";

const EMPTY_BANK: BankDetailsForm = {
  bankName: "",
  bankAccountName: "",
  bsb: "",
  accountNumber: "",
  accountsReceivableTerms: "",
  accountsPayableTerms: "",
};

const EMPTY_BUSINESS_PROFILE: Record<string, never> = Object.freeze({});

const MISSING_BUSINESS_NAME_HINT =
  "Set Company Name in Configure Business first, then save Financial Settings again.";

function mapFinancialSettingsErrors(errors: string[]): string[] {
  return errors.map((error) =>
    error.toLowerCase().includes("business name is required")
      ? MISSING_BUSINESS_NAME_HINT
      : error
  );
}

type FinancialSettingsPanelProps = Readonly<{
  workspaceId: string;
}>;

function bankFromProfileForm(
  form: ReturnType<typeof mapBusinessProfileToFormData>
): BankDetailsForm {
  return {
    bankName: form.bankName,
    bankAccountName: form.bankAccountName,
    bsb: form.bsb,
    accountNumber: form.accountNumber,
    accountsReceivableTerms: form.accountsReceivableTerms,
    accountsPayableTerms: form.accountsPayableTerms,
  };
}

export function FinancialSettingsPanel({
  workspaceId,
}: FinancialSettingsPanelProps) {
  const [profileForm, setProfileForm] = useState(() =>
    mapBusinessProfileToFormData(EMPTY_BUSINESS_PROFILE, workspaceId)
  );
  const [bankDetails, setBankDetails] = useState<BankDetailsForm>(EMPTY_BANK);
  const [sequences, setSequences] =
    useState<DocumentSequences>(cloneDefaultSequences);
  // KAN-292: until the server reports the first numbers set, the user types them.
  // A workspace with no profile yet (404) is also not set.
  const [numberingInitialized, setNumberingInitialized] = useState(false);
  const [initialNumbers, setInitialNumbers] =
    useState<InitialNumbers>(EMPTY_INITIAL_NUMBERS);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [apiError, setApiError] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();

    const loadProfile = async () => {
      try {
        setLoadingProfile(true);
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
          {
            params: { workspaceId },
            signal: abortController.signal,
          }
        );
        if (abortController.signal.aborted) return;

        const mapped = mapBusinessProfileToFormData(response.data, workspaceId);
        setProfileForm(mapped);
        setBankDetails(bankFromProfileForm(mapped));
        setSequences(extractDocumentNumberingSequences(response.data));
        setNumberingInitialized(response.data.documentNumberingInitialized !== false);
        showFetchSuccessToast("Financial settings");
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.name === "CanceledError" || error.name === "AbortError")
        ) {
          return;
        }
        const err = error as {
          response?: { status?: number; data?: { message?: string } };
        };
        // New workspaces have no profile yet — empty form is expected, not an error toast.
        if (err.response?.status === 404) {
          return;
        }
        showFetchErrorToast(
          "financial settings",
          err.response?.data?.message || "Failed to load financial settings"
        );
      } finally {
        if (!abortController.signal.aborted) {
          setLoadingProfile(false);
        }
      }
    };

    loadProfile();
    return () => abortController.abort();
  }, [workspaceId]);

  const handleBankChange = (field: keyof BankDetailsForm, value: string) => {
    setBankDetails((prev) => ({ ...prev, [field]: value }));
  };

  const handleInitialNumberChange = (
    type: InitialNumberSeriesType,
    value: string
  ) => {
    setInitialNumbers((prev) => ({ ...prev, [type]: value }));
  };

  const handleSequencePrefixChange = (
    type: DocumentSequenceType,
    value: string
  ) => {
    setSequences((prev) => ({
      ...prev,
      [type]: { ...prev[type], prefix: value },
    }));
  };

  // Shows `messages` as the form's errors for five seconds, and as a toast.
  const showBlockingErrors = (messages: string[]) => {
    setErrors(messages);
    showSaveErrorToast("financial settings", messages[0]);
    setTimeout(() => setErrors([]), 5000);
  };

  // What must be fixed before anything is sent, or an empty list.
  const findBlockingErrors = (): string[] => {
    if (!profileForm.name?.trim()) return [MISSING_BUSINESS_NAME_HINT];
    return numberingInitialized ? [] : initialNumberErrors(initialNumbers);
  };

  const applySavedProfile = (data: Record<string, any>) => {
    const mapped = mapBusinessProfileToFormData(data, workspaceId);
    setProfileForm(mapped);
    setBankDetails(bankFromProfileForm(mapped));
    setSequences(extractDocumentNumberingSequences(data));
    setNumberingInitialized(data.documentNumberingInitialized !== false);
    if (data.initialNumbersApplied === false) {
      // The rest of the profile saved, but the numbers the user typed did not:
      // say so, rather than showing a success over numbers that differ.
      setApiError(NUMBERS_NOT_APPLIED_MESSAGE);
      showSaveErrorToast("financial settings", NUMBERS_NOT_APPLIED_MESSAGE);
      setTimeout(() => setApiError(""), 8000);
      return;
    }
    setShowSuccess(true);
    showSaveSuccessToast("Financial settings");
    setTimeout(() => setShowSuccess(false), 2000);
  };

  const reportSaveFailure = (error: unknown) => {
    setShowSuccess(false);
    const { errors: responseErrors, message } = describeSaveFailure(
      error,
      mapFinancialSettingsErrors
    );
    showSaveErrorToast("financial settings", message);
    if (responseErrors.length > 0) {
      setErrors(responseErrors);
    } else {
      setApiError(message);
    }
    setTimeout(() => {
      setErrors([]);
      setApiError("");
    }, 5000);
  };

  const handleSave = async () => {
    setErrors([]);
    setApiError("");
    const blocking = findBlockingErrors();
    if (blocking.length > 0) {
      showBlockingErrors(blocking);
      return;
    }
    try {
      setSaving(true);
      const response = await axios.put(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
        buildFinancialSettingsFormData({
          profileForm,
          bankDetails,
          workspaceId,
          sequences,
          numberingInitialized,
          initialNumbers,
        }),
        { headers: { "Content-Type": "multipart/form-data" } }
      );
      if (response.status === 200) applySavedProfile(response.data);
    } catch (error: unknown) {
      reportSaveFailure(error);
    } finally {
      setSaving(false);
    }
  };

  if (loadingProfile) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Spinner />
        <span>Loading financial settings…</span>
      </div>
    );
  }

  return (
    <FinancialSettingsForm
      bankDetails={bankDetails}
      sequences={sequences}
      loading={saving}
      errors={errors}
      apiError={apiError}
      showSuccess={showSuccess}
      onBankChange={handleBankChange}
      onSequencePrefixChange={handleSequencePrefixChange}
      numberingInitialized={numberingInitialized}
      initialNumbers={initialNumbers}
      onInitialNumberChange={handleInitialNumberChange}
      onSave={handleSave}
    />
  );
}
