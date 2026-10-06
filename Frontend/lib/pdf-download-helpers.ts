import type { AxiosInstance } from 'axios';

/**
 * Download a generated PDF through the authenticated backend proxy so the
 * browser never fetch()es S3 (which requires bucket CORS and fails in
 * production without it — see KAN-279).
 *
 * Touchpoints: monthly-statement-pdf-helpers, invoice-generator-pdf-helpers,
 * invoice-generator/page handleDownloadPDF.
 */
export async function downloadGeneratedPdfViaBackend({
  fileUrl,
  filename,
  workspaceId,
  axios,
}: {
  fileUrl: string;
  filename?: string;
  workspaceId: string;
  axios: AxiosInstance;
}) {
  const response = await axios.post(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf-links/file`,
    {
      fileUrl,
      workspaceId,
      ...(filename ? { filename } : {}),
    },
    {
      responseType: 'blob',
      headers: { Accept: 'application/pdf' },
    },
  );

  const pdfBlob =
    response.data instanceof Blob
      ? response.data
      : new Blob([response.data], { type: 'application/pdf' });
  const pdfObjectUrl = URL.createObjectURL(pdfBlob);
  const link = document.createElement('a');
  link.href = pdfObjectUrl;
  link.download = filename || 'document.pdf';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();

  setTimeout(() => {
    if (typeof document !== 'undefined' && link.parentNode) {
      link.remove();
    }
    URL.revokeObjectURL(pdfObjectUrl);
  }, 100);
}
