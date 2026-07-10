import type { AxiosInstance } from 'axios';

export async function downloadMonthlyStatementPdf(fileUrl: string, filename?: string) {
  const pdfResponse = await fetch(fileUrl);
  const pdfBlob = await pdfResponse.blob();
  const pdfObjectUrl = URL.createObjectURL(pdfBlob);
  const link = document.createElement('a');
  link.href = pdfObjectUrl;
  link.download = filename || 'monthly-statement.pdf';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();

  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(pdfObjectUrl);
  }, 100);
}

export function validateMonthlyStatementPdfPrerequisites(
  businessDetails: {
    companyName?: string;
    companyRegistrationId?: string;
    phoneNumber?: string;
    businessEmail?: string;
  },
  action: 'generate' | 'export',
  setShowBusinessDialog: (open: boolean) => void,
  showErrorToast: (message: string) => void,
): boolean {
  if (!businessDetails.companyName || !businessDetails.companyRegistrationId || !businessDetails.phoneNumber || !businessDetails.businessEmail) {
    showErrorToast(`Please configure business details before ${action === 'generate' ? 'generating' : 'exporting'} PDF`);
    setShowBusinessDialog(true);
    return false;
  }
  return true;
}

async function captureChartImageForPdf(
  chartConfigs: Array<{ hasData: boolean }>,
  chartCardRefs: { current: Array<HTMLElement | null> },
  captureChartAsLightPng: (el: HTMLElement) => Promise<string>,
  compositeChartImages: (
    imageDataUrls: string[],
    cols: number,
    cellSize: { width: number; height: number },
    options: { targetAspect: number; background: string; gap: number; fit: 'contain' | 'cover' },
  ) => Promise<string>,
  getPdfChartCellSize: (cols: number) => { width: number; height: number },
  waitForFontsAndNextPaint: () => Promise<void>,
): Promise<string | undefined> {
  const chartsWithData = chartConfigs.filter((c) => c.hasData);
  if (chartsWithData.length === 0 || chartCardRefs.current.length === 0) {
    return undefined;
  }

  try {
    return await captureChartsForPdf(
      chartsWithData,
      chartConfigs,
      chartCardRefs,
      captureChartAsLightPng,
      compositeChartImages,
      getPdfChartCellSize,
      waitForFontsAndNextPaint,
    );
  } catch (e) {
    console.warn('Chart capture for PDF failed:', e);
    return undefined;
  }
}

async function deliverMonthlyStatementPdf(
  fileUrl: string,
  filename: string | undefined,
  action: 'generate' | 'export',
  showSuccessToast: (message: string) => void,
  showInfoToast: (message: string, options?: { description?: string }) => void,
) {
  try {
    await downloadMonthlyStatementPdf(fileUrl, filename);
    showSuccessToast(
      action === 'generate'
        ? 'Monthly statement PDF downloaded successfully'
        : 'PDF exported successfully',
    );
  } catch (downloadErr) {
    console.error('Error downloading PDF:', downloadErr);
    window.open(fileUrl, '_blank');
    showInfoToast('PDF opened in new tab', {
      description: 'Download failed, opened PDF in new tab instead.',
    });
  }
}

