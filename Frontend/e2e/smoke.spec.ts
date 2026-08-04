import { test, expect } from '@playwright/test';

test('login page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('ISO+™ Portal')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with ISO+™' })).toBeVisible();
  await expect(page.getByText('Support agent sign-in')).toBeVisible();
});

test('access denied page is reachable', async ({ page }) => {
  await page.goto('/access-denied');
  await expect(page).toHaveURL(/access-denied/);
});
