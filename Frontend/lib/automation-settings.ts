import axios from "@/app/utils/axiosConfig";
import type { AutomationUnit } from "@/lib/automation-run-on-options";

export type AutomationBlock = {
  enabled: boolean;
  every: { n: number; unit: AutomationUnit };
  runOn: string | number | { month: number; day: number } | null;
  runAt: string;
  startDate: string | null;
  sendMethod: "isoplus" | "accounting";
  recipient: "billing_contact" | "client_participant";
  sendCopyTo: string;
  replyTo: string;
  emailFrom: string;
  emailSubject: string;
  emailMessage: string;
  senderIdentityId: string | null;
  /** Read-only. Computed from ScheduledJob.nextRunAt; never sent on save. */
  nextRun?: string | null;
};

export type AutomationSettings = {
  invoice: AutomationBlock;
  statement: AutomationBlock;
};

/**
 * Frozen to prevent mutation of the module singleton.
 * Consumers must copy deeply (not spread) to avoid aliasing the nested `every` object.
 */
export const DEFAULT_BLOCK: AutomationBlock = Object.freeze({
  enabled: false,
  every: Object.freeze({ n: 1, unit: "month" }),
  runOn: 1,
  runAt: "09:00",
  startDate: null,
  sendMethod: "isoplus",
  recipient: "billing_contact",
  sendCopyTo: "",
  replyTo: "",
  emailFrom: "",
  emailSubject: "",
  emailMessage: "",
  senderIdentityId: null,
  nextRun: null,
}) as AutomationBlock;

const path = (workspaceId: string) =>
  `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/${workspaceId}/automation-settings`;

export async function fetchAutomationSettings(
  workspaceId: string,
): Promise<AutomationSettings> {
  const response = await axios.get(path(workspaceId));
  return response.data;
}

export async function saveAutomationSettings(
  workspaceId: string,
  settings: AutomationSettings,
): Promise<AutomationSettings> {
  const response = await axios.put(path(workspaceId), settings);
  return response.data;
}
