// KAN-322: which page a save of the business profile came from. Each page sends
// its own `section` and is validated only for the fields it owns.
//
// Read by: validators/businessProfile.js (picks the rules to run),
// Frontend/constants/businessProfile.ts mirrors the values for the pages.
// Read-only by convention.
export const BUSINESS_PROFILE_SECTION = {
  BUSINESS: 'business',
  FINANCE: 'finance',
};