export async function executeMonthlyStatementPdfAction({
  action,
  statementData,
  businessDetails,
  selectedMonth,
  selectedYear,
  businessTimezone,
  chartConfigs,
  chartCardRefs,
  id,
  boardId,
  getSelectedMonthDateRange,
  captureChartAsLightPng,
  compositeChartImages,
  getPdfChartCellSize,
  waitForFontsAndNextPaint,
  axios,
  showErrorToast,
  showSuccessToast,
  showInfoToast,
  setShowBusinessDialog,
}: {
  action: 'generate' | 'export';
  statementData: Record<string, unknown> & { monthNumber?: string; year?: string };
  businessDetails: {
    companyName?: string;
    companyRegistrationId?: string;
    phoneNumber?: string;
    businessEmail?: string;
  };
  selectedMonth: string;
  selectedYear: string;
  businessTimezone: string;
  chartConfigs: Array<{ hasData: boolean }>;
  chartCardRefs: { current: Array<HTMLElement | null> };
  id: string;
  boardId: string;
  getSelectedMonthDateRange: () => { startDate: string; endDate: string } | null;
  captureChartAsLightPng: (el: HTMLElement) => Promise<string>;
  compositeChartImages: (
    imageDataUrls: string[],
    cols: number,
    cellSize: { width: number; height: number },
    options: { targetAspect: number; background: string; gap: number; fit: 'contain' | 'cover' },
  ) => Promise<string>;
  getPdfChartCellSize: (cols: number) => { width: number; height: number };
  waitForFontsAndNextPaint: () => Promise<void>;
  axios: AxiosInstance;
  showErrorToast: (message: string) => void;
  showSuccessToast: (message: string) => void;
  showInfoToast: (message: string, options?: { description?: string }) => void;
  setShowBusinessDialog: (open: boolean) => void;
}): Promise<string | null> {
  if (!validateMonthlyStatementPdfPrerequisites(businessDetails, action, setShowBusinessDialog, showErrorToast)) {
    return null;
  }

  try {
    const dateRange = getSelectedMonthDateRange();
    if (!dateRange) {
      showErrorToast('Please choose a valid month and year before generating PDF.');
      return null;
    }

    const chartImage = await captureChartImageForPdf(
      chartConfigs,
      chartCardRefs,
      captureChartAsLightPng,
      compositeChartImages,
      getPdfChartCellSize,
      waitForFontsAndNextPaint,
    );

    const userActionLabel =
      action === 'generate' ? 'Generate Monthly Statement PDF' : 'Export Monthly Statement PDF';

    const response = await axios.post(
      `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf/${id}/${boardId}/monthly-statement`,
      {
        statementData: {
          ...statementData,
          monthNumber: statementData.monthNumber || selectedMonth,
          year: statementData.year || selectedYear,
        },
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        businessDetails,
        timezone: businessTimezone,
        ...(chartImage ? { chartImage } : {}),
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-User-Action': userActionLabel,
        },
      },
    );

    const fileUrl = response.data?.fileUrl;
    if (!fileUrl) {
      showErrorToast('Failed to retrieve PDF link from server.');
      return null;
    }

    await deliverMonthlyStatementPdf(fileUrl, response.data?.filename, action, showSuccessToast, showInfoToast);
    return fileUrl;
  } catch (err) {
    console.error(`Error ${action === 'generate' ? 'generating' : 'exporting'} PDF:`, err);
    showErrorToast('Failed to generate PDF. Please try again.');
    return null;
  }
}

export async function captureChartsForPdf(
  chartsWithData: Array<{ hasData: boolean }>,
  chartConfigs: Array<{ hasData: boolean }>,
  chartCardRefs: { current: Array<HTMLElement | null> },
  captureChartAsLightPng: (el: HTMLElement) => Promise<string>,
  compositeChartImages: (
    imageDataUrls: string[],
    cols: number,
    cellSize: { width: number; height: number },
    options: { targetAspect: number; background: string; gap: number; fit: 'contain' | 'cover' },
  ) => Promise<string>,
  getPdfChartCellSize: (cols: number) => { width: number; height: number },
  waitForFontsAndNextPaint: () => Promise<void>,
): Promise<string | undefined> {
  const SUMMARY_TABLE_ASPECT = 170 / 125.8;
  const pdfCols = chartsWithData.length === 3 || chartsWithData.length > 4 ? 3 : 2;
  const chartIndicesWithData = chartsWithData.map((c) => chartConfigs.indexOf(c));

  await waitForFontsAndNextPaint();
  const imageDataUrls: string[] = [];
  for (const chartIdx of chartIndicesWithData) {
    const cardEl = chartCardRefs.current[chartIdx];
    const captureEl =
      (cardEl?.querySelector?.('[data-pdf-chart-container="true"]') as HTMLElement | null) ?? cardEl;
    if (!captureEl) continue;
    const dataUrl = await captureChartAsLightPng(captureEl);
    imageDataUrls.push(dataUrl);
  }

  if (imageDataUrls.length === 0) return undefined;

  return compositeChartImages(imageDataUrls, pdfCols, getPdfChartCellSize(pdfCols), {
    targetAspect: SUMMARY_TABLE_ASPECT,
    background: 'white',
    gap: 0,
    fit: 'contain',
  });
}
