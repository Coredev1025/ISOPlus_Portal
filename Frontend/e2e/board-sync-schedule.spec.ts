import { test, expect, type Page } from '@playwright/test';
import { signInSupportAdmin } from './helpers/support-auth';

const WORKSPACE = process.env.E2E_WORKSPACE_ID ?? '55369';
const BOARD = process.env.E2E_BOARD_ID ?? 'eNiJpH14PN3';

const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  'http://localhost:4001';

async function signIn(page: Page) {
  await signInSupportAdmin(page);
}

test.describe('Board sync schedule', () => {
  test('board configuration shows sync schedule when sync is enabled', async ({
    page,
  }) => {
    await signIn(page);
