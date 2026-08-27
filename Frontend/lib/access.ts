import {
  PORTAL_STAFF_ROLES,
  ROLE_ISOPLUS_USER,
} from "@/constants/roles";

export type UserLike = {
  id?: string | null;
  role?: string | null;
};

export type WorkspaceLike = {
  user_role?: string | null;
};

/**
 * ISO+ workspace membership roles that may open a board and run board tools
 * (QR / invoice / statement). Finance Settings and Configure Business still use
 * admin/owner via canAccessWorkspace.
 *
 * Touchpoints: lib/access.ts (canAccessBoard), board detail, invoice setup,
 * workspace board list.
 */
export const ISOPLUS_WORKSPACE_MEMBER_ROLES: readonly string[] = [
  "owner",
  "admin",
  "restricted_member",
  "full_member",
  "member",
];

/** Context user starts empty until localStorage hydrates — do not gate on role before this. */
export function isContextUserHydrated(user: UserLike | null | undefined): boolean {
  return typeof user?.id === "string" && user.id.length > 0;
}

export function isOwnerOrSupport(user: UserLike | null | undefined): boolean {
  return PORTAL_STAFF_ROLES.includes(user?.role ?? "");
}

export function isIsoPlusWorkspaceAdminOrOwner(
  user: UserLike | null | undefined,
  workspace: WorkspaceLike | null | undefined
): boolean {
  return (
    user?.role === ROLE_ISOPLUS_USER &&
    (workspace?.user_role === "admin" || workspace?.user_role === "owner")
  );
}

export function isIsoPlusWorkspaceMember(
  user: UserLike | null | undefined,
  workspace: WorkspaceLike | null | undefined
): boolean {
  return (
    user?.role === ROLE_ISOPLUS_USER &&
    ISOPLUS_WORKSPACE_MEMBER_ROLES.includes(workspace?.user_role ?? "")
  );
}

/** Finance Settings / Configure Business — portal staff or workspace admin/owner. */
export function canAccessWorkspace(
  user: UserLike | null | undefined,
  workspace: WorkspaceLike | null | undefined
): boolean {
  return isOwnerOrSupport(user) || isIsoPlusWorkspaceAdminOrOwner(user, workspace);
}

/** Board detail and board tools — portal staff or any ISO+ workspace member. */
export function canAccessBoard(
  user: UserLike | null | undefined,
  workspace: WorkspaceLike | null | undefined
): boolean {
  return isOwnerOrSupport(user) || isIsoPlusWorkspaceMember(user, workspace);
}

export function isCareManagementLabel(label: unknown): boolean {
  return typeof label === "string" && label.startsWith("Care Management");
}

export function isLowCatCareManagementLabel(label: unknown): boolean {
  return label === "Care Management - SaH - Low Cat";
}
