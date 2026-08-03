import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
    exclude: ['test/real-api/**'],
    globals: true,
    maxWorkers: 1,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'src/models/**/*.js',
        'src/middleware/**/*.js',
        'src/utils/parseFlexibleNumber.js',
        'src/utils/sanitizeLog.js',
        'src/utils/securityHelpers.js',
        'src/utils/helpers.js',
        'src/utils/dynamicLinking.js',
        'src/utils/auditLogger.js',
        'src/services/webhookService.js',
        'src/services/sync/validator.js',
        'src/routes/heathcheck.js',
        'src/routes/pdfLink.js',
        'src/routes/audittrail.js',
        'src/routes/isoplusWebhook.js',
      ],
      exclude: ['**/*.test.js'],
    },
  },
});
