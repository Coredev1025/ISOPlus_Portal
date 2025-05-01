"use client";

import { useAppContext } from "@/app/context";
import { getCookie, isTokenValid } from "@/app/utils/cookies";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import axios from "axios";

export function Header() {
  const router = useRouter();
  const { user, setUser, setWorkspaces } = useAppContext();

  useEffect(() => {
    const abortController = new AbortController();

    const checkToken = async () => {
      const token = getCookie('token');
      if (token) {
        try {
          const valid = await isTokenValid(token, abortController.signal);
          if (!abortController.signal.aborted && valid.status === 200) {
            setUser(valid.data.user);
          } else if (!abortController.signal.aborted) {
            document.cookie = `token=; path=/; max-age=0; secure; samesite=strict`;
            document.cookie = `Authorization=; path=/; max-age=0; secure; samesite=strict`;
            setUser({
              id: "",
              name: "",
              email: "",
              avatar: "",
              role: "user"
            });
            setWorkspaces([]);
            router.push("/");
          }
        } catch (error) {
          if (!axios.isCancel(error)) {
            console.error('Token verification failed:', error);
          }
        }
      }
    };

    checkToken();

    return () => {
      abortController.abort();
    };
  }, [router]);

  const handleLogout = () => {
    document.cookie = `token=; path=/; max-age=0; secure; samesite=strict`;
    document.cookie = `Authorization=; path=/; max-age=0; secure; samesite=strict`;
    localStorage.removeItem("user");
    localStorage.removeItem("workspace");
    localStorage.removeItem("board");
    setUser({
      id: "",
      name: "",
      email: "",
      avatar: "",
      role: "user"
    });
    setWorkspaces([]);
    router.push("/");
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <span className="text-lg font-semibold">ISO+ Portal</span>
        <div className="flex items-center justify-center">
          <svg
            className="h-8 dark:hidden"
            xmlns="http://www.w3.org/2000/svg"
            width="192"
            height="192"
            version="1"
            viewBox="0 0 144 144"
          >
            {/* SVG paths and shapes */}
            <path d="M81.5 19.9c-8.9 2.4-15.5 7.4-19.6 14.6-1.7 3-3.6 5.5-4.3 5.5-1.5 0-5.9 4.6-7.6 8l-1.3 2.4 3.2-2.7c1.8-1.4 5-3.2 7.3-3.9 3.1-.9 4.4-2 5.4-4.4 2-4.7 6.1-9.2 10.8-11.7 3.1-1.6 5.8-2.2 11.6-2.2 6.4 0 8.2.4 12.2 2.8 7 4.1 10.3 9.2 12.3 18.8.4 2.2 1.2 2.8 4.2 3.4 4.6.8 9 4.7 9.8 8.7.5 2.2 1.8 3.4 5.1 5 6.5 3 8.9 6.9 8.9 14.3 0 4.6-.5 6.7-2.2 9.1-4.2 5.8-6.8 6.4-29.5 6.4H87.5l-1.7 3-1.7 3h22.3c21.8 0 22.3-.1 27.3-2.5 3-1.5 6.1-4.1 7.7-6.3 2.3-3.4 2.6-4.7 2.6-12.6 0-10.5-1.7-14.2-8.5-18.1-2.5-1.5-4.8-3.8-5.5-5.5-1.5-3.6-7.1-8.7-10.5-9.6-1.8-.4-2.8-1.6-3.5-4.3-2.2-8.2-9.4-16.1-18.1-19.8-3.6-1.6-12.8-2.3-16.4-1.4M0 54.1c0 3.3.3 5.9.8 5.7C8.7 56 9 55.7 9 51.8V48H0zM20.2 50.1c-5 2.5-7.5 6.7-7.5 12.4 0 7.1 2.4 10 11.8 14.5 8.3 4 10.5 6 10.5 9.8 0 2.5-3.1 5.2-5.9 5.2-3.7 0-6-1.9-6.7-5.5-.6-3.5-.6-3.5-6.1-3.5h-5.5l.6 3.7C13.2 96.8 24.1 102.9 35 100c8-2.1 12.2-9 10.6-17.4-1-5.3-3.9-8.1-13.1-12.6s-10.7-6.5-8-10.6c2.4-3.8 7.5-3 9.5 1.3 1.4 3.1 1.8 3.3 6.9 3.3h5.4l-.7-3.3c-1.4-7.2-7.2-11.9-15.3-12.4-4.5-.3-6.8.1-10.1 1.8"></path>
            <path d="M58.3 50.1c-7.3 3.6-8.7 7.2-9.1 22.9-.3 12.5-.1 13.8 2 18 5.3 10.4 18.8 12.9 27.9 5.3 5-4.2 5.9-7.7 5.9-22.1 0-11.5-.2-13.4-2.3-17.3-4.3-8.2-15.4-11.3-24.4-6.8m12.3 7.7C73.2 59.5 74 63.4 74 75c0 11.5-.1 12.2-2.5 14.5-3.1 3.2-5.9 3.2-9 0-2.4-2.3-2.5-3-2.5-14.5 0-14.8 1.2-18 7-18 1.4 0 3 .4 3.6.8M4.2 60.6 0 64.2V100h9V78.5C9 66.7 8.9 57 8.7 57s-2.2 1.6-4.5 3.6M102.7 57.7c-.4.3-.7 3.3-.7 6.5V70H90v7h12v12h7V77h12v-7h-12v-6.5c0-6.5 0-6.5-2.8-6.5-1.6 0-3.2.3-3.5.7"></path>
          </svg>
          <svg
            className="h-8 hidden dark:block"
            xmlns="http://www.w3.org/2000/svg"
            width="192"
            height="192"
            version="1"
            viewBox="0 0 144 144"
            fill="white"
          >
            {/* SVG paths and shapes */}
            <path d="M81.5 19.9c-8.9 2.4-15.5 7.4-19.6 14.6-1.7 3-3.6 5.5-4.3 5.5-1.5 0-5.9 4.6-7.6 8l-1.3 2.4 3.2-2.7c1.8-1.4 5-3.2 7.3-3.9 3.1-.9 4.4-2 5.4-4.4 2-4.7 6.1-9.2 10.8-11.7 3.1-1.6 5.8-2.2 11.6-2.2 6.4 0 8.2.4 12.2 2.8 7 4.1 10.3 9.2 12.3 18.8.4 2.2 1.2 2.8 4.2 3.4 4.6.8 9 4.7 9.8 8.7.5 2.2 1.8 3.4 5.1 5 6.5 3 8.9 6.9 8.9 14.3 0 4.6-.5 6.7-2.2 9.1-4.2 5.8-6.8 6.4-29.5 6.4H87.5l-1.7 3-1.7 3h22.3c21.8 0 22.3-.1 27.3-2.5 3-1.5 6.1-4.1 7.7-6.3 2.3-3.4 2.6-4.7 2.6-12.6 0-10.5-1.7-14.2-8.5-18.1-2.5-1.5-4.8-3.8-5.5-5.5-1.5-3.6-7.1-8.7-10.5-9.6-1.8-.4-2.8-1.6-3.5-4.3-2.2-8.2-9.4-16.1-18.1-19.8-3.6-1.6-12.8-2.3-16.4-1.4M0 54.1c0 3.3.3 5.9.8 5.7C8.7 56 9 55.7 9 51.8V48H0zM20.2 50.1c-5 2.5-7.5 6.7-7.5 12.4 0 7.1 2.4 10 11.8 14.5 8.3 4 10.5 6 10.5 9.8 0 2.5-3.1 5.2-5.9 5.2-3.7 0-6-1.9-6.7-5.5-.6-3.5-.6-3.5-6.1-3.5h-5.5l.6 3.7C13.2 96.8 24.1 102.9 35 100c8-2.1 12.2-9 10.6-17.4-1-5.3-3.9-8.1-13.1-12.6s-10.7-6.5-8-10.6c2.4-3.8 7.5-3 9.5 1.3 1.4 3.1 1.8 3.3 6.9 3.3h5.4l-.7-3.3c-1.4-7.2-7.2-11.9-15.3-12.4-4.5-.3-6.8.1-10.1 1.8"></path>
            <path d="M58.3 50.1c-7.3 3.6-8.7 7.2-9.1 22.9-.3 12.5-.1 13.8 2 18 5.3 10.4 18.8 12.9 27.9 5.3 5-4.2 5.9-7.7 5.9-22.1 0-11.5-.2-13.4-2.3-17.3-4.3-8.2-15.4-11.3-24.4-6.8m12.3 7.7C73.2 59.5 74 63.4 74 75c0 11.5-.1 12.2-2.5 14.5-3.1 3.2-5.9 3.2-9 0-2.4-2.3-2.5-3-2.5-14.5 0-14.8 1.2-18 7-18 1.4 0 3 .4 3.6.8M4.2 60.6 0 64.2V100h9V78.5C9 66.7 8.9 57 8.7 57s-2.2 1.6-4.5 3.6M102.7 57.7c-.4.3-.7 3.3-.7 6.5V70H90v7h12v12h7V77h12v-7h-12v-6.5c0-6.5 0-6.5-2.8-6.5-1.6 0-3.2.3-3.5.7"></path>
          </svg>
        </div>

        <div className="flex items-center gap-4">
          <ThemeToggle />

          <Avatar className="h-8 w-8">
            <AvatarFallback>
              {user.avatar ? <img src={`${user.avatar}`} alt="" width={100} height={100} /> : user.name && user.name.trim() !== ''
                ? user.name.split(' ').map(n => n[0]).join('')
                : 'N/A'}
            </AvatarFallback>
          </Avatar>

          <Button
            variant="ghost"
            size="icon"
            onClick={handleLogout}
            className="text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </header>
  );
}