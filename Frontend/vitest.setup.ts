import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './test/msw/server';

// Match Vitest testTimeout headroom when Frontend+Backend suites share CPUs —
// the default 1s async util timeout fails/races into hard vitest kills.
configure({ asyncUtilTimeout: 10_000 });

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
