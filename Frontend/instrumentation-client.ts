import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,

    sendDefaultPii: true,

    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    beforeSend(event) {
      // Only forward ISO+ auth diagnostic events from the browser.
      const isAuthEvent = event.tags?.feature === "auth";
      const method = event.tags?.auth_method;
      const isIsoplusLogin =
        isAuthEvent &&
        (method === "isoplus_oauth_redirect" || method === "oauth_ticket_exchange");
      return isIsoplusLogin ? event : null;
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
