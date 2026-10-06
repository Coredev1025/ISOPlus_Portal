"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Spinner from "@/components/ui/spin";

export default function XeroIntegrationRedirectPage() {
  const router = useRouter();
  const pathname = usePathname();
  const workspaceId = pathname.split("/")[2];

  useEffect(() => {
    if (!workspaceId) return;
    router.replace(
      `/workspace/${workspaceId}/finance-settings?tab=accounting`
    );
  }, [router, workspaceId]);

  return (
    <div className="flex min-h-screen items-center justify-center gap-2 text-muted-foreground">
      <Spinner />
      <span>Redirecting to Finance Settings…</span>
    </div>
  );
}
