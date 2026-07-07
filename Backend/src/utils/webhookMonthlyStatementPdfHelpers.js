import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildMonthlyStatementDeps(deps) { return deps; }

function bucketMonthlyStatementServices(services, deps) {
  const { createServiceBuckets, determineFundingCode, normalizeStatus } = deps;
  const serviceBuckets = createServiceBuckets();
  for (const service of services) {
    const code = determineFundingCode(service);
    const bucket = serviceBuckets[code];
    if (!bucket) continue;
    const status = normalizeStatus(service.transactionStatus);
    const isCommitted = !!service.committedAtHmForDelivery;
    if (isCommitted && Array.isArray(bucket.committed)) { bucket.committed.push(service); continue; }
    if ((status.includes('adjust') || status.includes('refund') || status.includes('charge')) && Array.isArray(bucket.adjustment)) {
      bucket.adjustment.push(service); continue;
    }
    if ((status.includes('delivered') || status.includes('cancelled')) && Array.isArray(bucket.delivered)) {
      bucket.delivered.push(service); continue;
    }
    if (!status && Array.isArray(bucket.delivered)) bucket.delivered.push(service);
  }
  return serviceBuckets;
}

function fillMonthlyStatementServiceTables(templateInputs, serviceBuckets, business, timezone, deps) {
  const { SERVICE_TABLE_CONFIG, buildServiceTableRows, setCurrencyField } = deps;
  const tableColumnCounts = {};
  for (const [code, tableConfig] of Object.entries(SERVICE_TABLE_CONFIG)) {
    const bucket = serviceBuckets[code];
    if (!bucket) continue;
    for (const config of Object.values(tableConfig)) {
      const tableData = buildServiceTableRows(bucket[config.rowType] || [], config, business, timezone);
      templateInputs[config.tableName] = JSON.stringify(tableData.rows);
      tableColumnCounts[config.tableName] = config.columns.length;
      const totalValues = [tableData.totals.amount, tableData.totals.gov, tableData.totals.participant];
      config.totals.forEach((fieldName, index) => {
        const value = totalValues[Math.min(index, totalValues.length - 1)] || 0;
        const targets = Array.isArray(fieldName) ? fieldName : [fieldName];
        targets.forEach((f) => setCurrencyField(templateInputs, f, value));
      });
    }
  }
  return tableColumnCounts;
}


function sanitizeMonthlyStatementTableInputs(templateInputs, tableColumnCounts, deps) {
  const { normalizeTableCell } = deps;
  for (const [key, value] of Object.entries(templateInputs)) {
    if (!key.startsWith('Table ')) continue;
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : (Array.isArray(value) ? value : []);
      const columnCount = tableColumnCounts[key] ?? (Array.isArray(parsed[0]) ? parsed[0].length : 8);
      const rows = (!Array.isArray(parsed) || parsed.length === 0)
        ? [Array.from({ length: columnCount }, (_, i) => (i === 1 ? 'No services recorded for this period' : ''))]
        : parsed;
      templateInputs[key] = JSON.stringify(rows.map((row) => {
        const padded = [...(Array.isArray(row) ? row : [])];
        while (padded.length < columnCount) padded.push('');
        padded.length = columnCount;
        return padded.map((cell) => {
          const normalized = normalizeTableCell(cell);
          return typeof normalized === 'string' ? normalized : '';
        });
      }));
    } catch {
      const emptyRow = Array(tableColumnCounts[key] || 8).fill('');
      emptyRow[1] = 'No data available';
      templateInputs[key] = JSON.stringify([emptyRow]);
    }
  }
}

function withSupplementLabel(aggregate, deps) {
  const { safeString, initializeBudgetAggregate } = deps;
  const next = aggregate ? { ...aggregate } : initializeBudgetAggregate();
  next.primarySupplementLabel = safeString(next.primarySupplementLabel) || safeString(next.fund) || safeString(next.fundClassification) || '';
  return next;
}

