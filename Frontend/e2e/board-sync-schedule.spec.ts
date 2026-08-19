import { test, expect, type Page } from '@playwright/test';

// Credentials come from the environment, never from source. `npm run dev:user`
// prints a local support_admin login; export these before running:
//   E2E_EMAIL=... E2E_PASSWORD=... npx playwright test e2e/board-sync-schedule.spec.ts
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const WORKSPACE = process.env.E2E_WORKSPACE_ID ?? '55369';
const BOARD = process.env.E2E_BOARD_ID ?? 'eNiJpH14PN3';

// Login is a backend call; the frontend proxies nothing. Ports differ per
// worktree, so read it rather than assuming 4001.
const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  'http://localhost:4001';

/**
 * Authenticate through the API rather than the login form.
 *
 * page.request shares the browser context's cookie jar, so the session cookie
 * it sets is the one the page will send. Same pattern as the (unmerged)
 * invoice-statement-automation spec.
 */
async function signIn(page: Page) {
  const response = await page.request.post(`${BACKEND}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });

  expect(
    response.ok(),
    `login failed (${response.status()}) — check E2E_EMAIL/E2E_PASSWORD and that the stack at ${BACKEND} is seeded`,
  ).toBeTruthy();
}

test.describe('Board sync schedule', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'set E2E_EMAIL and E2E_PASSWORD (see npm run dev:user)',
  );

  test('board configuration shows sync schedule when sync is enabled', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`/workspace/${WORKSPACE}/board/${BOARD}/configuration`);
    await expect(
      page.getByRole('heading', { name: 'Board Configuration' }),
    ).toBeVisible();

    const syncCheckbox = page.getByRole('checkbox', {
      name: 'Sync data from ISO+ to Portal database',
    });
    await expect(syncCheckbox).toBeVisible();

    if (await syncCheckbox.isChecked()) {
      const region = page.getByRole('region', { name: /sync schedule/i });
      await expect(region).toBeVisible();
      await expect(region.getByText('Previous')).toBeVisible();
      await expect(region.getByText('Current')).toBeVisible();
      await expect(region.getByText('Next scheduled run')).toBeVisible();
    } else {
      await expect(
        page.getByRole('region', { name: /sync schedule/i }),
      ).toHaveCount(0);
    }
  });
});
