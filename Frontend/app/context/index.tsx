"use client"

import React, { createContext, useState, Dispatch, SetStateAction, ReactNode, useContext, useEffect } from 'react';

export interface User {
    id: string;
    name: string;
    email: string;
    avatar?: string;
    role: string;
}

export interface Workspace {
    id: number;
    name: string;
    owner_id: number;
    photo_url: string;
    subscription_id: number;
    user_role: string;
}

export interface SyncStatus {
    boardId: string;
    boardName: string;
    status: 'started' | 'in-progress' | 'completed' | 'failed' | 'timeout';
    syncType: string;
    startTime: string;
    duration?: number;
    progress?: {
        currentPage?: number;
        totalPages?: number;
        currentFolder?: string;
        foldersProcessed?: number;
        totalFolders?: number;
    };
    counters?: {
        itemsProcessed?: number;
        itemsInserted?: number;
        itemsUpdated?: number;
        itemsSkipped?: number;
    };
    isManualSync?: boolean;
    error?: {
        message: string;
        stack?: string | null;
        details?: any | null;
    } | null;
}

interface ContextProps {
    user: User;
    setUser: Dispatch<SetStateAction<User>>;
    workspaces: Workspace[];
    setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
    syncStatuses: SyncStatus[];
    setSyncStatuses: Dispatch<SetStateAction<SyncStatus[]>>;
    currentWorkspaceId: string | null;
    setCurrentWorkspaceId: Dispatch<SetStateAction<string | null>>;
}

export const Context = createContext<ContextProps | null>(null);

export function ContextProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User>({
        id: "",
        name: "",
        email: "",
        avatar: "",
        role: "isoplus_user"
    });
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [syncStatuses, setSyncStatuses] = useState<SyncStatus[]>([]);
    const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(null);

    useEffect(() => {
        const currentUser = window.localStorage.getItem("user");
        const savedWorkspace = JSON.parse(window.localStorage.getItem('workspace') || '[]');

        if (currentUser) {
            setUser(JSON.parse(currentUser));
        }
        if (savedWorkspace) {
            setWorkspaces(savedWorkspace);
        }
    }, []);

    useEffect(() => {
        if (user.id != "") {
            window.localStorage.setItem("user", JSON.stringify(user));
        }
        if (workspaces.length) {
            window.localStorage.setItem('workspace', JSON.stringify(workspaces));
        }
    }, [user, workspaces]);

    return (
        <Context.Provider value={{ 
            user, 
            setUser, 
            workspaces, 
            setWorkspaces,
            syncStatuses,
            setSyncStatuses,
            currentWorkspaceId,
            setCurrentWorkspaceId
        }}>
            {children}
        </Context.Provider>
    );
}

export const useAppContext = () => {
    const context = useContext(Context);
    if (!context) {
        throw new Error("useAppContext must be used within a ContextProvider");
    }
    return context;
};