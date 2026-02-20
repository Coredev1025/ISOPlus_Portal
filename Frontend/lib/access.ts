export type UserLike = {
  role?: string | null;
};

export type WorkspaceLike = {
  user_role?: string | null;
};

export function isOwnerOrSupport(user: UserLike | null | undefined): boolean {
  return user?.role === "owner" || user?.role === "support_admin";
}

export function isIsoPlusWorkspaceAdminOrOwner(
  user: UserLike | null | undefined,
  workspace: WorkspaceLike | null | undefined
): boolean {
  return (
    user?.role === "isoplus_user" &&
    (workspace?.user_role === "admin" || workspace?.user_role === "owner")
  );
}

export function canAccessWorkspace(
  user: UserLike | null | undefined,
  workspace: WorkspaceLike | null | undefined
): boolean {
  return isOwnerOrSupport(user) || isIsoPlusWorkspaceAdminOrOwner(user, workspace);
}

export function isCareManagementLabel(label: unknown): boolean {
  return typeof label === "string" && label.startsWith("Care Management");
}

export function isLowCatCareManagementLabel(label: unknown): boolean {
  return label === "Care Management - SaH - Low Cat";
}

