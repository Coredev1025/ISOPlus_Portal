// Whether the caller may touch THIS workspace, as opposed to being logged in at
// all.
//
// middleware/auth.js answers the second question: authorizeIsoplusUser checks
// that an ISO+ session exists on the request. It deliberately does not check
// that the session belongs to the workspace in the URL, because most routes
// here proxy the call to ISO+ with the caller's own token and let ISO+ refuse.
// A route that reads Mongo directly gets no such refusal, so it has to ask the
// question itself — otherwise changing the id in the path reaches another
// client's data.
//
// ISO+ is the authority on membership, not the Portal: workspaces and their
// members live there, and nothing in this database records who belongs to what.

import { getMemberRole } from '../services/isoplus.js';
import { isOfflineMode } from '../services/offlineIsoplus.js';
import { warn } from './logger.js';
import { PORTAL_STAFF_ROLES } from '../constants/roles.js';

const LOG_SCOPE = 'Workspace-Access';



/**
 * Statuses that are ISO+ answering the question, rather than failing to.
 * 401/403 mean the token cannot see this workspace and 404 means it does not
 * exist for this caller — all three are "no". Anything else is an outage, and
 * an outage is not a permission decision.
 *
 * 400 belongs here too, though it is not ISO+ speaking: getMemberRole returns
 * it without asking anyone when the caller has no email to match on. The login
 * JWT always carries one, so it should be unreachable — and if it is ever
 * reached, failing closed is right and pointing an operator at ISO+ is not.
 */
const REFUSAL_STATUSES = new Set([400, 401, 403, 404]);

/**
 * Pure: what an ISO+ membership lookup means for the request.
 *
 * A lookup that could not be completed is deliberately NOT a 403. Telling a
 * client they lack permission because ISO+ was down sends them to their account
 * manager over an outage; 502 names what actually happened, and neither answer
 * leaks anything about the workspace.
 */
export function classifyMembership({ role, status } = {}) {
  if (role) return { allowed: true };
  if (!status || status === 200 || REFUSAL_STATUSES.has(status)) {
    return { allowed: false, status: 403, message: 'This User does not have permission to access Workspace.' };
  }
  return { allowed: false, status: 502, message: 'Could not verify workspace access. Please try again.' };
}

/**
 * Guard for a route that reads or writes one workspace's own data.
 *
 * Returns true when the request may proceed; otherwise it has already answered
 * and the handler must return. Same shape as requireOwnerOrSupportAdmin, so the
 * two read alike at the call site.
 *
 * `deps` exists so the lookup can be substituted in a test without reaching for
 * the network layer.
 */
export async function requireWorkspaceMember(req, res, workspaceId, deps = {}) {
  const lookup = deps.getMemberRole ?? getMemberRole;
  const offline = deps.isOfflineMode ?? isOfflineMode;

  if (PORTAL_STAFF_ROLES.has(req.user?.role)) return true;

  // Offline there is exactly one user, no ISO+ to ask, and getMemberRoleOffline
  // answers null for everyone — so asking would lock local development out of
  // its own workspaces. Safe as a bypass because isOfflineMode() is false in
  // production unconditionally, whatever ISOPLUS_OFFLINE says.
  if (offline()) return true;

  const outcome = classifyMembership(
    await lookup(req.session?.Authorization, workspaceId, req.user?.email, { limit: 100 }),
  );
  if (outcome.allowed) return true;

  warn(LOG_SCOPE, 'Refused a workspace the caller is not a member of', {
    workspaceId,
    userId: req.user?.userId,
    role: req.user?.role,
    status: outcome.status,
  }, req ?? null);
  res.status(outcome.status).json({ message: outcome.message });
  return false;
}
