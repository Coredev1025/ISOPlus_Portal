"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import axios from "@/app/utils/axiosConfig";
import Spinner from "@/components/ui/spin";
import { showSuccessToast, showErrorToast } from "@/lib/toast-utils";
import { isTrustedOAuthMessageOrigin } from "@/app/utils/oauthMessageOrigins";

export default function XeroSignupPage() {
  const router = useRouter();
  const [isSigningUp, setIsSigningUp] = useState(false);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!isTrustedOAuthMessageOrigin(event.origin)) return;

      if (event.data?.type === "XERO_SIGNUP_SUCCESS") {
        if (event.data.duplicate) {
          showSuccessToast(event.data.message || "We already have your request.");
        } else {
          showSuccessToast(event.data.message || "Sign-up request received! We'll be in touch.");
        }
        window.removeEventListener("message", handleMessage);
        setIsSigningUp(false);
      } else if (event.data?.type === "XERO_SIGNUP_ERROR") {
        showErrorToast("Sign-up failed", {
          description: event.data.error || "An error occurred",
        });
        window.removeEventListener("message", handleMessage);
        setIsSigningUp(false);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const startXeroSignup = useCallback(async () => {
    setIsSigningUp(true);
    let popup: Window | null = null;

    try {
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/subscriptions/xero-auth-url`
      );

      if (response.status === 200 && response.data.url) {
        const width = 600;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;

        popup = window.open(
          response.data.url,
          "Xero Sign Up",
          `width=${width},height=${height},left=${left},top=${top},status=yes,scrollbars=yes`
        );

        if (!popup) {
          showErrorToast("Popup blocked", {
            description: "Allow popups for this site to sign up with Xero.",
          });
          setIsSigningUp(false);
        }
      }
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { message?: string } } };
      showErrorToast("Sign-up failed", {
        description: ax.response?.data?.message || "Failed to initiate Xero sign-up",
      });
      setIsSigningUp(false);
    }
  }, []);

  return (
    <div className="relative min-h-screen bg-background flex items-center justify-center p-4 sm:p-8 overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,hsl(var(--primary)/0.12),transparent)]"
        aria-hidden
      />
      <Card className="relative w-full max-w-lg border border-border/80 bg-card/90 p-8 shadow-xl backdrop-blur-sm sm:p-10 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Sign up with Xero
          </h1>
          <p className="text-sm text-muted-foreground">
            Request access to ISO+™ Portal using your Xero identity. We collect your name, email, and
            Xero user identifiers from Xero&apos;s ID token after you authorize this app.
          </p>
        </div>

        <ul className="text-sm text-muted-foreground space-y-2 list-disc pl-5 border border-border/60 rounded-lg p-4 bg-muted/20">
          <li>
            <strong className="text-foreground">Manual onboarding.</strong> We do not create an ISO+
            account automatically. Our team will invite you when setup is complete.
          </li>
          <li>
            You will sign in with ISO+ after you receive an invitation.
          </li>
        </ul>

        <div className="flex items-center justify-center py-2">
          <Image
            src="/assets/logo_rgb_black.png"
            alt="ISO+ Logo"
            width={100}
            height={100}
            className="dark:hidden"
            priority
          />
          <Image
            src="/assets/logo_rgb_white.png"
            alt="ISO+ Logo"
            width={100}
            height={100}
            className="hidden dark:block"
            priority
          />
        </div>

        <Button
          onClick={startXeroSignup}
          className="w-full gap-2 font-semibold shadow-md shadow-primary/10 py-6"
          size="lg"
          disabled={isSigningUp}
        >
          Continue with Xero
          {isSigningUp && <Spinner />}
        </Button>

        <p className="text-xs text-center text-muted-foreground">
          Uses OpenID Connect scopes <code className="text-xs bg-muted px-1 rounded">openid profile email</code>{" "}
          per{" "}
          <Link
            href="https://developer.xero.com/documentation/xero-app-store/app-partner-guides/sign-up/"
            className="text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Xero Sign Up with Xero
          </Link>
          .
        </p>

        <Button variant="ghost" className="w-full" onClick={() => router.push("/")} disabled={isSigningUp}>
          Back to sign in
        </Button>
      </Card>
    </div>
  );
}
