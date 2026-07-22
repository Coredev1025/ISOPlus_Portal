export function isTrustedOAuthMessageOrigin(origin: string): boolean {
  if (typeof window === "undefined") return false;
  if (!origin) return false;

  const trusted = new Set<string>([window.location.origin]);
  try {
    const backend = process.env.NEXT_PUBLIC_BACKEND_URL;
    if (backend) trusted.add(new URL(backend).origin);
  } catch {
  }

  const extra = process.env.NEXT_PUBLIC_TRUSTED_ORIGINS || "";
  for (const raw of extra.split(/[\s,]+/).filter(Boolean)) {
    try {
      trusted.add(new URL(raw).origin);
    } catch {
    }
  }

  return trusted.has(origin);
}
