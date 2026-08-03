import { describe, it, expect } from 'vitest';
import {
  isOwnerOrSupport,
  isIsoPlusWorkspaceAdminOrOwner,
  canAccessWorkspace,
  isCareManagementLabel,
  isLowCatCareManagementLabel,
} from '@/lib/access';

describe('isOwnerOrSupport', () => {
  it('returns true for owner and support_admin', () => {
    expect(isOwnerOrSupport({ role: 'owner' })).toBe(true);
    expect(isOwnerOrSupport({ role: 'support_admin' })).toBe(true);
  });

  it('returns false for other roles, null, undefined', () => {
    expect(isOwnerOrSupport({ role: 'isoplus_user' })).toBe(false);
    expect(isOwnerOrSupport(null)).toBe(false);
    expect(isOwnerOrSupport(undefined)).toBe(false);
    expect(isOwnerOrSupport({})).toBe(false);
  });
});

describe('isIsoPlusWorkspaceAdminOrOwner', () => {
  it('returns true for isoplus_user with workspace user_role admin/owner', () => {
    expect(
      isIsoPlusWorkspaceAdminOrOwner({ role: 'isoplus_user' }, { user_role: 'admin' })
    ).toBe(true);
    expect(
      isIsoPlusWorkspaceAdminOrOwner({ role: 'isoplus_user' }, { user_role: 'owner' })
    ).toBe(true);
  });

  it('returns false when role is not isoplus_user', () => {
    expect(
      isIsoPlusWorkspaceAdminOrOwner({ role: 'owner' }, { user_role: 'admin' })
    ).toBe(false);
  });

  it('returns false when workspace role is not admin/owner', () => {
    expect(
      isIsoPlusWorkspaceAdminOrOwner({ role: 'isoplus_user' }, { user_role: 'viewer' })
    ).toBe(false);
  });

  it('returns false when user or workspace is missing', () => {
    expect(isIsoPlusWorkspaceAdminOrOwner(null, null)).toBe(false);
  });
});

describe('canAccessWorkspace', () => {
  it('returns true for portal owner role', () => {
    expect(canAccessWorkspace({ role: 'owner' }, null)).toBe(true);
  });

  it('returns true for isoplus_user with workspace admin role', () => {
    expect(
      canAccessWorkspace({ role: 'isoplus_user' }, { user_role: 'admin' })
    ).toBe(true);
  });

  it('returns false for isoplus_user without privileged workspace role', () => {
    expect(
      canAccessWorkspace({ role: 'isoplus_user' }, { user_role: 'viewer' })
    ).toBe(false);
  });
});

describe('isCareManagementLabel', () => {
  it('returns true for strings starting with Care Management', () => {
    expect(isCareManagementLabel('Care Management - NDIS')).toBe(true);
    expect(isCareManagementLabel('Care Management')).toBe(true);
  });

  it('returns false for non-matching strings and non-strings', () => {
    expect(isCareManagementLabel('Care')).toBe(false);
    expect(isCareManagementLabel('')).toBe(false);
    expect(isCareManagementLabel(null)).toBe(false);
    expect(isCareManagementLabel(undefined)).toBe(false);
    expect(isCareManagementLabel(123)).toBe(false);
  });
});

describe('isLowCatCareManagementLabel', () => {
  it('returns true only for the exact Low Cat label', () => {
    expect(isLowCatCareManagementLabel('Care Management - SaH - Low Cat')).toBe(true);
  });

  it('returns false for everything else', () => {
    expect(isLowCatCareManagementLabel('Care Management - SaH - High Cat')).toBe(false);
    expect(isLowCatCareManagementLabel('Care Management')).toBe(false);
    expect(isLowCatCareManagementLabel('')).toBe(false);
    expect(isLowCatCareManagementLabel(null)).toBe(false);
  });
});
