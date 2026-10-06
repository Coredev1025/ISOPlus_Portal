import * as Sentry from "@sentry/nextjs";

export type AuthSentryMethod =
  | "isoplus_oauth_redirect"
  | "google_support_oauth_redirect"
  | "oauth_ticket_exchange";

function isSentryEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);
}

function applyAuthScope(
  scope: Sentry.Scope,
  authMethod: AuthSentryMethod,
  stage: string,
  extras?: Record<string, unknown>
): void {
  scope.setTag("feature", "auth");
  scope.setTag("auth_method", authMethod);
  scope.setTag("auth_stage", stage);
  if (extras) scope.setExtras(extras);
}

/** Record a client-side auth pipeline step (breadcrumb). */
export function captureAuthStep(
  authMethod: AuthSentryMethod,
  stage: string,
  message: string,
  extras?: Record<string, unknown>
): void {
  if (!isSentryEnabled()) return;

  Sentry.addBreadcrumb({
    category: "auth",
    type: "info",
    level: "info",
    message,
    data: { authMethod, stage, ...extras },
  });
}

/**
 * Report ISO+ auth failures to Sentry. Events are gated by
 * instrumentation-client.ts beforeSend (feature=auth + auth_method).
 */
export function captureAuthFailure(
  authMethod: AuthSentryMethod,
  error: unknown,
  extras?: Record<string, unknown>
): void {
  if (!isSentryEnabled()) return;

  const stage = typeof extras?.stage === "string" ? extras.stage : "client_failure";
  const err =
    error instanceof Error
      ? error
      : new Error(
          typeof error === "string" ? error : "Authentication failure"
        );

  Sentry.addBreadcrumb({
    category: "auth",
    type: "error",
    level: "error",
    message: err.message,
    data: { authMethod, stage, ...extras },
  });

  Sentry.withScope((scope) => {
    applyAuthScope(scope, authMethod, stage, extras);
    Sentry.captureException(err);
  });
}

export function captureAuthMessage(
  authMethod: AuthSentryMethod,
  message: string,
  extras?: Record<string, unknown>
): void {
  if (!isSentryEnabled()) return;

  const stage = typeof extras?.stage === "string" ? extras.stage : "client_message";

  Sentry.addBreadcrumb({
    category: "auth",
    type: "error",
    level: "error",
    message,
    data: { authMethod, stage, ...extras },
  });

  Sentry.withScope((scope) => {
    applyAuthScope(scope, authMethod, stage, extras);
    Sentry.captureMessage(message, "error");
  });
}
