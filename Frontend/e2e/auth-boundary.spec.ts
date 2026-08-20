import { test, expect } from '@playwright/test';

// Characterization tests for what a signed-out visitor sees. These assert
// current behaviour, not desired behaviour — see the note at the bottom, which
// is the part worth arguing about. They run against whatever is already serving
// (npm run dev:up), need no ISO+ credentials, and avoid styling assertions.

test.describe('signed-out visitor', () => {
  const protectedPaths = [
    '/dashboard',
    '/workspace/55369',
    '/workspace/55369/board/eNiJpH14PN3/configuration',
    // Epic 3 — Financial Settings lives here; signed-out visitors must not see
    // relocated bank / document-numbering values from the seed.
    '/workspace/55369/finance-settings',
    // Epic 4 — Accounting Integrations tab (Connect Xero / mapping) same shell.
    '/workspace/55369/finance-settings?tab=accounting',
  ];

  test('accounting integrations does not render Xero logs inline', async ({ page }) => {
    await page.goto('/workspace/55369/finance-settings?tab=accounting');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Connection activity' })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: /xero logs/i })).toHaveCount(0);
  });

  for (const path of protectedPaths) {
    test(`${path} leaks no workspace data server-side`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBeLessThan(400);

      // The security property that actually matters. Auth is enforced in the
      // backend, so the API returns nothing — this asserts none of it arrives
      // by another route (server-rendered into the HTML, or an inlined RSC
      // payload). "Test" is the seeded business name for workspace 55369.
      const html = await page.content();
      expect(html).not.toContain('Care Management (NDIS) 2026 Pricing');
      expect(html).not.toMatch(/"name"\s*:\s*"Test"/);
    });
  }

  test('/dashboard renders the shell with an empty workspace list', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Pinning today's behaviour: no redirect, no sign-in prompt. The page
    // renders and the list is empty because every API call behind it 401s.
    expect(new URL(page.url()).pathname).toBe('/dashboard');
    await expect(page.getByText(/no workspaces match your search/i)).toBeVisible();
  });

  test('dashboard toasts a Xero OAuth return error from the query string', async ({ page }) => {
    await page.goto('/dashboard?xero=error&reason=oauth_failed');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Failed to connect to Xero')).toBeVisible();
  });
});

test('the offline sign-in path is reachable without ISO+ credentials', async ({ page }) => {
  // The ISO+ OAuth button cannot work locally without CLIENT_ID, so the
  // administrator-credentials route is the one that has to stay present — it is
  // how anyone signs in on a laptop. See docs/local-development.md.
  await page.goto('/');
  await expect(page.getByText('ISO+™ Portal')).toBeVisible();
  await expect(page.getByText(/support agent sign-in/i)).toBeVisible();
});

test('an unknown route does not hang or blank-screen', async ({ page }) => {
  const response = await page.goto('/definitely-not-a-real-route');
  expect(response?.status()).toBeLessThan(500);
  await expect(page.locator('body')).not.toBeEmpty();
});

/*
 * Worth a ticket, deliberately not "fixed" by weakening a test:
 *
 * A signed-out visitor to /dashboard is shown the full application shell and
 * the message "No workspaces match your search." That reads as "your account
 * has no workspaces" when the truth is "you are not signed in". No data leaks —
 * the backend refuses every call, which the first test above pins — so this is
 * a signalling problem rather than a breach, but it is the kind that generates
 * support tickets and hides real authorization failures.
 *
 * The tests above deliberately assert the current behaviour. When someone adds
 * a redirect or an unauthenticated empty state, the second test will fail; that
 * failure is the reminder to update it on purpose.
 */