function applyHomeSupportBudgetMappings(templateInputs, budgetAggregates, deps) {
  const { applyBudgetMapping } = deps;
  const agg = withSupplementLabel(budgetAggregates.HSQ, deps);
  applyBudgetMapping(templateInputs, agg, [
    { type: 'multi', field: 'P2-3', value: (a) => ({ 'Primary Supplement': a.primarySupplementLabel || 'N/A' }) },
    { type: 'currency', field: '$P2-1', value: (a) => a.availableFundStart },
    { type: 'currency', field: '$P2-2', value: (a) => a.quarterlyAdjustment },
    { type: 'currency', field: '$P2-3', value: (a) => (a.primarySupplementAmount ?? 0) },
    { type: 'currency', field: '$P2-4', value: (a) => a.carryoverFunding + a.unspentReturned },
    { type: 'currency', field: '$P2-6', value: (a) => a.commonwealthUnspent + a.providerUnspent + a.participantUnspent },
    { type: 'currency', field: ['$P2-6 copy copy', '$P4-8'], value: (a) => a.commonwealthUnspent },
    { type: 'currency', field: ['$P2-7 copy copy', '$P4-9'], value: (a) => a.providerUnspent },
    { type: 'currency', field: ['$P2-8 copy copy', '$P4-10'], value: (a) => a.participantUnspent },
    { type: 'currency', field: '$P2-9', value: (a) => a.previousMonthSpending },
    { type: 'currency', field: '$P2-10', value: (a) => a.totalAvailableBudget },
    { type: 'currency', field: '$P2-11', value: (a) => a.totalAvailableBudget },
    { type: 'currency', field: '$P2-12', value: (a) => a.deliveredAmount },
    { type: 'currency', field: '$P2-13', value: (a) => a.adjustmentAmount },
    { type: 'currency', field: '$P2-14', value: (a) => a.remainingBalance },
    { type: 'currency', field: ['$P2-14 copy', '$P4-11'], value: (a) => a.commonwealthUnspent + a.providerUnspent + a.participantUnspent },
    { type: 'currency', field: ['$P7-4 copy', '$P4-5'], value: (a) => a.carryoverFunding },
    { type: 'currency', field: ['$P7-5 copy', '$P4-6'], value: (a) => a.unspentReturned },
    { type: 'currency', field: ['$P7-6 copy', '$P4-7'], value: (a) => a.carryoverFunding + a.unspentReturned },
  ]);
}

function applyRestorativeAndEolBudgetMappings(templateInputs, budgetAggregates, timezone, deps) {
  const { applyBudgetMapping, setMultiValueField, formatDateToAU } = deps;
  const restorative = withSupplementLabel(budgetAggregates.RCP, deps);
  applyBudgetMapping(templateInputs, restorative, [
    { type: 'multi', field: 'P3-2', value: (a) => ({ 'Primary Supplement': a.primarySupplementLabel || 'N/A' }) },
    { type: 'currency', field: '$P3-1', value: (a) => a.availableFundStart },
    { type: 'currency', field: '$P3-2', value: (a) => (a.primarySupplementAmount ?? 0) },
    { type: 'currency', field: '$P3-6', value: (a) => a.previousMonthSpending },
    { type: 'currency', field: '$P3-7', value: (a) => a.totalAvailableBudget },
    { type: 'currency', field: '$P3-8', value: (a) => a.deliveredAmount },
    { type: 'currency', field: '$P3-9', value: (a) => a.adjustmentAmount },
    { type: 'currency', field: '$P3-10', value: (a) => a.remainingBalance },
  ]);
  setMultiValueField(templateInputs, 'P3 Subtitle', {
    ' Funding Start Date': formatDateToAU(restorative.fundingStartDate, timezone) || 'N/A',
    ' Funding end date': formatDateToAU(restorative.fundingEndDate, timezone) || 'N/A',
  });
  const eol = withSupplementLabel(budgetAggregates.EOL, deps);
  applyBudgetMapping(templateInputs, eol, [
    { type: 'multi', field: 'P3-12 copy', value: (a) => ({ 'Primary Supplement': a.primarySupplementLabel || 'N/A' }) },
    { type: 'currency', field: '$P3-11 copy', value: (a) => a.availableFundStart },
    { type: 'currency', field: '$P3-12 copy', value: (a) => (a.primarySupplementAmount ?? 0) },
    { type: 'currency', field: '$P3-16 copy', value: (a) => a.previousMonthSpending },
    { type: 'currency', field: '$P3-17 copy', value: (a) => a.totalAvailableBudget },
    { type: 'currency', field: '$P3-18 copy', value: (a) => a.deliveredAmount },
    { type: 'currency', field: '$P3-19 copy', value: (a) => a.adjustmentAmount },
    { type: 'currency', field: '$P3-20 copy', value: (a) => a.remainingBalance },
  ]);
  setMultiValueField(templateInputs, 'P3 Subtitle copy', {
    ' Funding Start Date': formatDateToAU(eol.fundingStartDate, timezone) || 'N/A',
    ' Funding end date': formatDateToAU(eol.fundingEndDate, timezone) || 'N/A',
  });
}

