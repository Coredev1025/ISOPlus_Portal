"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import axios from "@/app/utils/axiosConfig";
import Spinner from "@/components/ui/spin";
import { showSuccessToast, showErrorToast } from "@/lib/toast-utils";
const MAX_FIELD = 240;

export default function XeroSignupPage() {
  const router = useRouter();
  const xeroSignupPopupRef = useRef<Window | null>(null);
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [phone, setPhone] = useState("");
  const [applicantMessage, setApplicantMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "XERO_SIGNUP_SUCCESS" && data.type !== "XERO_SIGNUP_ERROR") return;
      if (event.source !== xeroSignupPopupRef.current) return;

      if (data.type === "XERO_SIGNUP_SUCCESS") {
        if (data.duplicate) {
          showSuccessToast(data.message || "We already have your request.");
        } else {
          showSuccessToast(data.message || "Sign-up request received! We'll be in touch.");
        }
      } else {
        showErrorToast("Sign-up failed", {
          description: typeof data.error === "string" ? data.error : "An error occurred",
        });
      }
      xeroSignupPopupRef.current = null;
      setIsSigningUp(false);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    if (!isSigningUp) return;
    const popup = xeroSignupPopupRef.current;
    if (!popup) return;

    const id = window.setInterval(() => {
      try {
        if (popup.closed) {
          window.clearInterval(id);
          xeroSignupPopupRef.current = null;
          setIsSigningUp(false);
        }
      } catch {
        window.clearInterval(id);
        xeroSignupPopupRef.current = null;
        setIsSigningUp(false);
      }
    }, 600);

    return () => window.clearInterval(id);
  }, [isSigningUp]);

  const startXeroSignup = useCallback(async () => {
    if (!acknowledged) {
      showErrorToast("Please confirm the onboarding notice", {
        description: "Confirm that you understand access is manual before continuing.",
      });
      return;
    }

    setIsSigningUp(true);

    try {
      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/subscriptions/xero-auth-url`,
        {
          companyName: companyName.slice(0, MAX_FIELD),
          phone: phone.slice(0, MAX_FIELD),
          applicantMessage: applicantMessage.slice(0, MAX_FIELD),
        }
      );

      if (response.status === 200 && response.data.url) {
        const width = 600;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;

        const popup = window.open(
          response.data.url,
          "Xero Sign Up",
          `width=${width},height=${height},left=${left},top=${top},status=yes,scrollbars=yes`
        );

        if (!popup) {
          xeroSignupPopupRef.current = null;
          showErrorToast("Popup blocked", {
            description: "Allow popups for this site to sign up with Xero.",
          });
          setIsSigningUp(false);
        } else {
          xeroSignupPopupRef.current = popup;
        }
      } else {
        showErrorToast("Sign-up failed", { description: "No authorization URL returned from the server." });
        setIsSigningUp(false);
      }
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { message?: string } } };
      showErrorToast("Sign-up failed", {
        description: ax.response?.data?.message || "Failed to initiate Xero sign-up",
      });
      setIsSigningUp(false);
    }
  }, [acknowledged, companyName, phone, applicantMessage]);

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
            Request access to ISO+™ Portal (Option B — hosted on our site). Tell us a bit about you, then
            authorize with Xero. We merge your details with{" "}
            <code className="text-xs bg-muted px-1 rounded">given_name</code>,{" "}
            <code className="text-xs bg-muted px-1 rounded">family_name</code>,{" "}
            <code className="text-xs bg-muted px-1 rounded">email</code>,{" "}
            <code className="text-xs bg-muted px-1 rounded">sub</code>, and{" "}
            <code className="text-xs bg-muted px-1 rounded">xero_userid</code> from Xero&apos;s ID token.
          </p>
        </div>

        <ul className="text-sm text-muted-foreground space-y-2 list-disc pl-5 border border-border/60 rounded-lg p-4 bg-muted/20">
          <li>
            <strong className="text-foreground">Manual onboarding.</strong> We do not create an ISO+
            account automatically. Our team will invite you to ISO+ when setup is complete.
          </li>
          <li>You will sign in with ISO+ only after you receive that invitation.</li>
        </ul>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="company">Organization / company (optional)</Label>
            <Input
              id="company"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="e.g. Hills Grade Pty Ltd"
              maxLength={MAX_FIELD}
              disabled={isSigningUp}
              autoComplete="organization"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone (optional)</Label>
            <Input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Best number to reach you"
              maxLength={MAX_FIELD}
              disabled={isSigningUp}
              autoComplete="tel"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="message">Anything else we should know? (optional)</Label>
            <Textarea
              id="message"
              value={applicantMessage}
              onChange={(e) => setApplicantMessage(e.target.value)}
              placeholder="Services you use, preferred contact time, etc."
              maxLength={MAX_FIELD}
              rows={3}
              disabled={isSigningUp}
            />
            <p className="text-xs text-muted-foreground">{applicantMessage.length} / {MAX_FIELD}</p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/15 p-4">
          <Checkbox
            id="ack"
            checked={acknowledged}
            onCheckedChange={(v) => setAcknowledged(v === true)}
            disabled={isSigningUp}
            className="mt-0.5"
          />
          <label htmlFor="ack" className="text-sm leading-snug cursor-pointer">
            I understand ISO+ does not create my portal login automatically and that ISO+ staff will
            contact me or invite me when my request is processed.
          </label>
        </div>

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
          disabled={isSigningUp || !acknowledged}
        >
          Continue with Xero
          {isSigningUp && <Spinner />}
        </Button>

        <p className="text-xs text-center text-muted-foreground">
          OpenID scopes{" "}
          <code className="text-xs bg-muted px-1 rounded">openid profile email</code> per{" "}
          <Link
            href="https://developer.xero.com/documentation/xero-app-store/app-partner-guides/sign-up/"
            className="text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Sign Up with Xero
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
