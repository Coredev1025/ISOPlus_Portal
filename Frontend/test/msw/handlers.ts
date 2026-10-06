import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('https://api.isoplus.test/health', () => {
    return HttpResponse.json({ ok: true });
  }),
];
