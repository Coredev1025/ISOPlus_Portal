// KAN-322: which page a save of the business profile came from. Sent as
// `section` so the server validates only the fields that page owns. Mirrors
// Backend/src/constants/businessProfile.js.
//
// Read by: app/workspace/[id]/configure-business/page.tsx (Business
// Configuration save), lib/financial-settings-numbering-helpers.ts (Finance
// Settings save). Read-only by convention.
export const BUSINESS_PROFILE_SECTION = {
  BUSINESS: "business",
  FINANCE: "finance",
} as const;
