"use client";

import { useAppContext } from "@/app/context";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, User } from "lucide-react";
import { useRouter } from "next/navigation";

export function Header() {
  const router = useRouter();
  const { user } = useAppContext();

  const handleLogout = () => {
    document.cookie = `token=; path=/; max-age=0; secure; samesite=strict`;
    document.cookie = `Authorization=; path=/; max-age=0; secure; samesite=strict`;
    router.push("/");
  };

  return (
    <header className="border-b bg-card">
      <div className="container mx-auto py-4">
        <div className="flex justify-between items-center">
          <h1 className="text-xl font-semibold">Workspace Manager</h1>

          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 hover:opacity-80">
              <div className="text-right mr-2">
                <p className="text-sm font-medium">{user.name}</p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
              </div>
              <Avatar>
                <AvatarFallback>
                  {user.avatar ? <img src={`${user.avatar}`} alt="" width={100} height={100} /> : user.name && user.name.trim() !== ''
                    ? user.name.split(' ').map(n => n[0]).join('')
                    : 'N/A'}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>My Account</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <User className="mr-2 h-4 w-4" />
                Profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleLogout}>
                <LogOut className="mr-2 h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}