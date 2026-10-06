/**
 * Reads the jobs the global BullMQ mock in test/setup.js recorded.
 *
 * The mock stores them on globalThis rather than exporting them, because
 * `vi.mock` factories are hoisted above every module-scope binding in the
 * setup file and so cannot close over one.
 *
 * Returns a copy: a test that filters or sorts the result must not be able to
 * disturb what a later assertion in the same test sees.
 */
export function recordedBulkJobs() {
  return [...(globalThis.__BULLMQ_BULK_JOBS__ ?? [])];
}

/** Every recorded job for one queue job name, e.g. KIND_INVOICE. */
export function recordedBulkJobsOfKind(name) {
  return recordedBulkJobs().filter((job) => job.name === name);
}

/** The BullMQ jobIds recorded so far, in enqueue order. */
export function recordedJobIds() {
  return recordedBulkJobs().map((job) => job.opts?.jobId);
}

/**
 * Truncates the recording in place. setup.js calls this after every test; a
 * test that ticks more than once calls it directly to separate the rounds.
 *
 * In place, not a reassignment: the mock factory captured this same array.
 */
export function resetRecordedJobs() {
  const jobs = globalThis.__BULLMQ_BULK_JOBS__;
  if (jobs) jobs.length = 0;
}