function applyAssistiveBudgetMappings(templateInputs, budgetAggregates, timezone, deps) {
  const { applyBudgetMapping, formatDateToAU } = deps;
  const ats = withSupplementLabel(budgetAggregates.ATS, deps);
  applyBudgetMapping(templateInputs, ats, [
    { type: 'multi', field: 'P4-2 copy', value: (a) => ({ 'Primary Supplement': a.primarySupplementLabel || 'N/A' }) },
    { type: 'currency', field: ['$P4-1  copy', '$P5-1'], value: (a) => a.availableFundStart },
    { type: 'currency', field: ['$P4-2 copy', '$P5-2'], value: (a) => (a.primarySupplementAmount ?? 0) },
    { type: 'currency', field: ['$P4-3 copy', '$P5-3'], value: (a) => (a.additionalAmountApproved ?? a.fundAmount ?? 0) },
    { type: 'currency', field: ['$P4-7 copy', '$P5-7'], value: (a) => a.previousMonthSpending },
    { type: 'currency', field: ['$P4-8 copy', '$P5-8'], value: (a) => a.totalAvailableBudget },
    { type: 'currency', field: ['$P4-9 copy', '$P5-9'], value: (a) => a.deliveredAmount },
    { type: 'currency', field: ['$P4-10 copy', '$P5-10'], value: (a) => a.adjustmentAmount },
    { type: 'currency', field: ['$P4-11 copy', '$P5-11'], value: (a) => a.remainingBalanceEndOfMonth ?? 0 },
    { type: 'currency', field: ['$P4-12 copy', '$P5-12'], value: (a) => a.committedFunds },
    { type: 'currency', field: ['$P4-13 copy', '$P5-13'], value: (a) => (a.remainingBalanceAllocationPeriod ?? 0) },
    { type: 'multi', field: 'P4 Footer 1 copy', value: (a) => ({ 'Funding End Date': formatDateToAU(a.fundingEndDate, timezone) || 'N/A' }) },
  ]);
  const ato = withSupplementLabel(budgetAggregates.ATO, deps);
  applyBudgetMapping(templateInputs, ato, [
    { type: 'multi', field: 'P4-15 copy', value: (a) => ({ 'Primary Supplement': a.primarySupplementLabel || 'N/A' }) },
    { type: 'currency', field: ['$P4-14 copy', '$P5-14'], value: (a) => a.availableFundStart },
    { type: 'currency', field: ['$P4-15 copy', '$P5-15'], value: (a) => (a.primarySupplementAmount ?? 0) },
    { type: 'currency', field: ['$P4-19 copy', '$P5-19'], value: (a) => a.previousMonthSpending },
    { type: 'currency', field: ['$P4-20 copy', '$P5-20'], value: (a) => a.totalAvailableBudget },
    { type: 'currency', field: ['$P4-21 copy', '$P5-21'], value: (a) => a.deliveredAmount },
    { type: 'currency', field: ['$P4-22 copy', '$P5-22'], value: (a) => a.adjustmentAmount },
    { type: 'currency', field: ['$P4-23 copy', '$P5-23'], value: (a) => a.remainingBalanceEndOfMonth ?? 0 },
    { type: 'currency', field: ['$P4-24 copy', '$P5-24'], value: (a) => a.committedFunds },
    { type: 'currency', field: ['$P4-25 copy', '$P5-25'], value: (a) => (a.remainingBalanceAllocationPeriod ?? 0) },
    { type: 'multi', field: 'P4 Footer 2 copy', value: (a) => ({ 'Funding End Date': formatDateToAU(a.fundingEndDate, timezone) || 'N/A' }) },
  ]);
  const hmb = withSupplementLabel(budgetAggregates.HMB, deps);
  applyBudgetMapping(templateInputs, hmb, [
    { type: 'multi', field: 'P5- copy', value: (a) => ({ 'Primary Supplement': a.primarySupplementLabel || 'N/A' }) },
    { type: 'currency', field: '$P5-1 copy', value: (a) => a.availableFundStart },
    { type: 'currency', field: '$P5-2 copy', value: (a) => (a.primarySupplementAmount ?? 0) },
    { type: 'currency', field: '$P5-6 copy', value: (a) => a.previousMonthSpending },
    { type: 'currency', field: '$P5-7 copy', value: (a) => a.totalAvailableBudget },
    { type: 'currency', field: '$P5-8 copy', value: (a) => a.deliveredAmount },
    { type: 'currency', field: '$P5-9 copy', value: (a) => a.adjustmentAmount },
    { type: 'currency', field: '$P5-10 copy', value: (a) => a.remainingBalanceEndOfMonth ?? a.remainingBalance },
    { type: 'currency', field: '$P5-11 copy', value: (a) => a.committedFunds },
    { type: 'currency', field: '$P5-12 copy', value: (a) => (a.remainingBalanceAllocationPeriod ?? 0) },
    { type: 'multi', field: 'P4 Footer 2 copy copy', value: (a) => ({ 'Funding End Date': formatDateToAU(a.fundingEndDate, timezone) || 'N/A' }) },
  ]);
}

