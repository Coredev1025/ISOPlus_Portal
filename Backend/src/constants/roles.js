/**
 * Who a session belongs to.
 *
 * These three strings are the `role` enum on `models/User.js` and the value
 * `middleware/auth.js` puts on `req.user`. They were written as bare literals
 * at every gate, which is how the same predicate came to exist three times —
 * `middleware/requireOwnerOrSupport.js` spelled it inline, and
 * `utils/workspaceAccessHelpers.js` kept its own private Set of the same two
 * values. A gate that disagrees with another gate about who is staff is an
 * access-control bug that reads like a typo, so there is one list now.
 *
 * This file imports nothing, deliberately: `models/User.js` reads it for its
 * schema enum, and middleware reads it too, so anything imported here could
 * close a cycle.
 *
 * Touchpoints: middleware/requireOwnerOrSupport.js (System Health + Bull Board),
 * utils/workspaceAccessHelpers.js (PORTAL_STAFF_ROLES consumers).
 * Mirrored client-side by `Frontend/constants/roles.ts`, which the button
 * gating reads — the two must agree or a control appears that the API refuses.
 */
export const ROLE_ISOPLUS_USER = 'isoplus_user';
export const ROLE_SUPPORT_ADMIN = 'support_admin';
export const ROLE_OWNER = 'owner';

/**
 * Portal staff, who are not ISO+ members of the client workspaces they
 * support. `applyPrivilegedSessionAuth` hands them the personal access token
 * for exactly that reason, so a membership check would take away access they
 * are meant to have. This is the same split `middleware/auth.js` makes.
 *
 * A Set, therefore a shared mutable — read-only by convention; nothing freezes
 * it.
 *
 * Touchpoints: middleware/requireOwnerOrSupport.js,
 * utils/workspaceAccessHelpers.js.
 */
export const PORTAL_STAFF_ROLES = new Set([ROLE_OWNER, ROLE_SUPPORT_ADMIN]);
