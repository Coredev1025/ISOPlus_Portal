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
      const isIsoplusLogin =
        event.tags?.feature === "auth" &&
        (event.tags?.auth_method === "isoplus_oauth_redirect" ||
          event.tags?.auth_method === "oauth_ticket_exchange");
      return isIsoplusLogin ? event : null;
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
