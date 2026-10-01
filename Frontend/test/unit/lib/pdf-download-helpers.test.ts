import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AxiosInstance } from 'axios';

import { downloadGeneratedPdfViaBackend } from '@/lib/pdf-download-helpers';

/**
 * KAN-279 — generated PDFs are streamed through POST /api/pdf-links/file so
 * the browser never fetch()es S3 (which fails without bucket CORS).
 */

const createObjectURL = vi.fn(() => 'blob:proxy-pdf');
const revokeObjectURL = vi.fn();
const clicked: Array<{ download: string; href: string }> = [];
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  clicked.length = 0;
  document.body.innerHTML = '';
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function mockClick(this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  clickSpy.mockRestore();
});

describe('downloadGeneratedPdfViaBackend', () => {
  it('POSTs fileUrl and workspaceId to the same-origin proxy and downloads the blob', async () => {
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    const post = vi.fn().mockResolvedValue({ data: blob, status: 200 });

    await downloadGeneratedPdfViaBackend({
      fileUrl: 'https://bucket.s3.amazonaws.com/output/ws-1/board/monthly-statements/a.pdf',
      filename: 'a.pdf',
      workspaceId: 'ws-1',
      axios: { post } as unknown as AxiosInstance,
    });

    expect(post).toHaveBeenCalledWith(
      'http://localhost:4001/api/pdf-links/file',
      {
        fileUrl: 'https://bucket.s3.amazonaws.com/output/ws-1/board/monthly-statements/a.pdf',
        workspaceId: 'ws-1',
        filename: 'a.pdf',
      },
      { responseType: 'blob', headers: { Accept: 'application/pdf' } },
    );
    expect(clicked).toEqual([{ download: 'a.pdf', href: 'blob:proxy-pdf' }]);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
  });

  it('omits filename from the body when none is supplied and defaults the download name', async () => {
    const post = vi.fn().mockResolvedValue({
      data: new Blob(['%PDF'], { type: 'application/pdf' }),
      status: 200,
    });

    await downloadGeneratedPdfViaBackend({
      fileUrl: 'https://files.test/x.pdf',
      workspaceId: 'ws-9',
      axios: { post } as unknown as AxiosInstance,
    });

    expect(post.mock.calls[0][1]).toEqual({
      fileUrl: 'https://files.test/x.pdf',
      workspaceId: 'ws-9',
    });
    expect(clicked[0].download).toBe('document.pdf');
  });

  it('cleans up the object URL after the click settles', async () => {
    const post = vi.fn().mockResolvedValue({
      data: new Blob(['%PDF'], { type: 'application/pdf' }),
      status: 200,
    });

    await downloadGeneratedPdfViaBackend({
      fileUrl: 'https://files.test/x.pdf',
      filename: 'x.pdf',
      workspaceId: 'ws-1',
      axios: { post } as unknown as AxiosInstance,
    });

    expect(document.body.querySelectorAll('a[download]')).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(document.body.querySelectorAll('a[download]')).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:proxy-pdf');
  });

  it('rejects when the proxy call fails', async () => {
    const post = vi.fn().mockRejectedValue(new Error('Network Error'));

    await expect(
      downloadGeneratedPdfViaBackend({
        fileUrl: 'https://files.test/x.pdf',
        workspaceId: 'ws-1',
        axios: { post } as unknown as AxiosInstance,
      }),
    ).rejects.toThrow('Network Error');

    expect(clicked).toHaveLength(0);
  });
});
