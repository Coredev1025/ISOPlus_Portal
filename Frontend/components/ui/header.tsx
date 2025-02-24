"use client";

import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

export function Header() {
  const router = useRouter();

  const handleLogout = () => {
    // In a real app, you would handle logout logic here
    // For now, we'll just redirect to the login page
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