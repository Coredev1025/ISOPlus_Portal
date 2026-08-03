export const run = process.env.RUN_REAL_API_TESTS === '1';
export const baseUrl = process.env.API_TEST_BASE_URL || '';
export const adminKey = process.env.API_TEST_ADMIN_KEY || process.env.Admin_API_Key || '';
export const email = process.env.API_TEST_EMAIL || '';
export const password = process.env.API_TEST_PASSWORD || '';
export const sessionCookie = process.env.API_TEST_SESSION_COOKIE || '';