function applyAllMonthlyStatementBudgetMappings(templateInputs, budgetAggregates, timezone, deps) {
  applyHomeSupportBudgetMappings(templateInputs, budgetAggregates, deps);
  applyRestorativeAndEolBudgetMappings(templateInputs, budgetAggregates, timezone, deps);
  applyAssistiveBudgetMappings(templateInputs, budgetAggregates, timezone, deps);
}

export async function handleMonthlyStatementRoute(req, res, deps) {
  const { workspaceId, boardId } = req.params;
  const { statementData, businessDetails, chartImage, timezone: clientTimezone, startDate: requestStartDate, endDate: requestEndDate } = req.body;
  if (!statementData) return res.status(400).json({ message: 'No statement data provided.' });
  try {
    return await generateMonthlyStatementPdf(req, res, { workspaceId, boardId, statementData, businessDetails, chartImage, clientTimezone, requestStartDate, requestEndDate, deps });
  } catch (err) {
    const errorMessage = err?.message || 'Server error: An unknown error occurred. Please contact support via ISO+™ Portal.';
    deps.error('Webhook-Service', 'Error generating monthly statement PDF', { message: errorMessage, stack: err.stack }, req ?? null);
    return res.status(500).json({ message: errorMessage, error: err.message });
  }
}

async function populateMonthlyStatementVisualAndHeaderFields({
  template, templateInputs, statementData, businessDetails, chartImage, safeBusinessDetails,
  quarterMeta, subtitlePayload, yearValue, deps, req,
}) {
  const { path, fs, setMultiValueField, info, warn } = deps;
  // Summary Table: use chart image from frontend when provided; hide if all values $0.00; else mini-chart
  const hasChartFromFrontend = chartImage && typeof chartImage === 'string' && chartImage.length > 50;
  const chartBudgetCats = statementData.budgetCategories || [];
  const allCategoriesZero = chartBudgetCats.length === 0 || chartBudgetCats.every((c) => {
      const avail = Number(c.availableFunds ?? 0);
      const rem = Number(c.remainingBudget ?? 0);
      const del = Number(c.serviceDeliveredAmount ?? 0);
      return avail === 0 && rem === 0 && del === 0;
  });
  if (hasChartFromFrontend) {
      templateInputs['Summary Table'] = chartImage.startsWith('data:') ? chartImage : `data:image/png;base64,${chartImage}`;
      info('Webhook-Service', 'Monthly statement PDF: using chart image from frontend', { sizeChars: chartImage.length }, req ?? null);
  } else if (!hasChartFromFrontend && allCategoriesZero) {
      // Hide bar chart section when not applicable (all values $0.00)
      templateInputs['Summary Table'] = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  } else {
      const miniChartPath = path.join(__dirname, '..', 'assets', 'mini-chart.png');
      try {
          const miniChartBuffer = await fs.readFile(miniChartPath);
          templateInputs['Summary Table'] = `data:image/png;base64,${miniChartBuffer.toString('base64')}`;
      } catch (miniChartErr) {
          warn('Webhook-Service', 'Monthly statement mini-chart not found, using template default for Summary Table', { path: miniChartPath }, req ?? null);
      }
  }

  const footerImagePath = path.join(__dirname, '..', 'assets', 'monthly-statement-footer.png');
  try {
      const footerBuffer = await fs.readFile(footerImagePath);
      templateInputs['Image 13-1'] = `data:image/png;base64,${footerBuffer.toString('base64')}`;
  } catch (footerErr) {
      warn('Webhook-Service', 'Monthly statement footer image not found, using template default', { path: footerImagePath }, req ?? null);
  }

  setMultiValueField(templateInputs, 'companyName', { 'Company Name': safeBusinessDetails.companyName });

  const participantName = statementData.participant || statementData.participantProfile || 'Participant';
  const participantAddress = statementData.participantAddress || '';
  const participantSuburb = statementData.participantSuburb || '';
  const participantState = statementData.participantState || '';
  const participantPostcode = statementData.participantPostcode || '';

  // Organisation block: Provider ID = Company Registration ID, Location = Street Address (Business Details)
  setMultiValueField(templateInputs, 'Organisation', {
      'Participant': participantName,
      'My Aged Care ID Number': statementData.myAgedCareIdNumber || '',
      'Provider ID': statementData.providerId || safeBusinessDetails.companyRegistrationId || '',
      'Address': safeBusinessDetails.address || '',
      'Suburb': safeBusinessDetails.suburb || '',
      'Post Code': safeBusinessDetails.postcode || '',
      'State': safeBusinessDetails.state || ''
  });

  setMultiValueField(templateInputs, 'Recipient', {
      'Participant': participantName,
      'Address': participantAddress,
      'Suburb': participantSuburb,
      'State': participantState,
      'Post Code': participantPostcode
  });

  setMultiValueField(templateInputs, 'Text title', {
      month: statementData.month || '',
      year: yearValue
  });

  // Populate all subtitle fields in the template with quarter metadata
  const allSubtitleFields = [
      'P2 Subtitle',
      'P3 Subtitle', 'P3 Subtitle copy',
      'P4 Subtitle copy',
      'P5 Subtitle copy',
      'P7 Subtitle 1 copy', 'P7 Subtitle  2 copy', 'P7 Subtitle  2 copy 2', 'P7 Subtitle  2 copy copy',
      'P8 Subtitle  copy',
      'P9 Subtitle', 'P9 Subtitle copy', 'P9 Subtitle-2',
      'P10 Subtitle copy', 'P10 Subtitle-2 copy',
      'P11 Subtitle copy', 'P11 Subtitle-2 copy',
      'P12 Subtitle  copy', 'P12 Subtitle-2  copy', 'P12 Subtitle-2  copy copy'
  ];
  allSubtitleFields.forEach((field) => {
      setMultiValueField(templateInputs, field, subtitlePayload);
  });

  // Page 1 and Page 14 contact: Phone Number and Business Email from Business Details (ISO+ Portal)
  const businessContactPayload = {
      'Phone Number': safeBusinessDetails.phoneNumber || '',
      'Business Email': safeBusinessDetails.businessEmail || ''
  };
  setMultiValueField(templateInputs, 'Disclaimer 2a', businessContactPayload);
  setMultiValueField(templateInputs, 'Text 13-', businessContactPayload);

  const firstDayPayload = { 'first day': quarterMeta.firstDay };
  const lastDayPayload = { 'last day': quarterMeta.lastDay };
  [
      'P2-10', 'P2-11',
      'P2-11 copy',
      'P4-8 copy',
      'P4-20 copy',
      'P5-7 copy',
      'P5-8', 'P5-20',
      'P3-7',
      'P3-17 copy'
  ].forEach((f) => setMultiValueField(templateInputs, f, firstDayPayload));
  [
      'P2-14', 'P2-14 copy',
      'P4-11 copy',
      'P4-23 copy',
      'P5-10 copy',
      'P5-11', 'P5-23',
      'P3-10',
      'P3-20 copy'
  ].forEach((f) => setMultiValueField(templateInputs, f, lastDayPayload));

}

