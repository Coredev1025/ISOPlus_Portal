"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Link from "next/link";
import Image from "next/image";
import { useState, useEffect, useCallback } from "react";
import axios from "@/app/utils/axiosConfig";
import { verifySession } from "./utils/cookies";
import { useAppContext } from "@/app/context/index";
import Spinner from "@/components/ui/spin";
import { showSuccessToast, showErrorToast } from "@/lib/toast-utils";
import {
  captureAuthFailure,
  captureAuthMessage,
  captureAuthStep,
} from "@/lib/auth-sentry";

const exchangedTickets = new Set<string>();

function hasOAuthTicketInUrl(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(new URLSearchParams(window.location.search).get("ticket"));
}

export default function LoginPage() {
  const router = useRouter();
  const { setUser, setWorkspaces } = useAppContext();
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(hasOAuthTicketInUrl);

  useEffect(() => {
    let cancelled = false;

    const cleanUrl = () =>
      window.history.replaceState({}, "", window.location.pathname);

    const redeemTicket = async (ticket: string) => {
      if (exchangedTickets.has(ticket)) return;
      exchangedTickets.add(ticket);
      setIsLoading(true);
      captureAuthStep(
        "oauth_ticket_exchange",
        "ticket_redeem_start",
        "Client redeeming OAuth ticket"
      );
      try {
        const response = await axios.post(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/oauth-exchange`,
          { ticket },
          { withCredentials: true }
        );
        if (response.status === 200) {
          captureAuthStep(
            "oauth_ticket_exchange",
            "ticket_redeem_ok",
            "Client OAuth ticket exchange succeeded"
          );
          setUser(response.data.user);
          showSuccessToast("Login successful");
          cleanUrl();
          router.push("/dashboard");
          return;
        }
      } catch (err: any) {
        const status = err.response?.status;
        const retryable =
          status === 409 ||
          err.response?.data?.retryable === true ||
          (status != null && status !== 401 && status !== 400);
        if (retryable) {
          exchangedTickets.delete(ticket);
        }

        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          console.error("OAuth ticket exchange failed:", err);
          captureAuthFailure("oauth_ticket_exchange", err, {
            stage: "ticket_redeem",
            httpStatus: status,
            message: err.response?.data?.message,
            retryable,
          });
          showErrorToast("OAuth login failed", {
            description:
              err.response?.data?.message || "An error occurred during OAuth login",
          });
        }
        if (!retryable) cleanUrl();
        setIsLoading(false);
      }
    };

    const params = new URLSearchParams(window.location.search);
    const ticket = params.get("ticket");
    const loginError = params.get("login");
    const loginReason = params.get("reason");

    if (ticket) {
      setIsLoading(true);
      redeemTicket(ticket);
      return () => {
        cancelled = true;
      };
    }

    if (loginError === "error") {
      const reasonDescriptions: Record<string, string> = {
        state_expired:
          "Sign-in timed out. Please click Sign in again (do not refresh the callback page).",
        state_missing: "Sign-in security check failed. Please try again.",
        state_invalid:
          "Sign-in security check failed. Please start login again from this Portal.",
        missing_code: "Google did not return an authorization code. Please try again.",
        token_exchange: "Could not complete sign-in with Google. Please try again.",
        unverified_email: "Your Google account email is not verified. Please verify it and try again.",
        group_denied:
          "Your account is not assigned to the required Workspace access group.",
        not_configured: "Support admin Google sign-in is not configured on this environment.",
        server_error: "Something went wrong during sign-in. Please try again.",
        profile_fetch: "Could not load your ISO+ profile. Please try again.",
      };
      const description =
        (loginReason && reasonDescriptions[loginReason]) ||
        "Authentication failed. Please try again.";

      captureAuthMessage(
        "oauth_ticket_exchange",
        "OAuth login failed: redirected with login=error",
        { stage: "oauth_callback_redirect", reason: loginReason || "unknown" }
      );
      showErrorToast("Sign-in failed", { description });
      cleanUrl();
    }

    const checkToken = async () => {
      try {
        setIsLoading(true);
        const valid = await verifySession();
        if (cancelled) return;

        if (
          valid &&
          typeof valid === "object" &&
          "status" in valid &&
          valid.status === 200 &&
          valid.data?.user
        ) {
          setUser(valid.data.user);
          router.push("/dashboard");
        } else {
          if (cancelled) return;
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
        }
      } catch (err: any) {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          console.error("Token verification failed:", err);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    checkToken();

    return () => {
      cancelled = true;
    };
  }, [router, setUser, setWorkspaces]);

  const handleGoogleSupportLogin = useCallback(async () => {
    setIsLoading(true);
    setError("");
    captureAuthStep(
      "google_support_oauth_redirect",
      "redirect_start",
      "Client requesting Google support OAuth redirect URI"
    );
    try {
      const redirectUrl = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/google/redirect`
      );

      if (redirectUrl.status === 200 && redirectUrl.data?.redirect_uri) {
        captureAuthStep(
          "google_support_oauth_redirect",
          "redirect_navigate",
          "Client navigating to Google authorization endpoint"
        );
        window.location.href = redirectUrl.data.redirect_uri;
        return;
      }
      captureAuthMessage(
        "google_support_oauth_redirect",
        "Google OAuth redirect failed: missing redirect_uri in response",
        { stage: "redirect_missing_uri", httpStatus: redirectUrl.status }
      );
      setIsLoading(false);
    } catch (err: any) {
      if (err.name !== "CanceledError" && err.name !== "AbortError") {
        console.error("Failed to initiate Google support login:", err);
        captureAuthFailure("google_support_oauth_redirect", err, {
          stage: "redirect_uri_fetch",
          httpStatus: err.response?.status,
          message: err.response?.data?.message,
        });
        showErrorToast("Google sign-in unavailable", {
          description:
            err.response?.data?.message ||
            "Support admin Google sign-in is not configured.",
        });
      }
      setIsLoading(false);
    }
  }, []);

  const handleISOPlusLogin = useCallback(async () => {
    setIsLoading(true);
    setError("");
    captureAuthStep(
      "isoplus_oauth_redirect",
      "redirect_start",
      "Client requesting ISO+ OAuth redirect URI"
    );
    try {
      const redirectUrl = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/isoplus/redirect`,
        {
          headers: { 'X-API-Version': '2025-02-26.morava' },
        }
      );

      if (redirectUrl.status === 200 && redirectUrl.data?.redirect_uri) {
        captureAuthStep(
          "isoplus_oauth_redirect",
          "redirect_navigate",
          "Client navigating to ISO+ authorization endpoint"
        );
        window.location.href = redirectUrl.data.redirect_uri;
        return;
      }
      captureAuthMessage(
        "isoplus_oauth_redirect",
        "OAuth redirect failed: missing redirect_uri in response",
        { stage: "redirect_missing_uri", httpStatus: redirectUrl.status }
      );
      setIsLoading(false);
    } catch (err: any) {
      if (err.name !== "CanceledError" && err.name !== "AbortError") {
        console.error("Failed to initiate OAuth login:", err);
        captureAuthFailure("isoplus_oauth_redirect", err, {
          stage: "redirect_uri_fetch",
          httpStatus: err.response?.status,
          message: err.response?.data?.message,
        });
        showErrorToast("OAuth redirect failed", { description: err.response?.data?.message || "Failed to initiate OAuth login" });
      }
      setIsLoading(false);
    }
  }, []);

  return (
    <div className="relative min-h-screen bg-background flex items-center justify-center p-4 sm:p-8 overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,hsl(var(--primary)/0.12),transparent)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-24 top-1/4 h-72 w-72 rounded-full bg-secondary/15 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -left-24 bottom-1/4 h-64 w-64 rounded-full bg-primary/10 blur-3xl"
        aria-hidden
      />
      <Card className="relative w-full max-w-md border border-border/80 bg-card/90 p-8 shadow-xl backdrop-blur-sm sm:p-10">
        <div className="space-y-6">
          <div className="text-center space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              ISO+™ Portal
            </h1>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              Sign in with your ISO+™ account
            </p>
            <div className="flex items-center justify-center pt-2">
              <Image
                src="/assets/logo_rgb_black.png"
                alt="ISO+ Logo"
                width={140}
                height={140}
                className="mx-auto dark:hidden"
                priority
              />
              <Image
                src="/assets/logo_rgb_white.png"
                alt="ISO+ Logo"
                width={140}
                height={140}
                className="mx-auto hidden dark:block"
                priority
              />
            </div>
          </div>
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <Button
            onClick={handleISOPlusLogin}
            className="w-full gap-2 font-semibold shadow-md shadow-primary/10"
            size="lg"
            disabled={isLoading}
          >
            {isLoading ? "Signing in…" : "Sign in with ISO+™"}
            {isLoading && <Spinner />}
          </Button>
          <div className="text-center text-sm text-muted-foreground leading-relaxed">
            By continuing, you agree to our{" "}
            <Link
              href="https://www.isoconsultingservices.com.au/iso-terms-of-service/"
              className="text-primary hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Terms of Service
            </Link>
            {" "}and{" "}
            <Link
              href="https://www.isoconsultingservices.com.au/iso-privacy-policy/"
              className="text-primary hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Privacy Policy
            </Link>
          </div>
          <Button
            variant="ghost"
            className="w-full text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={handleGoogleSupportLogin}
            disabled={isLoading}
          >
            Support agent sign-in
          </Button>
        </div>
      </Card>
    </div>
  );
}
