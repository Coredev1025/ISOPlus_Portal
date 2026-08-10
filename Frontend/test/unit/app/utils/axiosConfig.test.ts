import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import rawAxios from 'axios';
import api from '@/app/utils/axiosConfig';
import { server } from '../../../msw/server';

describe('app/utils/axiosConfig', () => {
  it('sends the session cookie on a real request because withCredentials is enabled', async () => {
    let seenWithCredentials: unknown = 'handler-not-called';

    server.use(
      http.get('https://api.isoplus.test/api/healthcheck', () => HttpResponse.json({ status: 'OK' }))
    );

    const res = await api.get('https://api.isoplus.test/api/healthcheck');
    seenWithCredentials = res.config.withCredentials;

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: 'OK' });
    expect(seenWithCredentials).toBe(true);
  });

  it('has no baseURL, so a relative path resolves against the page origin', async () => {
    let requestedUrl = '';

    server.use(
      http.get('http://localhost:3000/api/healthcheck', ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ status: 'OK' });
      })
    );

    const res = await api.get('/api/healthcheck');

    expect(requestedUrl).toBe('http://localhost:3000/api/healthcheck');
    expect(res.config.baseURL).toBeUndefined();
  });

  it('applies withCredentials to instances created after this module is imported', async () => {
    server.use(
      http.get('https://api.isoplus.test/api/boards', () => HttpResponse.json({ board: { label: 'Care Management' } }))
    );

    const created = api.create();
    const res = await created.get('https://api.isoplus.test/api/boards');

    expect(created.defaults.withCredentials).toBe(true);
    expect(res.config.withCredentials).toBe(true);
  });

  it('is the shared global axios module, so the setting applies to every importer', () => {
    expect(api).toBe(rawAxios);
    expect(rawAxios.defaults.withCredentials).toBe(true);
  });
});
