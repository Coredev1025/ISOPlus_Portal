import { omit } from "lodash-es";
import axios from "@/app/utils/axiosConfig";
import {
  DELIVERY_STATE_BADGES,
  READ_ONLY_BLOCK_FIELDS,
} from "@/constants/automation";
import type { AutomationUnit } from "@/lib/automation-run-on-options";

/** The delivery states the backend stores, derived so the two cannot drift. */
export type DeliveryState = keyof typeof DELIVERY_STATE_BADGES;

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
  /**
   * Read-only. Computed from ScheduledJob.nextRunAt. Stripped from the save
   * payload by `saveAutomationSettings` — see READ_ONLY_BLOCK_FIELDS.
   */
  nextRun?: string | null;
  /** Read-only. From ScheduledJob.lastRunAt; survives a pause. */
  lastRunAt?: string | null;
  /**
   * Read-only. ScheduledJob.timezone — the zone `nextRun` and `lastRunAt` are
   * to be read in, and the zone `runAt` is already expressed in. Absent on a
   * response from a backend that predates the field, which `formatNextRun`
   * reads as the business default, the same fallback the scheduler uses.
   */
  timezone?: string;
  /** Read-only. ScheduledJob.lastError from the most recent run, or null. */
  lastRunError?: string | null;
  /**
   * Read-only, optional. A coarser statement of the same fact as
   * `lastRunError`, for a response shape that reports the failure without its
   * message. `blockNeedsAttention` reads all three.
   */
  lastRunFailed?: boolean;
  /** Read-only, optional. ScheduledJob.consecutiveFailures, when sent. */
  consecutiveFailures?: number;
};

/** One automation-generated PDF, newest first, as GET returns them. */
export type AutomationRecentDocument = {
  type: string;
  invoiceNumber: string | null;
  periodKey: string;
  pdfUrl: string;
  createdAt: string;
  /**
   * Optional. PDFLink.participant, when the API sends it — a real label for a
   * statement, which carries no invoice number. Absent responses fall back to
   * the file name; see `recentDocumentLabel`.
   */
  participant?: string | null;
  /**
   * Read-only. What became of the email that carried this document — one of
   * the wire values in DELIVERY_STATE_BADGES. Absent on a response from a
   * backend that predates delivery tracking, which `deliveryStatus` reads as
   * "generated": the document exists and nothing has been sent yet.
   */
  deliveryState?: DeliveryState | null;
  /**
   * Read-only, optional. One sentence the client can act on ("Email address
   * doesn't exist."), composed by the backend from the SES bounce type. Only
   * meaningful for the states DELIVERY_STATE_BADGES marks `showsDetail`.
   */
  deliveryDetail?: string | null;
};

export type AutomationSettings = {
  invoice: AutomationBlock;
  statement: AutomationBlock;
  /** GET only — the PUT echo does not carry it. */
  recentDocuments?: AutomationRecentDocument[];
};

/** Frozen: consumers must deep-copy, not spread, or they alias `every`. */
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

/**
 * What the client is allowed to write. Mongoose drops the read-only fields
 * today, so sending them is harmless — but a schema that later accepted them
 * would let a Save overwrite scheduler state no user typed.
 */
export type AutomationSavePayload = {
  invoice: Omit<AutomationBlock, (typeof READ_ONLY_BLOCK_FIELDS)[number]>;
  statement: Omit<AutomationBlock, (typeof READ_ONLY_BLOCK_FIELDS)[number]>;
};

export function toAutomationSavePayload(
  settings: AutomationSettings,
): AutomationSavePayload {
  return {
    invoice: omit(settings.invoice, READ_ONLY_BLOCK_FIELDS),
    statement: omit(settings.statement, READ_ONLY_BLOCK_FIELDS),
  };
}

export async function saveAutomationSettings(
  workspaceId: string,
  settings: AutomationSettings,
): Promise<AutomationSettings> {
  const response = await axios.put(
    path(workspaceId),
    toAutomationSavePayload(settings),
  );
  return response.data;
}
