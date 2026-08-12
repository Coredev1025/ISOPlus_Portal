import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';

import {
  downloadMonthlyStatementPdf,
  validateMonthlyStatementPdfPrerequisites,
  executeMonthlyStatementPdfAction,
  captureChartsForPdf,
} from '@/lib/monthly-statement-pdf-helpers';

/**
 * These helpers never touch @pdfme — the PDF is rendered server side and this
 * module only builds the request body and delivers the file the API returns.
 * The request body is therefore the contract worth pinning: every assertion
 * below on `axios.post` is checking what the backend will actually be asked to
 * render.
 *
 * NEXT_PUBLIC_BACKEND_URL is unset under vitest, so the URL the code builds is
 * literally `undefined/api/...`. That is the real production template with an
 * empty variable, and asserting it exactly catches a reordered path segment.
 */

const PDF_HOST = 'https://files.example.test';
const FILE_URL = `${PDF_HOST}/statements/march-2026.pdf`;

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:statement-1');
  revokeObjectURL = vi.fn();
  // jsdom implements neither.
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  server.use(
    http.get(`${PDF_HOST}/statements/*`, () =>
      HttpResponse.text('%PDF-1.4 pretend bytes', {
        headers: { 'Content-Type': 'application/pdf' },
      }),
    ),
  );
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  vi.useRealTimers();
});

function makeToasts() {
  return {
    showErrorToast: vi.fn(),
    showSuccessToast: vi.fn(),
    showInfoToast: vi.fn(),
  };
}

const COMPLETE_BUSINESS = {
  companyName: 'Sunrise Care Pty Ltd',
  companyRegistrationId: '51 824 753 556',
  phoneNumber: '+61 2 9000 1234',
  businessEmail: 'accounts@sunrisecare.test',
  address: '12 Harbour St',
  suburb: 'Sydney',
  state: 'NSW',
  postcode: '2000',
  country: 'Australia',
};

describe('validateMonthlyStatementPdfPrerequisites', () => {
  it('passes a fully configured business through without opening the dialog', () => {
    const setShowBusinessDialog = vi.fn();
    const showErrorToast = vi.fn();

    const ok = validateMonthlyStatementPdfPrerequisites(
      COMPLETE_BUSINESS,
      'generate',
      setShowBusinessDialog,
      showErrorToast,
    );

    expect(ok).toBe(true);
    expect(setShowBusinessDialog).not.toHaveBeenCalled();
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it.each([
    ['companyName'],
    ['companyRegistrationId'],
    ['phoneNumber'],
    ['businessEmail'],
  ] as const)('blocks and opens the dialog when %s is missing', (field) => {
    const setShowBusinessDialog = vi.fn();
    const showErrorToast = vi.fn();

    const ok = validateMonthlyStatementPdfPrerequisites(
      { ...COMPLETE_BUSINESS, [field]: '' },
      'generate',
      setShowBusinessDialog,
      showErrorToast,
    );

    expect(ok).toBe(false);
    expect(setShowBusinessDialog).toHaveBeenCalledWith(true);
    expect(showErrorToast).toHaveBeenCalledWith(
      'Please configure business details before generating PDF',
    );
  });

  it('words the message for the export action', () => {
    const showErrorToast = vi.fn();

    validateMonthlyStatementPdfPrerequisites({}, 'export', vi.fn(), showErrorToast);

    expect(showErrorToast).toHaveBeenCalledWith(
      'Please configure business details before exporting PDF',
    );
  });
});

describe('downloadMonthlyStatementPdf', () => {
  it('anchors the fetched blob under the requested filename and clicks it', async () => {
    const clicks: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push(`${this.href}|${this.download}|${this.style.display}`);
      });

    await downloadMonthlyStatementPdf(FILE_URL, 'march-2026-margaret.pdf');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual(['blob:statement-1|march-2026-margaret.pdf|none']);
    clickSpy.mockRestore();
  });

  it('falls back to monthly-statement.pdf when no filename is supplied', async () => {
    let downloadAttr = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadAttr = this.download;
      });

    await downloadMonthlyStatementPdf(FILE_URL);

    expect(downloadAttr).toBe('monthly-statement.pdf');
    clickSpy.mockRestore();
  });

  it('leaves the anchor in the document until the 100ms cleanup timer fires', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await downloadMonthlyStatementPdf(FILE_URL, 'x.pdf');

    expect(document.querySelectorAll('a[download="x.pdf"]')).toHaveLength(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(document.querySelectorAll('a[download="x.pdf"]')).toHaveLength(0);
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:statement-1');
    clickSpy.mockRestore();
  });
});

