import { defineConfig, devices } from '@playwright/test';

// 3100, not 3000. This repo deliberately avoids 3000/3001 because another local
// stack holds them — see docs/local-development.md. FRONTEND_PORT is what
// scripts/dev.mjs allocates, and a worktree gets its own pair from 3110 upward,
// so read it before falling back.
const port = process.env.FRONTEND_PORT || '3100';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  // Opt-in fixture seeding (E2E_LOAD_FIXTURES=1) — a no-op when the env is
  // unset, so existing workflows are untouched. See e2e/global-setup.ts.
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  // Locally the app is already served by the Docker stack (npm run dev:up), and
  // `next dev` started here would bind a different port and talk to no backend.
  // So reuse whatever is listening, and only spawn a server in CI.
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
