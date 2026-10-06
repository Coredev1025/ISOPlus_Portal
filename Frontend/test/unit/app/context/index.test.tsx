import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ContextProvider, useAppContext, type SyncStatus, type Workspace } from '@/app/context';

const STORED_USER = {
  id: '68c1f0a1b2c3d4e5f6a7b8c9',
  name: 'Support Admin',
  email: 'support@isoplus.test',
  avatar: 'https://cdn.isoplus.test/avatars/support.png',
  role: 'support_admin',
};

const STORED_WORKSPACES: Workspace[] = [
  {
    id: 1420,
    name: 'Hillsgrade Care',
    user_role: 'admin',
    owner_id: 77,
    photo_url: 'https://cdn.isoplus.test/workspaces/1420.png',
    subscription_id: 9001,
  },
  {
    id: '1421',
    name: 'Hillsgrade NDIS',
    user_role: 'member',
    owner_id: 77,
  },
];

const wrapper = ({ children }: { children: ReactNode }) => <ContextProvider>{children}</ContextProvider>;

describe('ContextProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts with the empty-user defaults when localStorage holds nothing', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    expect(result.current.user).toEqual({
      id: '',
      name: '',
      email: '',
      avatar: '',
      role: 'isoplus_user',
    });
    expect(result.current.workspaces).toEqual([]);
    expect(result.current.syncStatuses).toEqual([]);
    expect(result.current.currentWorkspaceId).toBeNull();
    expect(window.localStorage.getItem('user')).toBeNull();
    expect(window.localStorage.getItem('workspace')).toBeNull();
  });

  it('hydrates user and workspaces from valid stored JSON', () => {
    window.localStorage.setItem('user', JSON.stringify(STORED_USER));
    window.localStorage.setItem('workspace', JSON.stringify(STORED_WORKSPACES));

    const { result } = renderHook(() => useAppContext(), { wrapper });

    expect(result.current.user).toEqual(STORED_USER);
    expect(result.current.workspaces).toHaveLength(2);
    expect(result.current.workspaces[0]).toEqual({
      id: 1420,
      name: 'Hillsgrade Care',
      user_role: 'admin',
      owner_id: 77,
      photo_url: 'https://cdn.isoplus.test/workspaces/1420.png',
      subscription_id: 9001,
    });
    expect(result.current.workspaces[1].id).toBe('1421');
  });

  it('throws while mounting when the stored workspace JSON is corrupt', () => {
    window.localStorage.setItem('workspace', '{not json');
    window.localStorage.setItem('user', JSON.stringify(STORED_USER));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(() => useAppContext(), { wrapper })).toThrow(SyntaxError);
  });

  it('throws while mounting when the stored user JSON is corrupt', () => {
    window.localStorage.setItem('user', '{not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(() => useAppContext(), { wrapper })).toThrow(SyntaxError);
  });

  it('writes the user back to localStorage once it has an id', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => {
      result.current.setUser({
        id: '68c1f0a1b2c3d4e5f6a7b8c9',
        name: 'Support Admin',
        email: 'support@isoplus.test',
        avatar: '',
        role: 'support_admin',
      });
    });

    expect(JSON.parse(window.localStorage.getItem('user') as string)).toEqual({
      id: '68c1f0a1b2c3d4e5f6a7b8c9',
      name: 'Support Admin',
      email: 'support@isoplus.test',
      avatar: '',
      role: 'support_admin',
    });
  });

  it('does not write a user that still has an empty id', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => {
      result.current.setUser({ id: '', name: 'Anonymous', email: '', avatar: '', role: 'isoplus_user' });
    });

    expect(result.current.user.name).toBe('Anonymous');
    expect(window.localStorage.getItem('user')).toBeNull();
  });

  it('writes workspaces back to localStorage when the list is non-empty', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => {
      result.current.setWorkspaces(STORED_WORKSPACES);
    });

    expect(JSON.parse(window.localStorage.getItem('workspace') as string)).toEqual(STORED_WORKSPACES);
  });

  it('does not write an empty workspace list, leaving any stored list in place', () => {
    window.localStorage.setItem('workspace', JSON.stringify(STORED_WORKSPACES));
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => {
      result.current.setWorkspaces([]);
    });

    expect(result.current.workspaces).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem('workspace') as string)).toEqual(STORED_WORKSPACES);
  });

  it('keeps syncStatuses and currentWorkspaceId in memory only', () => {
    const syncStatus: SyncStatus = {
      boardId: '9911',
      boardName: 'Care Management - SaH - Low Cat',
      status: 'in-progress',
      syncType: 'manual',
      startTime: '2026-03-10T04:00:00.000Z',
      isManualSync: true,
      progress: { currentPage: 2, totalPages: 5, itemsProcessed: 120 },
      error: null,
    };

    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => {
      result.current.setSyncStatuses([syncStatus]);
      result.current.setCurrentWorkspaceId('1420');
    });

    expect(result.current.syncStatuses).toEqual([syncStatus]);
    expect(result.current.currentWorkspaceId).toBe('1420');
    expect(window.localStorage.getItem('syncStatuses')).toBeNull();
    expect(window.localStorage.getItem('currentWorkspaceId')).toBeNull();
  });

  it('renders its children', () => {
    render(
      <ContextProvider>
        <span>invoice generator</span>
      </ContextProvider>
    );

    expect(screen.getByText('invoice generator')).toBeInTheDocument();
  });
});

describe('useAppContext', () => {
  it('throws when used outside a ContextProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(() => useAppContext())).toThrow(
      'useAppContext must be used within a ContextProvider'
    );
  });
});
