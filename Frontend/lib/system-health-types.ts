export type ConnectionStatus = "connected" | "disconnected" | "needs_reauth";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

export type RunRow = {
  _id: string;
  workspaceId: string;
  boardId: string;
  kind: string;
  periodKey: string;
  jobId: string;
  status: RunStatus;
  skipReason: string | null;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  recipient: string | null;
  error: string | null;
};

export type ScheduleRow = {
  kind: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  missedRuns: number;
  consecutiveFailures: number;
  timezone: string;
};

export type ClientRow = {
  workspaceId: string;
  /**
   * The client's business name, or null when the Business document has no name
   * or does not exist. Null rather than a defaulted workspaceId so this layer
   * can tell "unnamed" apart from a client actually called `ws-...`.
   */
  name: string | null;
  invoiceEnabled: boolean;
  statementEnabled: boolean;
  provider: "xero";
  connection: ConnectionStatus;
};

/**
 * Bounces and complaints over the same window the run figures use.
 *
 * Always numeric, never absent: the screen used to render a paragraph saying
 * delivery reporting did not exist, which an operator cannot tell apart from
 * "it exists and nothing bounced". Zero says the second thing.
 */
export type DeliveryIssues = {
  bounced: number;
  complained: number;
  windowHours: number;
};

export type Overview = {
  activeAutomations: number;
  runsToday: number;
  runsThisWeek: number;
  succeeded: number;
  failed: number;
  errorRate24h: number;
  errorRateWindowHours: number;
  delivery: DeliveryIssues;
  // The "is the scheduler even ticking" signal. With no ticks every other
  // figure is legitimately zero and the screen looks healthy, so this is not
  // optional to render.
  lastTickAt: string | null;
  queue: {
    // Only the figures the screen renders. waiting/active/delayed are on the
    // wire but nothing reads them apart, and `total` already sums them.
    failed: number;
    total: number;
    backlogged: boolean;
    available: boolean;
  };
};

/**
 * One email a run actually sent, from
 * `GET /system-health/workspace/:id/runs/:runId/emails`.
 *
 * `recipient` is the participant key the message was addressed under, which is
 * what EmailSend records — not the address itself, which stays out of the admin
 * screen deliberately.
 */
export type RunEmailRow = {
  messageId: string;
  recipient: string | null;
  recipientType: string | null;
  sentAt: string;
  state: string;
  detail: string | null;
};
