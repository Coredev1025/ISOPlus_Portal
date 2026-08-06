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
export async function fetchInvoiceStatementAutomationFlag(
  workspaceId: string
): Promise<boolean> {
  try {
    const response = await axios.get(
      `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
      { params: { workspaceId } }
    );
    return Boolean(
      response.data?.featureToggles?.invoiceStatementAutomation
    );
  } catch {
    return false;
  }
}
