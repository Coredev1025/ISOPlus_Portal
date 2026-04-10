"use client";

import { useAppContext } from "@/app/context";
import { verifySession } from "@/app/utils/cookies";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { SyncStatusIndicator } from "@/components/ui/sync-status-indicator";
import { LogOut } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import axios from "@/app/utils/axiosConfig";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function Header() {
  const router = useRouter();
  const { user, setUser, setWorkspaces } = useAppContext();

  useEffect(() => {
    let cancelled = false;

    const checkToken = async () => {
      try {
        const valid = await verifySession();
        if (cancelled) return;

        if (valid && typeof valid === "object" && "status" in valid && valid.status === 200) {
          setUser(valid.data.user);
        } else {
          setUser({
            id: "",
            name: "",
            email: "",
            avatar: "",
            role: "isoplus_user"
          });
          setWorkspaces([]);
          router.push("/");
        }
      } catch (error: any) {
        if (error.name !== "CanceledError" && error.name !== "AbortError") {
          console.error("Token verification failed:", error);
        }
      }
    };

    checkToken();

    return () => {
      cancelled = true;
    };
  }, [router, setUser, setWorkspaces]);

  const handleLogout = () => {
    axios.post(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/logout`, {})
      .then(() => {
        localStorage.removeItem("user");
        localStorage.removeItem("workspace");
        localStorage.removeItem("board");
        setUser({
          id: "",
          name: "",
          email: "",
          avatar: "",
          role: "isoplus_user"
        });
        setWorkspaces([]);
        router.push("/");
      })
  };

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b border-border/80 bg-background/90 shadow-sm backdrop-blur-md supports-[backdrop-filter]:bg-background/75">
        <div className="container mx-auto flex h-14 sm:h-16 items-center gap-3 px-4 sm:px-6">
          <Link
            href="/dashboard"
            className="flex min-w-0 flex-1 items-center gap-3 text-left transition-opacity hover:opacity-90"
          >
            <span className="truncate text-base font-semibold tracking-tight text-foreground sm:text-lg">
              ISO+™ Portal
            </span>
          </Link>

          <a
            href="https://app.isoplus.online/home"
            target="_blank"
            rel="noopener noreferrer"
            className="flex shrink-0 items-center rounded-md p-1 ring-offset-background transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="Open ISO+ app"
          >
            <img
              src="/assets/logo_rgb_black.png"
              alt=""
              className="h-7 w-auto dark:hidden sm:h-8"
            />
            <img
              src="/assets/logo_rgb_white.png"
              alt=""
              className="hidden h-7 w-auto dark:block sm:h-8"
            />
          </a>

          <TooltipProvider delayDuration={300}>
            <div className="flex flex-1 items-center justify-end gap-1 sm:gap-2">
              <ThemeToggle />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Avatar className="h-8 w-8 border border-border/60">
                    <AvatarFallback className="text-xs font-medium">
                      {user.avatar ? (
                        <img src={`${user.avatar}`} alt="" width={32} height={32} className="h-full w-full object-cover" />
                      ) : user.name && user.name.trim() !== "" ? (
                        user.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")
                          .slice(0, 2)
                          .toUpperCase()
                      ) : (
                        "?"
                      )}
                    </AvatarFallback>
                  </Avatar>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end" className="max-w-[240px]">
                  <p className="font-medium">{user.name || "Signed in"}</p>
                  {user.email ? (
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                  ) : null}
                </TooltipContent>
              </Tooltip>

              <Button
                variant="ghost"
                size="icon"
                onClick={handleLogout}
                className="text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Sign out"
              >
                <LogOut className="h-5 w-5" />
              </Button>
            </div>
          </TooltipProvider>
        </div>
      </header>
      <SyncStatusIndicator />
    </>
  );
}