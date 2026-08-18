"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { applyXeroOAuthReturn } from "@/lib/xero-oauth-return";

export function XeroOAuthReturnListener() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    applyXeroOAuthReturn(searchParams, {
      showSuccessToast,
      showErrorToast,
      replace: (href) => router.replace(href),
      pathname,
    });
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