function resolveMonthlyStatementDates(requestStartDate, requestEndDate, monthNum, yearVal, timezone) {
  const normalizeIsoOrNull = (value) => {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  };

  let startDate = normalizeIsoOrNull(requestStartDate);
  let endDate = normalizeIsoOrNull(requestEndDate);

  // Guard against inverted ranges; fallback to computed month range.
  if (startDate && endDate) {
      const s = new Date(startDate);
      const e = new Date(endDate);
      if (s.getTime() > e.getTime()) {
          startDate = null;
          endDate = null;
      }
  }

  // Fallback: compute a timezone-aware month range when request didn't provide valid dates.
  if ((!startDate || !endDate) && monthNum && yearVal) {
      const mi = Number(monthNum) - 1, yi = Number(yearVal);
      if (!isNaN(mi) && !isNaN(yi)) {
          const getUtcOffsetMs = (at, timeZone) => {
              const toMs = (tz) => {
                  const parts = new Intl.DateTimeFormat('en-CA', {
                      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
                      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
                  }).formatToParts(at);
                  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? '0');
                  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
              };
              return toMs(timeZone) - toMs('UTC');
          };
          const lastDay = new Date(Date.UTC(yi, mi + 1, 0));
          const firstNoon = new Date(Date.UTC(yi, mi, 1, 12, 0, 0));
          const lastNoon = new Date(Date.UTC(yi, mi + 1, 0, 12, 0, 0));
          const startOffset = getUtcOffsetMs(firstNoon, timezone);
          const endOffset = getUtcOffsetMs(lastNoon, timezone);
          startDate = startDate || new Date(Date.UTC(yi, mi, 1) - startOffset).toISOString();
          endDate = endDate || new Date(Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate(), 23, 59, 59, 999) - endOffset).toISOString();
      }
  }

  return { startDate, endDate };
}

