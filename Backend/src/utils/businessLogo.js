import { getS3FileUrl, getS3File, getContentType } from './uploadS3.js';
import { isDocumentNumberingInitialized } from './documentNumberingInitial.js';
import { normalizeFeatureTogglesForProfile } from './workspaceFeatureToggleHelpers.js';

export const LOGO_FIELDS = ['defaultLogo', 'squareLogo', 'wideLogo'];
export const LOGO_URL_EXPIRY_SECONDS = 3600;

export const isValidLogoField = (logoKey) => LOGO_FIELDS.includes(logoKey);

export async function buildLogoUrls(business) {
  const logoUrls = {};

  for (const field of LOGO_FIELDS) {
    const key = business?.[field];
    if (!key) continue;

    logoUrls[field] = {
      url: await getS3FileUrl(key, LOGO_URL_EXPIRY_SECONDS, false),
      expiresAt: new Date(Date.now() + LOGO_URL_EXPIRY_SECONDS * 1000).toISOString(),
    };
  }

  return logoUrls;
}

export async function formatBusinessProfileResponse(business) {
  const plain = business?.toObject ? business.toObject() : { ...business };
  plain.logoUrls = await buildLogoUrls(plain);
  delete plain.xeroConnectionLogs;
  if (business) plain.documentNumberingInitialized = isDocumentNumberingInitialized(plain);
  return normalizeFeatureTogglesForProfile(plain);
}

export function resolveQrLogoField(business) {
  if (business?.squareLogo) return 'squareLogo';
  if (business?.defaultLogo) return 'defaultLogo';
  return null;
}

export async function loadBusinessLogoAsset(business, logoKey) {
  if (!isValidLogoField(logoKey)) {
    throw new Error('Invalid logo key');
  }

  const logoPath = business?.[logoKey];
  if (!logoPath) return null;

  const buffer = await getS3File(logoPath, false);
  if (!buffer) return null;

  const fileExtension = logoPath.split('.').pop().toLowerCase();
  return {
    buffer,
    contentType: getContentType(fileExtension),
    logoPath,
  };
}
