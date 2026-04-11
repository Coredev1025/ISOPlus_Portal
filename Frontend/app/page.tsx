"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import Image from "next/image";
import { useState, useEffect, useCallback } from "react";
import axios from "@/app/utils/axiosConfig";
import { verifySession } from "./utils/cookies";
import { useAppContext } from "@/app/context/index";
import Spinner from "@/components/ui/spin";
import { showSuccessToast, showErrorToast } from "@/lib/toast-utils";

export default function LoginPage() {
  const router = useRouter();
  const { setUser, setWorkspaces } = useAppContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSupportLogin, setIsSupportLogin] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  useEffect(() => {
    let cancelled = false;

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
          await axios.post(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/logout`, {});
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

  const handleAdminLogin = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/login`,
        { email, password }
      );

      if (response.status === 200) {
        setUser(response.data.user);
        showSuccessToast("Login successful");
        router.push('/dashboard');
      } else {
        setError("Credential is not correct!");
        showErrorToast("Login failed", { description: "Invalid credentials" });
      }
    } catch (err: any) {
      if (err.name !== "CanceledError" && err.name !== "AbortError") {
        console.error("Token verification failed:", err);
        showErrorToast("Login failed", { description: err.response?.data?.message || "An error occurred during login" });
      }
    } finally {
      setIsLoading(false);
    }
  }, [email, password, router, setUser]);

  const handleISOPlusLogin = useCallback(async () => {
    setIsLoading(true);
    setError("");
    let popup: Window | null = null;
    const handleMessage = async (event: MessageEvent) => {
      if (event.data.type === 'AUTH_SUCCESS') {
        try {
          const response = await axios.post(
            `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/oauth-login`,
            { oauthData: event.data.data },
            {
              headers: { Authorization: event.data.accessToken },
            }
          );

          if (response.status === 200) {
            setUser(response.data.user);
            showSuccessToast("Login successful");
            router.push('/dashboard');
          }
        } catch (err: any) {
          if (err.name !== "CanceledError" && err.name !== "AbortError") {
            console.error("Token verification failed:", err);
            showErrorToast("OAuth login failed", { description: err.response?.data?.message || "An error occurred during OAuth login" });
          }
        } finally {
          window.removeEventListener('message', handleMessage);
          if (popup) popup.close();
          setIsLoading(false);
        }
      } else if (event.data.type === 'AUTH_ERROR') {
        console.error("Token verification failed:", event.data.error);
        showErrorToast("OAuth login failed", { description: event.data.error || "Authentication error occurred" });
        window.removeEventListener('message', handleMessage);
        if (popup) popup.close();
        setIsLoading(false);
      }
    };
    try {
      const redirectUrl = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/isoplus/redirect`,
        {
          headers: { 'X-API-Version': '2025-02-26.morava' },
        }
      );

      if (redirectUrl.status === 200) {
        const width = 600;
        const height = 600;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;

        popup = window.open(
          redirectUrl.data.redirect_uri,
          'OAuth2 Login',
          `width=${width},height=${height},left=${left},top=${top},status=yes,scrollbars=yes`
        );

        window.addEventListener('message', handleMessage);
      }
    } catch (err: any) {
      if (err.name !== "CanceledError" && err.name !== "AbortError") {
        console.error("Token verification failed:", err);
        showErrorToast("OAuth redirect failed", { description: err.response?.data?.message || "Failed to initiate OAuth login" });
      }
      setIsLoading(false);
    }
  }, [router, setUser]);

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
        {isSupportLogin ? (
          // Support Agent Login
          <div className="space-y-6">
            <div className="space-y-1 text-center">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Support agent sign-in
              </h1>
              <p className="text-sm text-muted-foreground">
                Use your ISO+ Portal administrator credentials
              </p>
            </div>
            {error && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              >
                {error}
              </div>
            )}
            <form onSubmit={handleAdminLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                Login as Support Agent
                {isLoading && <span className="ml-2"><Spinner /></span>}
              </Button>
            </form>
            <Button
              variant="ghost"
              className="w-full text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setIsSupportLogin(false)}
              disabled={isLoading}
            >
              Back to ISO+ sign-in
            </Button>
          </div>
        ) : (
          // ISO+ Login
          <div className="space-y-6">
            <div className="text-center space-y-4">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                ISO+™ Portal
              </h1>
              <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                Sign in with your ISO+ account or register via Xero
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
              Sign in with ISO+
              {isLoading && <Spinner />}
            </Button>
            <div className="relative py-1">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border/80" />
              </div>
              <div className="relative flex justify-center text-xs uppercase tracking-wide">
                <span className="bg-card px-3 text-muted-foreground">or</span>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full border-border/80 bg-background/50 py-6 font-medium backdrop-blur-sm hover:bg-muted/60"
              size="lg"
              disabled={isLoading}
              onClick={() => router.push("/signup/xero")}
            >
              Sign up with Xero
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
              onClick={() => setIsSupportLogin(true)}
              disabled={isLoading}
            >
              Support agent sign-in
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}