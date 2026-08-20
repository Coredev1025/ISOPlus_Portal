"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { applyXeroOAuthReturn } from "@/lib/xero-oauth-return";

function XeroOAuthReturnListener() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    applyXeroOAuthReturn(searchParams, pathname, (href) => router.replace(href));
  }, [pathname, router, searchParams]);

  return null;
}

export function XeroOAuthReturnBoundary() {
  return (
    <Suspense fallback={null}>
      <XeroOAuthReturnListener />
    </Suspense>
  );
}
