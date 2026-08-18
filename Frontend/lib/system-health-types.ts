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
  invoiceEnabled: boolean;
  statementEnabled: boolean;
  provider: "xero";
  connection: ConnectionStatus;
};

export type Overview = {
  activeAutomations: number;
  runsToday: number;
  runsThisWeek: number;
  succeeded: number;
  failed: number;
  errorRate24h: number;
  trend: number[];
  errorRateWindowHours: number;
  // The "is the scheduler even ticking" signal. With no ticks every other
  // figure is legitimately zero and the screen looks healthy, so this is not
  // optional to render.
  lastTickAt: string | null;
  queue: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    total: number;
    backlogged: boolean;
    available: boolean;
  };
};
