import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import os from 'node:os';

// Cap workers so jsdom/Radix page tests are not starved when Backend vitest or
// another heavy process shares the machine. Override with VITEST_MAX_WORKERS.
const cpuCount = os.cpus().length;
const maxWorkers =
  process.env.VITEST_MAX_WORKERS != null
    ? Number(process.env.VITEST_MAX_WORKERS)
    : Math.max(1, Math.min(4, Math.floor(cpuCount / 2)));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    globals: true,
    // Default 5s flakes when Frontend+Backend suites share a machine; Radix
    // userEvent and MSW page mounts need headroom under CPU contention.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'constants/**/*.{ts,tsx}',
        'lib/**/*.{ts,tsx}',
        'hooks/**/*.{ts,tsx}',
        'app/utils/**/*.{ts,tsx}',
        'app/workspace/[id]/configure-business/page.tsx',
        'app/workspace/[id]/finance-settings/page.tsx',
        'components/theme-provider.tsx',
      ],
      exclude: ['**/*.d.ts', '**/*.test.{ts,tsx}', '**/types.ts'],
    },
  },
});
