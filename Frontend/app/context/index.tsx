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

export interface Board {
    id: string;
    name: string;
    label: string
}


interface ContextProps {
    user: User;
    setUser: Dispatch<SetStateAction<User>>;
    workspaces: Workspace[];
    setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
    boards: Board[];
    setBoards: Dispatch<SetStateAction<Board[]>>;
}

export const Context = createContext<ContextProps | null>(null);

export function ContextProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User>({
        id: "",
        name: "",
        email: "",
        avatar: "",
        role: "user"
    });
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [boards, setBoards] = useState<Board[]>([]);

    useEffect(() => {
        const currentUser = window.localStorage.getItem("user");
        const savedWorkspace = JSON.parse(window.localStorage.getItem('workspace') || '[]');
        const savedBoard = JSON.parse(window.localStorage.getItem('board') || '[]');

        if (currentUser) {
            setUser(JSON.parse(currentUser));
        }
        if (savedWorkspace) {
            setWorkspaces(savedWorkspace);
        }
        if (savedWorkspace) {
            setBoards(savedBoard);
        }
    }, []);

    useEffect(() => {
        if (user.id != "") {
            window.localStorage.setItem("user", JSON.stringify(user));
        }
        if (workspaces.length) {
            window.localStorage.setItem('workspace', JSON.stringify(workspaces));
        }
        if (boards.length) {
            window.localStorage.setItem('board', JSON.stringify(boards));
        }
    }, [user, workspaces, boards]);

    return (
        <Context.Provider value={{ user, setUser, workspaces, setWorkspaces, boards, setBoards }}>
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