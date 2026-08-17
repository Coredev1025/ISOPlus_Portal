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
        showFetchSuccessToast("Financial settings");
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.name === "CanceledError" || error.name === "AbortError")
        ) {
          return;
        }
        const err = error as { response?: { data?: { message?: string } } };
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

  const handleSequencePrefixChange = (
    type: DocumentSequenceType,
    value: string
  ) => {
    setSequences((prev) => ({
      ...prev,
      [type]: { ...prev[type], prefix: value },
    }));
  };

  const handleSequenceNextChange = (
    type: DocumentSequenceType,
    value: number
  ) => {
    setSequences((prev) => ({
      ...prev,
      [type]: { ...prev[type], nextNumber: value },
    }));
  };

  const handleRestoreDefaults = () => {
    setSequences(cloneDefaultSequences());
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setErrors([]);
      setApiError("");

      if (!profileForm.name?.trim()) {
        setErrors([MISSING_BUSINESS_NAME_HINT]);
        showSaveErrorToast("financial settings", MISSING_BUSINESS_NAME_HINT);
        setTimeout(() => setErrors([]), 5000);
        return;
      }

      const formDataToSend = new FormData();
      const merged = {
        ...profileForm,
        ...bankDetails,
        workspaceId,
      };
      for (const [key, value] of Object.entries(merged)) {
        const text =
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
            ? String(value)
            : "";
        formDataToSend.append(key, text);
      }
      formDataToSend.append(
        "documentNumbering",
        JSON.stringify({
          invoice: sequences.invoice,
          purchaseOrder: sequences.purchaseOrder,
          quote: sequences.quote,
          statement: sequences.statement,
        })
      );

      const response = await axios.put(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
        formDataToSend,
        { headers: { "Content-Type": "multipart/form-data" } }
      );

      if (response.status === 200) {
        const mapped = mapBusinessProfileToFormData(response.data, workspaceId);
        setProfileForm(mapped);
        setBankDetails(bankFromProfileForm(mapped));
        setSequences(extractDocumentNumberingSequences(response.data));
        setShowSuccess(true);
        showSaveSuccessToast("Financial settings");
        setTimeout(() => setShowSuccess(false), 2000);
      }
    } catch (error: unknown) {
      setShowSuccess(false);
      const err = error as {
        response?: { data?: { errors?: string[]; message?: string } };
      };
      const rawErrors = err.response?.data?.errors;
      const responseErrors = Array.isArray(rawErrors)
        ? mapFinancialSettingsErrors(rawErrors)
        : [];
      const errorMessage =
        responseErrors[0] ||
        err.response?.data?.message ||
        "An unexpected error occurred";
      showSaveErrorToast("financial settings", errorMessage);

      if (responseErrors.length > 0) {
        setErrors(responseErrors);
      } else {
        setApiError(errorMessage);
      }
      setTimeout(() => {
        setErrors([]);
        setApiError("");
      }, 5000);
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
      onSequenceNextChange={handleSequenceNextChange}
      onRestoreDefaults={handleRestoreDefaults}
      onSave={handleSave}
    />
  );
}