describe('captureChartsForPdf', () => {
  // 170 / 125.8 — the aspect of the summary table the composite has to match.
  const SUMMARY_TABLE_ASPECT = 1.3513513513513513;

  function makeCard(withInnerContainer: boolean): HTMLElement {
    const card = document.createElement('div');
    if (withInnerContainer) {
      const inner = document.createElement('div');
      inner.setAttribute('data-pdf-chart-container', 'true');
      card.appendChild(inner);
    }
    return card;
  }

  function makeCollaborators() {
    return {
      captureChartAsLightPng: vi.fn(async (el: HTMLElement) => `png:${el.dataset.tag ?? 'untagged'}`),
      compositeChartImages: vi.fn(async () => 'data:image/png;base64,COMPOSITE'),
      getPdfChartCellSize: vi.fn((cols: number) => ({ width: cols * 100, height: cols * 60 })),
      waitForFontsAndNextPaint: vi.fn(async () => {}),
    };
  }

  it('captures the inner pdf container of each card with data and composites at 2 columns', async () => {
    const configs = [{ hasData: true }, { hasData: false }, { hasData: true }];
    const cardA = makeCard(true);
    (cardA.firstElementChild as HTMLElement).dataset.tag = 'A-inner';
    const cardB = makeCard(true);
    const cardC = makeCard(true);
    (cardC.firstElementChild as HTMLElement).dataset.tag = 'C-inner';
    const refs = { current: [cardA, cardB, cardC] };
    const c = makeCollaborators();

    const result = await captureChartsForPdf(
      configs.filter((x) => x.hasData),
      configs,
      refs,
      c.captureChartAsLightPng,
      c.compositeChartImages,
      c.getPdfChartCellSize,
      c.waitForFontsAndNextPaint,
    );

    expect(c.waitForFontsAndNextPaint).toHaveBeenCalledTimes(1);
    // Card B has no data, so its element is never captured.
    expect(c.captureChartAsLightPng).toHaveBeenCalledTimes(2);
    expect(c.getPdfChartCellSize).toHaveBeenCalledWith(2);
    expect(c.compositeChartImages).toHaveBeenCalledWith(
      ['png:A-inner', 'png:C-inner'],
      2,
      { width: 200, height: 120 },
      { targetAspect: SUMMARY_TABLE_ASPECT, background: 'white', gap: 0, fit: 'contain' },
    );
    expect(result).toBe('data:image/png;base64,COMPOSITE');
  });

  it('captures the card itself when it has no inner pdf container', async () => {
    const configs = [{ hasData: true }];
    const bare = makeCard(false);
    bare.dataset.tag = 'bare-card';
    const c = makeCollaborators();

    await captureChartsForPdf(
      configs,
      configs,
      { current: [bare] },
      c.captureChartAsLightPng,
      c.compositeChartImages,
      c.getPdfChartCellSize,
      c.waitForFontsAndNextPaint,
    );

    expect(c.captureChartAsLightPng).toHaveBeenCalledWith(bare);
  });

  it.each([
    [1, 2],
    [2, 2],
    [3, 3],
    [4, 2],
    [5, 3],
  ])('lays %i charts out in %i columns', async (count, expectedCols) => {
    const configs = Array.from({ length: count }, () => ({ hasData: true }));
    const cards = configs.map(() => makeCard(true));
    const c = makeCollaborators();

    await captureChartsForPdf(
      configs,
      configs,
      { current: cards },
      c.captureChartAsLightPng,
      c.compositeChartImages,
      c.getPdfChartCellSize,
      c.waitForFontsAndNextPaint,
    );

    expect(c.compositeChartImages.mock.calls[0][1]).toBe(expectedCols);
  });

  it('returns undefined without compositing when every ref slot is empty', async () => {
    const configs = [{ hasData: true }, { hasData: true }];
    const c = makeCollaborators();

    const result = await captureChartsForPdf(
      configs,
      configs,
      { current: [null, null] },
      c.captureChartAsLightPng,
      c.compositeChartImages,
      c.getPdfChartCellSize,
      c.waitForFontsAndNextPaint,
    );

    expect(result).toBeUndefined();
    expect(c.compositeChartImages).not.toHaveBeenCalled();
  });
});

