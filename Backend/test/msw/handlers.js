import { http, HttpResponse, passthrough } from 'msw';

const API_BASE = 'https://app.isoplus.online/api/v2';

export const handlers = [
  http.all(/http:\/\/127\.0\.0\.1(:\d+)?\/.*/, () => passthrough()),
  http.all(/http:\/\/localhost(:\d+)?\/.*/, () => passthrough()),
  http.get(`${API_BASE}/workspaces/:workspaceId/boards/:boardId/hooks`, () =>
    HttpResponse.json([])
  ),
  http.post(`${API_BASE}/workspaces/:workspaceId/boards/:boardId/hooks`, async () =>
    HttpResponse.json({ id: 'hook_test_1', secret: 'secret_test' }, { status: 201 })
  ),
  http.delete(
    `${API_BASE}/workspaces/:workspaceId/boards/:boardId/hooks/:hookId`,
    async () => HttpResponse.json({ deleted: true }, { status: 200 })
  ),
];