async function generateMonthlyStatementPdf(req, res, ctx) {
  const { workspaceId, boardId, statementData, businessDetails, chartImage, clientTimezone, requestStartDate, requestEndDate, deps } = ctx;
  const { path, fs, getValidatedBusiness, enableRepeatHeadOnTables, ensureMonthlyStatementHeaderFromPage2, getLogoData, resolveTemplateImageUrls, getTemplateImageContentByName, applyTemplateTextDefaults, calculateBudgetAggregates, enrichAggregateFromCategory, initializeBudgetAggregate, getQuarterMetadata, setMultiValueField, setCurrencyField, parseNumberValue, uploadFileToS3, getS3FileUrl, info, warn, fetchBudgetItems, fetchServiceItems, generate, text, image, line, table, multiVariableText } = deps;

  const business = await getValidatedBusiness(workspaceId);
  const timezone = business?.headOfficeTimezone || clientTimezone || 'Australia/Sydney';

  // Use the monthlyStatement.json template
  const templatePath = path.join(__dirname, '..', 'assets', 'monthlyStatement.json');
  const templateData = await fs.readFile(templatePath, 'utf8');
  const template = JSON.parse(templateData);
  enableRepeatHeadOnTables(template);
  ensureMonthlyStatementHeaderFromPage2(template);

  const logoBase64 = await getLogoData(business);

  const safeBusinessDetails = {
      companyName: businessDetails?.companyName || business.name || 'Service Provider',
      companyRegistrationId: businessDetails?.companyRegistrationId || business.companyRegistrationId || '',
      phoneNumber: businessDetails?.phoneNumber || business.phone || '',
      businessEmail: businessDetails?.businessEmail || business.email || '',
      address: businessDetails?.address || business.address?.street || '',
      suburb: businessDetails?.suburb || business.address?.suburb || '',
      state: businessDetails?.state || business.address?.state || '',
      postcode: businessDetails?.postcode || business.address?.postcode || ''
  };

  const participantProfileId = statementData.participantProfile || '';
  const queryParticipant = participantProfileId || statementData.participant || '';
  const participantName = statementData.participant || statementData.participantProfile || 'Participant';
  const monthNum = statementData.monthNumber || '';
  const yearVal = statementData.year || '';

  const { startDate, endDate } = resolveMonthlyStatementDates(requestStartDate, requestEndDate, monthNum, yearVal, timezone);

    const [budgetItems, services] = await Promise.all([
      fetchBudgetItems(workspaceId, boardId, { participant: queryParticipant, month: monthNum, year: yearVal }),
      fetchServiceItems(workspaceId, boardId, { participant: queryParticipant, startDate, endDate })
  ]);

  info('Webhook-Service', 'Monthly statement PDF: fetched ISO+ data', {
      budgetCount: budgetItems.length, serviceCount: services.length, queryParticipant
  }, req ?? null);

  const budgetAggregates = calculateBudgetAggregates(budgetItems);

  const budgetCategories = Array.isArray(statementData.budgetCategories) ? statementData.budgetCategories : [];
  for (const category of budgetCategories) {
      const code = category?.code;
      if (!code) continue;
      if (!budgetAggregates[code]) {
          budgetAggregates[code] = initializeBudgetAggregate();
      }
      enrichAggregateFromCategory(budgetAggregates[code], category);
  }

  const monthNumber = statementData.monthNumber || '1';
  const yearValue = statementData.year || new Date().getFullYear().toString();
  const firstAggregate = Object.values(budgetAggregates)[0] || {};
  const quarterLabel = statementData.summary?.quarter || firstAggregate.quarterLabel || '';
  const quarterMeta = getQuarterMetadata(monthNumber, yearValue, quarterLabel, timezone);

  const subtitlePayload = {
      'Month No.': quarterMeta.monthNo.toString(),
      'Quarter No': quarterMeta.quarterLabel,
      'First Day': quarterMeta.firstDay,
      'Last Day': quarterMeta.lastDay
  };

  const templateInputs = {};
  await resolveTemplateImageUrls(template, templateInputs);
  const templateDefaultLogo = getTemplateImageContentByName(template, 'logo');
  templateInputs.logo = logoBase64 || templateInputs.logo || templateDefaultLogo || '';

  const pageCount = Array.isArray(template?.schemas) ? template.schemas.length : 0;
  for (let p = 2; p <= pageCount; p++) {
      templateInputs[`headerMonthlyStatement_p${p}`] = 'Monthly Statement';
      templateInputs[`logoHeader_p${p}`] = templateInputs.logo;
  }

  await populateMonthlyStatementVisualAndHeaderFields({
    template, templateInputs, statementData, businessDetails, chartImage, safeBusinessDetails,
    quarterMeta, subtitlePayload, yearValue, deps, req,
  });

    applyAllMonthlyStatementBudgetMappings(templateInputs, budgetAggregates, timezone, deps);

  // Pre-initialize ALL template tables with empty rows to prevent pdfme errors
  // These are all table field names from monthlyStatement.json
  const allTemplateTables = [
      { name: 'Table P6-1 copy', columns: 8 },
      { name: 'Table P6-1 copy copy copy', columns: 3 },
      { name: 'Table P7-1 copy', columns: 8 },
      { name: 'Table P9-1', columns: 8 },
      { name: 'Table P9-2', columns: 8 },
      { name: 'Table P10-1  copy', columns: 8 },
      { name: 'Table P10-2 copy', columns: 8 },
      { name: 'Table P10-3 copy', columns: 8 },
      { name: 'Table P11-1  copy', columns: 8 },
      { name: 'Table P11-2 copy', columns: 8 },
      { name: 'Table P11-3  copy', columns: 8 },
      { name: 'Table P12-1  copy', columns: 8 },
      { name: 'Table P12-3  copy', columns: 8 },
      { name: 'Table P11-2 copy copy', columns: 8 },
      { name: 'Table P12-1  copy copy', columns: 8 },
      { name: 'Table P12-3  copy copy', columns: 8 }
  ];

  allTemplateTables.forEach(({ name, columns }) => {
      const emptyRow = Array(columns).fill('');
      if (columns === 3) {
          emptyRow[0] = '';
          emptyRow[1] = 'No services recorded for this period';
          emptyRow[2] = '';
      } else {
          emptyRow[1] = 'No services recorded for this period';
      }
      templateInputs[name] = JSON.stringify([emptyRow]);
  });

  // Fill Table P6-1 copy copy copy (Care Management table - Table 3-1) with HSCM budget data
  // Aggregate all HSCM items into a single row with total hours for the month
  const hscmBudgetItems = budgetItems.filter(item => item.categoryCode === 'HSCM');
  if (hscmBudgetItems.length > 0) {
      // Table has 3 columns: Care Management (service name), Unit, Quantity
      const totalAllocatedTime = hscmBudgetItems.reduce((sum, item) =>
          sum + parseNumberValue(item.hscmAllocatedTime || 0), 0);
      const hscmRows = [['Care Management', 'Hours', totalAllocatedTime !== 0 ? totalAllocatedTime.toFixed(1) : '0.0']];
      templateInputs['Table P6-1 copy copy copy'] = JSON.stringify(hscmRows);
  } else {
      // No HSCM items - show empty message
      templateInputs['Table P6-1 copy copy copy'] = JSON.stringify([['', 'No services recorded for this period', '']]);
  }

  const serviceBuckets = bucketMonthlyStatementServices(services, deps);

    

  const tableColumnCounts = fillMonthlyStatementServiceTables(templateInputs, serviceBuckets, business, timezone, deps);

  sanitizeMonthlyStatementTableInputs(templateInputs, tableColumnCounts, deps);

  applyTemplateTextDefaults(template, templateInputs);

  const pdfBytes = await generate({
      template,
      inputs: [templateInputs],
      plugins: { text, image, line, table, multiVariableText }
  });

  // Upload the PDF
  const participantSlug = participantName.replace(/[^a-zA-Z0-9]/g, '-');
  const monthYear = `${statementData.month || 'Month'}_${yearValue || 'Year'}`.replace(/\s+/g, '_');
  const filename = `output/${workspaceId}/${boardId}/monthly-statements/${participantSlug}_${monthYear}_Statement.pdf`;
  const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename, true);

  if (uploadResult['$metadata'].httpStatusCode === 200) {
      const fileUrl = await getS3FileUrl(filename, 3600, true);

      info('Webhook-Service', 'Monthly statement PDF generated successfully', {
          participant: participantName,
          month: statementData.month,
          year: statementData.year,
          servicesCount: services.length,
          budgetItemsCount: budgetItems.length,
          fileUrl
      }, req ?? null);

      return res.status(200).json({
          message: 'Monthly statement PDF generated successfully',
          fileUrl,
          filename: `${participantSlug}_${monthYear}_Statement.pdf`
      });
  } else {
      throw new Error('Upload of PDF failed, please provide correct information.');
  }
}
