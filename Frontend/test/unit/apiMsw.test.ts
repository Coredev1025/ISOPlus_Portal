import { describe, it, expect } from 'vitest';
import axios from 'axios';

describe('MSW health stub', () => {
  it('returns ok from the mocked health endpoint', async () => {
    const res = await axios.get('https://api.isoplus.test/health');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
  });
});