describe('executeMonthlyStatementPdfAction', () => {
  const STATEMENT_DATA = {
    participant: 'Margaret Chen',
    month: 'March',
    monthNumber: '03',
    year: '2026',
    summary: { totalServices: 4, govSubsidy: 1_200, participantContribution: 150 },
  };

  function makeArgs(overrides: Record<string, unknown> = {}) {
    const toasts = makeToasts();
    const post = vi.fn(async () => ({
      data: { fileUrl: FILE_URL, filename: 'march-2026-margaret.pdf' },
    }));

    return {
      toasts,
      post,
      setShowBusinessDialog: vi.fn(),
      args: {
        action: 'generate' as const,
        statementData: { ...STATEMENT_DATA },
        businessDetails: COMPLETE_BUSINESS,
        selectedMonth: '05',
        selectedYear: '2025',
        businessTimezone: 'Australia/Sydney',
        chartConfigs: [] as Array<{ hasData: boolean }>,
        chartCardRefs: { current: [] as Array<HTMLElement | null> },
        id: 'ws-77',
        boardId: 'board-9',
        getSelectedMonthDateRange: () => ({
          startDate: '2026-03-01T00:00:00+11:00',
          endDate: '2026-03-31T23:59:59+11:00',
        }),
        captureChartAsLightPng: vi.fn(async () => 'png:chart'),
        compositeChartImages: vi.fn(async () => 'data:image/png;base64,COMPOSITE'),
        getPdfChartCellSize: vi.fn(() => ({ width: 200, height: 120 })),
        waitForFontsAndNextPaint: vi.fn(async () => {}),
        axios: { post } as never,
        showErrorToast: toasts.showErrorToast,
        showSuccessToast: toasts.showSuccessToast,
        showInfoToast: toasts.showInfoToast,
        setShowBusinessDialog: vi.fn(),
        ...overrides,
      },
    };
  }

  it('posts the statement, date range, business details and timezone the server renders from', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { args, post, toasts } = makeArgs();

    const fileUrl = await executeMonthlyStatementPdfAction(args);

    expect(fileUrl).toBe(FILE_URL);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('undefined/api/pdf/ws-77/board-9/monthly-statement');
    expect(post.mock.calls[0][1]).toEqual({
      statementData: {
        participant: 'Margaret Chen',
        month: 'March',
        monthNumber: '03',
        year: '2026',
        summary: { totalServices: 4, govSubsidy: 1200, participantContribution: 150 },
      },
      startDate: '2026-03-01T00:00:00+11:00',
      endDate: '2026-03-31T23:59:59+11:00',
      businessDetails: COMPLETE_BUSINESS,
      timezone: 'Australia/Sydney',
    });
    expect(post.mock.calls[0][2]).toEqual({
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-User-Action': 'Generate Monthly Statement PDF',
      },
    });
    expect(toasts.showSuccessToast).toHaveBeenCalledWith(
      'Monthly statement PDF downloaded successfully',
    );
    clickSpy.mockRestore();
  });

  it('falls back to the selected month and year when the statement carries neither', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { args, post } = makeArgs();
    args.statementData = { participant: 'Margaret Chen' };

    await executeMonthlyStatementPdfAction(args);

    expect((post.mock.calls[0][1] as any).statementData).toEqual({
      participant: 'Margaret Chen',
      monthNumber: '05',
      year: '2025',
    });
    clickSpy.mockRestore();
  });

  it('labels the request and the toast differently for an export', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { args, post, toasts } = makeArgs();
    args.action = 'export';

    await executeMonthlyStatementPdfAction(args);

    expect((post.mock.calls[0][2] as any).headers['X-User-Action']).toBe(
      'Export Monthly Statement PDF',
    );
    expect(toasts.showSuccessToast).toHaveBeenCalledWith('PDF exported successfully');
    clickSpy.mockRestore();
  });

  it('attaches the composited chart image when at least one chart has data', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const card = document.createElement('div');
    const { args, post } = makeArgs();
    args.chartConfigs = [{ hasData: true }];
    args.chartCardRefs = { current: [card] };

    await executeMonthlyStatementPdfAction(args);

    expect((post.mock.calls[0][1] as any).chartImage).toBe('data:image/png;base64,COMPOSITE');
    clickSpy.mockRestore();
  });

  it('omits chartImage entirely when capture throws, and still posts', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const card = document.createElement('div');
    const { args, post } = makeArgs();
    args.chartConfigs = [{ hasData: true }];
    args.chartCardRefs = { current: [card] };
    args.captureChartAsLightPng = vi.fn(async () => {
      throw new Error('canvas unavailable');
    });

    const fileUrl = await executeMonthlyStatementPdfAction(args);

    expect(fileUrl).toBe(FILE_URL);
    expect(post.mock.calls[0][1]).not.toHaveProperty('chartImage');
    expect(warnSpy).toHaveBeenCalledWith('Chart capture for PDF failed:', expect.any(Error));
    clickSpy.mockRestore();
  });

  it('never posts when the business details are incomplete', async () => {
    const { args, post, toasts } = makeArgs();
    args.businessDetails = { ...COMPLETE_BUSINESS, businessEmail: '' };

    const result = await executeMonthlyStatementPdfAction(args);

    expect(result).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(args.setShowBusinessDialog).toHaveBeenCalledWith(true);
    expect(toasts.showErrorToast).toHaveBeenCalledWith(
      'Please configure business details before generating PDF',
    );
  });

  it('never posts when the selected month and year yield no date range', async () => {
    const { args, post, toasts } = makeArgs();
    args.getSelectedMonthDateRange = () => null;

    const result = await executeMonthlyStatementPdfAction(args);

    expect(result).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(toasts.showErrorToast).toHaveBeenCalledWith(
      'Please choose a valid month and year before generating PDF.',
    );
  });

  it('reports a response with no fileUrl instead of trying to download it', async () => {
    const { args, toasts } = makeArgs();
    (args.axios as any).post = vi.fn(async () => ({ data: { filename: 'x.pdf' } }));

    const result = await executeMonthlyStatementPdfAction(args);

    expect(result).toBeNull();
    expect(toasts.showErrorToast).toHaveBeenCalledWith('Failed to retrieve PDF link from server.');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('opens the PDF in a new tab when the blob download fails, and still returns the url', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    createObjectURL.mockImplementation(() => {
      throw new Error('no object urls here');
    });
    const { args, toasts } = makeArgs();

    const result = await executeMonthlyStatementPdfAction(args);

    expect(result).toBe(FILE_URL);
    expect(openSpy).toHaveBeenCalledWith(FILE_URL, '_blank');
    expect(toasts.showInfoToast).toHaveBeenCalledWith('PDF opened in new tab', {
      description: 'Download failed, opened PDF in new tab instead.',
    });
    expect(toasts.showSuccessToast).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('reports a rejected post as a generation failure', async () => {
    const { args, toasts } = makeArgs();
    (args.axios as any).post = vi.fn(async () => {
      throw new Error('502 Bad Gateway');
    });

    const result = await executeMonthlyStatementPdfAction(args);

    expect(result).toBeNull();
    expect(toasts.showErrorToast).toHaveBeenCalledWith('Failed to generate PDF. Please try again.');
    expect(toasts.showSuccessToast).not.toHaveBeenCalled();
  });
});
