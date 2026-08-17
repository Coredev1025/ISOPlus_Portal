import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

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
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: '50%',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
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
