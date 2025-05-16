"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import Link from "next/link";
import Image from "next/image";
import { useState, useEffect } from "react";
import axios from "@/app/utils/axiosConfig";
import { isTokenValid } from "./utils/cookies";
import { useAppContext } from "@/app/context/index";
import Spinner from "@/components/ui/spin";

export default function LoginPage() {
  const router = useRouter();
  const { setUser } = useAppContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSupportLogin, setIsSupportLogin] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();

    const checkToken = async () => {
      try {
        setIsLoading(true);
        const valid = await isTokenValid(abortController.signal);
        if (!abortController.signal.aborted && valid.status === 200) {
          setUser(valid.data.user);
          router.push('/dashboard');
        } else {
          localStorage.removeItem("user");
          localStorage.removeItem("workspace");
          localStorage.removeItem("board");
        }
      } catch (error) {
        if (!axios.isCancel(error)) {
          console.error('Token verification failed:', error);
        }
      }
      setIsLoading(false);
    };

    checkToken();

    return () => {
      abortController.abort();
    };
  }, [router, setUser]);

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const abortController = new AbortController();

    setError("");
    setIsLoading(true);
    try {
      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/login`,
        { email, password },
        { signal: abortController.signal }
      );

      if (!abortController.signal.aborted && response.status === 200) {
        setUser(response.data.user);
        router.push('/dashboard');
      } else {
        setError("Credential is not correct!");
      }
    } catch (error) {
      if (!axios.isCancel(error)) {
        console.error('Login failed:', error);
        setError("Login Failed");
      }
    }
    setIsLoading(false);

    return () => {
      abortController.abort();
    };
  };

  const handleISOPlusLogin = async () => {
    const abortController = new AbortController();
    setIsLoading(true);
    try {
      const redirectUrl = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/isoplus/redirect`,
        {
          headers: { 'X-API-Version': '2025-02-26.morava' },
          signal: abortController.signal
        }
      );

      if (!abortController.signal.aborted && redirectUrl.status === 200) {
        const width = 600;
        const height = 600;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;

        const popup = window.open(
          redirectUrl.data.redirect_uri,
          'OAuth2 Login',
          `width=${width},height=${height},left=${left},top=${top},status=yes,scrollbars=yes`
        );

        const handleMessage = async (event: MessageEvent) => {
          if (event.data.type === 'AUTH_SUCCESS') {
            try {
              const response = await axios.post(
                `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/oauth-login`,
                { oauthData: event.data.data },
                {
                  headers: { Authorization: event.data.accessToken },
                  signal: abortController.signal
                }
              );

              if (!abortController.signal.aborted && response.status === 200) {
                setUser(response.data.user);
                router.push('/dashboard');
              }
            } catch (error) {
              if (!axios.isCancel(error)) {
                console.error('Login error:', error);
                setError("Login Failed");
              }
            }
          } else if (event.data.type === 'AUTH_ERROR') {
            console.error('Authentication failed:', event.data.error);
            setError(event.data.error);
          }

          window.removeEventListener('message', handleMessage);
          if (popup) popup.close();
          setIsLoading(false);
        };

        window.addEventListener('message', handleMessage);
        return () => {
          window.removeEventListener('message', handleMessage);
          abortController.abort();
        };
      }
    } catch (error) {
      if (!axios.isCancel(error)) {
        console.error('Redirect URL fetch failed:', error);
        setError("Login Failed");
      }
    }
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-8">
        {isSupportLogin ? (
          // Support Agent Login
          <div className="space-y-6">
            <h1 className="text-2xl font-bold text-primary mb-4 text-center">
              Support Agent Login
            </h1>
            {error && (
              <div className="mb-4 p-3 text-sm text-red-500 bg-red-50 rounded-md">
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
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                Login as Support Agent
                {isLoading && <span className="ml-2"><Spinner /></span>}
              </Button>
            </form>
            <Button
              variant="ghost"
              className="w-full text-sm text-muted-foreground hover:text-white"
              onClick={() => setIsSupportLogin(false)}
              disabled={isLoading}
            >
              Return to ISO+ Login
            </Button>
          </div>
        ) : (
          // ISO+ Login
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold text-primary mb-4">ISO+ Portal</h1>
              <div className="flex items-center justify-center">
                <Image
                  src="/assets/logo_rgb_black.png"
                  alt="ISO+ Logo"
                  width={150}
                  height={150}
                  className="mx-auto mb-6 dark:hidden"
                />
                <Image
                  src="/assets/logo_rgb_white.png"
                  alt="ISO+ Logo"
                  width={150}
                  height={150}
                  className="mx-auto mb-6 hidden dark:block"
                />
              </div>
            </div>
            {error && (
              <div className="mb-4 p-3 text-sm text-red-500 bg-red-50 rounded-md">
                {error}
              </div>
            )}
            <Button
              onClick={handleISOPlusLogin}
              className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3"
              size="lg"
              disabled={isLoading}
            >
              Login
              {isLoading && <span className="ml-2"><Spinner /></span>}
            </Button>
            <div className="text-center text-sm text-muted-foreground">
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
              className="w-full text-sm text-muted-foreground hover:text-white"
              onClick={() => setIsSupportLogin(true)}
              disabled={isLoading}
            >
              Support Agent Login
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}