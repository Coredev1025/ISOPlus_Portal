import axios from "@/app/utils/axiosConfig";

export const LOGO_FIELDS = ["defaultLogo", "squareLogo", "wideLogo"] as const;
export type LogoField = (typeof LOGO_FIELDS)[number];

export interface LogoUrlInfo {
  url: string;
  expiresAt: string;
}

export type BusinessLogoUrls = Partial<Record<LogoField, LogoUrlInfo>>;

export function revokeBlobUrl(url: string | null | undefined) {
  if (url?.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

export function getBusinessLogoImageUrl(
  workspaceId: string,
  logoKey?: LogoField
): string {
  const params = new URLSearchParams({ workspaceId });
  if (logoKey) {
    params.set("logoKey", logoKey);
  }
  return `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/logo-image?${params.toString()}`;
}

export async function fetchBusinessLogoBlobUrl(
  workspaceId: string,
  logoKey?: LogoField
): Promise<string | null> {
  try {
    const response = await axios.get(getBusinessLogoImageUrl(workspaceId, logoKey), {
      responseType: "blob",
    });
    return URL.createObjectURL(response.data);
  } catch {
    return null;
  }
}

export function isLogoUrlExpired(logoUrlInfo?: LogoUrlInfo): boolean {
  if (!logoUrlInfo?.expiresAt) return true;
  return Date.now() >= new Date(logoUrlInfo.expiresAt).getTime() - 60_000;
}

export function hasBusinessLogo(
  business?: Partial<Record<LogoField, string | null | undefined>>
): boolean {
  return LOGO_FIELDS.some((field) => Boolean(business?.[field]));
}

export function resolveQrLogoField(
  business?: Partial<Record<LogoField, string | null | undefined>>
): LogoField | undefined {
  if (business?.squareLogo) return "squareLogo";
  if (business?.defaultLogo) return "defaultLogo";
  return undefined;
}

export async function loadBusinessLogoPreviews(
  workspaceId: string,
  business: Partial<Record<LogoField, string | null | undefined>>
): Promise<Partial<Record<LogoField, string>>> {
  const previews: Partial<Record<LogoField, string>> = {};

  await Promise.all(
    LOGO_FIELDS.map(async (field) => {
      if (!business[field]) return;
      const blobUrl = await fetchBusinessLogoBlobUrl(workspaceId, field);
      if (blobUrl) {
        previews[field] = blobUrl;
      }
    })
  );

  return previews;
}
