export function isTrustedOAuthMessageOrigin(origin: string): boolean {
  if (typeof window === "undefined") return false;
  const trusted = new Set<string>([window.location.origin]);
  try {
    const backend = process.env.NEXT_PUBLIC_BACKEND_URL;
    if (backend) trusted.add(new URL(backend).origin);
  } catch {
  }
  return trusted.has(origin);
}
