/**
 * Shared destructive-style banner for the System Health screens: the
 * drill-down's load/run/retry errors and the client panel's load error all
 * render the same way, so this is the one place that style lives.
 *
 * system-health-page-view.tsx's SchedulerHeartbeat deliberately does NOT use
 * this: a stopped scheduler is the failure every other tile on that screen
 * hides, so it carries extra emphasis rather than reading as one more error.
 * It is a separate variant, not a missed extraction.
 */
export function ErrorBanner({ message }: Readonly<{ message: string }>) {
  return (
    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
      {message}
    </p>
  );
}
