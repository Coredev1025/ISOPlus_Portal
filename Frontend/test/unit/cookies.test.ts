import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/app/utils/axiosConfig', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('@/app/utils/requestDedupe', () => ({
  dedupeByKey: (_key: string, factory: () => Promise<unknown>) => factory(),
}));

import axios from '@/app/utils/axiosConfig';
import { verifySession, isTokenValid } from '@/app/utils/cookies';

describe('cookies session helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
  });

  it('verifySession returns axios response on success', async () => {
    (axios.get as any).mockResolvedValue({ status: 200, data: { authenticated: true } });
    const res = await verifySession();
    expect(res.status).toBe(200);
  });

  it('verifySession returns error object on failure', async () => {
    const err = new Error('fail');
    (axios.get as any).mockRejectedValue(err);
    const res = await verifySession();
    expect(res).toBe(err);
  });

  it('isTokenValid delegates to verifySession', async () => {
    (axios.get as any).mockResolvedValue({ status: 200 });
    const res = await isTokenValid();
    expect(res.status).toBe(200);
  });
});
