import { test, expect } from "@playwright/test";
import { signInSupportAdmin } from "./helpers/support-auth";

/**
 * KAN-279 — generated PDFs download through POST /api/pdf-links/file so the
 * browser never fetch()es S3. Full Monthly Statement generation needs seeded
 * board data; this journey proves the proxy is mounted, gated, and rejects a
 * cross-workspace key the same way unit/integration tests assert.
 */

const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  "http://localhost:4001";

const WORKSPACE = process.env.E2E_CM_WORKSPACE_ID ?? "55390";

test("PDF file proxy rejects unauthenticated callers", async ({ request }) => {
  const res = await request.post(`${BACKEND}/api/pdf-links/file`, {
    data: {
      fileUrl: `http://localhost:4001/api/local-files/output/${WORKSPACE}/board/x.pdf`,
      workspaceId: WORKSPACE,
    },
  });

  expect(res.status()).toBe(401);
});

test("PDF file proxy rejects a key outside the claimed workspace", async ({ page }) => {
  await signInSupportAdmin(page);

  const res = await page.request.post(`${BACKEND}/api/pdf-links/file`, {
    data: {
      fileUrl: "http://localhost:4001/api/local-files/output/other-ws/board/x.pdf",
      workspaceId: WORKSPACE,
      filename: "x.pdf",
    },
  });

  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.message).toMatch(/does not belong/i);
});
