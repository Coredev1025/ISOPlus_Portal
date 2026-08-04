import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./axiosConfig', () => ({
  default: { get: vi.fn() },
}));

vi.mock('@/app/utils/axiosConfig', () => ({
  default: { get: vi.fn() },
}));

import axios from '@/app/utils/axiosConfig';
import { fetchMonthlyStatementItems } from '@/app/utils/items';

describe('fetchMonthlyStatementItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
  });

  it('calls the monthly-statement endpoint by default', async () => {
    (axios.get as any).mockResolvedValue({ data: { items: [] } });
    const data = await fetchMonthlyStatementItems('ws', 'board', { page: 1 });
    expect(data).toEqual({ items: [] });
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:3001/api/items/ws/board/monthly-statement',
      expect.objectContaining({ params: { page: 1 } })
    );
  });

  it('uses a custom endpoint when provided', async () => {
    (axios.get as any).mockResolvedValue({ data: { ok: true } });
    await fetchMonthlyStatementItems('ws', 'board', { endpoint: 'invoice-generator' });
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:3001/api/items/ws/board/invoice-generator',
      expect.any(Object)
    );
  });
});
