import axios from "@/app/utils/axiosConfig";

export type FeatureTogglesPayload = {
  invoiceStatementAutomation: boolean;
};

export async function fetchWorkspaceFeatureToggles(
  workspaceId: string
): Promise<FeatureTogglesPayload> {
  const response = await axios.get(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/${workspaceId}/feature-toggles`
  );
  return {
    invoiceStatementAutomation: Boolean(
      response.data?.invoiceStatementAutomation
    ),
  };
}

export async function saveWorkspaceFeatureToggles(
  workspaceId: string,
  invoiceStatementAutomation: boolean
): Promise<FeatureTogglesPayload> {
  const response = await axios.put(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/${workspaceId}/feature-toggles`,
    { invoiceStatementAutomation }
  );
  return {
    invoiceStatementAutomation: Boolean(
      response.data?.invoiceStatementAutomation
    ),
  };
}

/** Readable by any authenticated workspace user via business profile (not Owner-only toggles API). */

/**
 * Three answers, not two.
 *
 * `off` is a real answer — the workspace does not have the feature, or this
 * user may not see the profile. `unavailable` means the question was not
 * answered at all. Collapsing the second into the first is how a transient
 * 503 on the profile call silently hid the Invoice & Statement Automation tab
 * and rewrote ?tab=automation to ?tab=financial, telling the reader the
 * feature does not exist.
 *
 * Touchpoints: app/workspace/[id]/finance-settings/page.tsx (holds it),
 * lib/finance-settings-tab.ts (`resolveActiveFinanceTab` gates on it).
 */
export type AutomationFlagState = "on" | "off" | "unavailable";

/** No `response` means the request never landed — DNS, CORS, offline. */
function statusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

export async function fetchInvoiceStatementAutomationFlag(
  workspaceId: string
): Promise<AutomationFlagState> {
  try {
    const response = await axios.get(
      `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
      { params: { workspaceId } }
    );
    return response.data?.featureToggles?.invoiceStatementAutomation
      ? "on"
      : "off";
  } catch (error: unknown) {
    const status = statusOf(error);
    // A 4xx is the server answering: the profile is missing, or not this
    // user's to read. Both mean "not available to you" and must keep hiding
    // the tab. Anything else — 5xx, or no response at all — is not an answer.
    const answered = status !== undefined && status >= 400 && status < 500;
    return answered ? "off" : "unavailable";
  }
}
