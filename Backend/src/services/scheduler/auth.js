/**
 * The scheduler has no session, so it uses the same server identity that
 * applyPrivilegedSessionAuth (src/middleware/authHelpers.js:37) already hands
 * to support_admin and owner sessions. This introduces no new credential.
 *
 * It throws rather than returning "Bearer undefined", so a misconfigured
 * environment fails at dispatch instead of making an unauthenticated call to
 * ISO+ and getting a confusing 401 back.
 */
export function getSchedulerAuthorization() {
  const token = (process.env.PERSONAL_ACCESS_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      'Scheduler: PERSONAL_ACCESS_TOKEN is not set, so no job can be dispatched',
    );
  }
  return `Bearer ${token}`;
}
