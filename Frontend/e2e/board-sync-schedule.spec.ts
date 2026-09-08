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
    // Register before navigation so we catch the header's first poll, not the
    // next 10s tick. Do not assert "Not scheduled" is absent — that copy is
    // correct when BOARD_SYNC_ENABLED is off; assert cron on the payload instead.
    const statusResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/sync/workspace/status/') && resp.ok(),
    );
    // The else branch never awaits this; keep a stray rejection off the run.
    statusResponsePromise.catch(() => {});

    await page.goto(`/workspace/${WORKSPACE}/board/${BOARD}/configuration`);
    await expect(
      page.getByRole('heading', { name: 'Board Configuration' }),
    ).toBeVisible();

    const syncCheckbox = page.getByRole('checkbox', {
      name: 'Sync data from ISO+ to Portal database',
    });
    await expect(syncCheckbox).toBeVisible();

    if (await syncCheckbox.isChecked()) {
      const statusResponse = await statusResponsePromise;
      const body = await statusResponse.json();
      const boardRow = (body.boards ?? []).find(
        (row: { boardId?: string }) => row.boardId === BOARD,
      );
      expect(
        boardRow?.schedule?.cron,
        'workspace status should include schedule.cron once the panel poll lands',
      ).toBeTruthy();

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
