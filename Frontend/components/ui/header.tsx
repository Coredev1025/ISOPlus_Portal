"use client";

import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

export function Header() {
  const router = useRouter();

  const handleLogout = () => {
    document.cookie = `token=; path=/; max-age=86400; secure; samesite=strict`;
    router.push("/");
  };

  return (
    <header className="border-b bg-background">
      <div className="container mx-auto py-4 flex justify-end">
        <Button 
          variant="ghost" 
          onClick={handleLogout}
          className="text-muted-foreground hover:text-foreground"
        >
          <LogOut className="h-4 w-4 mr-2" />
          Logout
        </Button>
      </div>
    </header>
  );
}