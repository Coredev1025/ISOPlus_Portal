"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import axios from "@/app/utils/axiosConfig";

function XeroSignupCallbackContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Processing your sign-up...");

  useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!code || !state) {
      setStatus("error");
      setMessage("Invalid callback parameters.");
      if (window.opener) {
        window.opener.postMessage(
          { type: "XERO_SIGNUP_ERROR", error: "Invalid callback parameters" },
          window.location.origin
        );
      }
      return;
    }

    const processCallback = async () => {
      try {
        const response = await axios.post(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/subscriptions/xero-callback`,
          { code, state }
        );

        if (response.data.success) {
          setStatus("success");
          setMessage(response.data.message);
          if (window.opener) {
            window.opener.postMessage(
              {
                type: "XERO_SIGNUP_SUCCESS",
                message: response.data.message,
                duplicate: response.data.duplicate || false,
              },
              window.location.origin
            );
          }
        } else {
          setStatus("error");
          setMessage(response.data.message || "Sign-up failed.");
          if (window.opener) {
            window.opener.postMessage(
              { type: "XERO_SIGNUP_ERROR", error: response.data.message },
              window.location.origin
            );
          }
        }
      } catch (err: any) {
        const errorMsg =
          err.response?.data?.message || "An error occurred during sign-up.";
        setStatus("error");
        setMessage(errorMsg);
        if (window.opener) {
          window.opener.postMessage(
            { type: "XERO_SIGNUP_ERROR", error: errorMsg },
            window.location.origin
          );
        }
      }
    };

    processCallback();
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="text-center space-y-4 max-w-md">
        {status === "loading" && (
          <>
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
            <p className="text-muted-foreground">{message}</p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mx-auto">
              <svg className="h-6 w-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm text-muted-foreground">{message}</p>
            <p className="text-xs text-muted-foreground">You can close this window.</p>
          </>
        )}
        {status === "error" && (
          <>
            <div className="h-12 w-12 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center mx-auto">
              <svg className="h-6 w-6 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-sm text-destructive">{message}</p>
            <p className="text-xs text-muted-foreground">You can close this window.</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function XeroSignupCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      }
    >
      <XeroSignupCallbackContent />
    </Suspense>
  );
}
