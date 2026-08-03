import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/real-api/**/*.test.js'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
