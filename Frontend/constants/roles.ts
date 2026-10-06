/**
 * Who a session belongs to, client-side.
 *
 * The mirror of `Backend/src/constants/roles.js`. It is a second copy across a
 * network boundary rather than a second source of truth: the backend's gate is
 * what actually refuses a request, and this list only decides whether a control
 * is worth rendering. They must still agree — a button shown to a role the API
 * will 403 is a worse experience than no button at all.
 *
 * Touchpoints: lib/access.ts (`isOwnerOrSupport`, which gates the System Health
 * entry point on the dashboard).
 */
export const ROLE_ISOPLUS_USER = "isoplus_user";
export const ROLE_SUPPORT_ADMIN = "support_admin";
export const ROLE_OWNER = "owner";

/**
 * Portal staff — the roles that may see every client's data. Mirrors
 * `PORTAL_STAFF_ROLES` in `Backend/src/constants/roles.js`.
 *
 * Read-only by convention; nothing freezes it.
 *
 * Touchpoints: lib/access.ts.
 */
export const PORTAL_STAFF_ROLES: readonly string[] = [
  ROLE_OWNER,
  ROLE_SUPPORT_ADMIN,
];
