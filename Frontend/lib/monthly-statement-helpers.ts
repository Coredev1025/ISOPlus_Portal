export function validateStatementDateInputs(
  monthNum: number,
  yearNum: number,
  currentYear: number,
): string | null {
  if (monthNum < 1 || monthNum > 12) {
    return 'Please select a valid month (01-12)';
  }
  if (yearNum > currentYear + 1) {
    return 'Cannot generate statements for future years beyond next year';
  }
  if (yearNum < currentYear - 10) {
    return 'Cannot generate statements for years more than 10 years ago';
  }
  return null;
}

export function groupBudgetItemsByFolder(
  budgetItems: { items?: Record<string, { items?: unknown[] }> } | undefined,
) {
  if (!budgetItems?.items) {
    return { grouped: {} as Record<string, unknown[]>, flat: [] as unknown[] };
  }

  const grouped = Object.entries(budgetItems.items).reduce(
    (acc, [folderName, group]) => {
      const groupItems = Array.isArray(group?.items) ? group.items : [];
      if (groupItems.length > 0) {
        acc[folderName] = groupItems;
      }
      return acc;
    },
    {} as Record<string, unknown[]>,
  );

  return { grouped, flat: Object.values(grouped).flat() };
}

export function buildStatementSummary(
  services: Array<{ unit?: string; quantity?: number; totalAmount?: number; govSubsidy?: number; participantContribution?: number }>,
  backendSummary?: {
    totalServices?: number;
    totalHours?: number;
    totalAmount?: number;
    govSubsidy?: number;
    participantContribution?: number;
  },
) {
  const fallbackSummary = {
    totalServices: services.length,
    totalHours: services.reduce(
      (sum, s) => sum + ((s.unit || '').toLowerCase().includes('hour') ? (s.quantity || 0) : 0),
      0,
    ),
    totalAmount: services.reduce((sum, s) => sum + (s.totalAmount || 0), 0),
    govSubsidy: services.reduce((sum, s) => sum + (s.govSubsidy || 0), 0),
    participantContribution: services.reduce((sum, s) => sum + (s.participantContribution || 0), 0),
  };

  return {
    totalServices: backendSummary?.totalServices ?? fallbackSummary.totalServices,
    totalHours: backendSummary?.totalHours ?? fallbackSummary.totalHours,
    totalAmount: backendSummary?.totalAmount ?? fallbackSummary.totalAmount,
    govSubsidy: backendSummary?.govSubsidy ?? fallbackSummary.govSubsidy,
    participantContribution: backendSummary?.participantContribution ?? fallbackSummary.participantContribution,
  };
}

export function buildMonthlyStatementQueryParams(options: {
  participant: string;
  startDate: string;
  endDate: string;
  month: string;
  year: string;
  budgetPage: number;
  budgetLimit: number;
  servicePage: number;
  serviceLimit: number;
  serviceSortBy?: string;
  serviceSortOrder?: string;
  serviceTransactionStatusFilter?: string;
  serviceFundingSourceFilter?: string;
}) {
  const {
    participant,
    startDate,
    endDate,
    month,
    year,
    budgetPage,
    budgetLimit,
    servicePage,
    serviceLimit,
    serviceSortBy,
    serviceSortOrder,
    serviceTransactionStatusFilter,
    serviceFundingSourceFilter,
  } = options;

  return {
    participant,
    startDate,
    endDate,
    month,
    year,
    budgetPage,
    budgetLimit,
    servicePage,
    serviceLimit,
    ...(serviceSortBy ? { serviceSortBy, serviceSortOrder: serviceSortOrder || 'asc' } : {}),
    ...(serviceTransactionStatusFilter && serviceTransactionStatusFilter !== 'all'
      ? { serviceTransactionStatus: serviceTransactionStatusFilter }
      : {}),
    ...(serviceFundingSourceFilter && serviceFundingSourceFilter !== 'all'
      ? { serviceFundingSource: serviceFundingSourceFilter }
      : {}),
  };
}

export function buildStatementViewModel(
  data: Record<string, any>,
  services: Array<Record<string, any>>,
  allBudgetItemsFlat: unknown[],
  selectedParticipant: string,
  selectedMonth: string,
  selectedYear: string,
  months: Array<{ value: string; label: string }>,
  fallbackProviderId: string,
  categorizeServices: (
    services: Array<Record<string, any>>,
    budgetCategories: unknown,
    monthNumber: string,
    year: string,
  ) => unknown,
) {
  const summary = buildStatementSummary(services, data?.summary);
  const effectiveMonthNumber = (data?.monthNumber ?? selectedMonth ?? '01').toString().padStart(2, '0');
  const effectiveYear = (data?.year ?? selectedYear).toString();
  const monthLabel =
    data?.month ??
    months.find((m) => m.value === effectiveMonthNumber)?.label ??
    effectiveMonthNumber;
  const participantName = data?.participant ?? selectedParticipant;
  const participantProfile = data?.participantProfile ?? participantName;

  return {
    participant: participantName,
    participantProfile,
    month: monthLabel,
    year: effectiveYear,
    monthNumber: effectiveMonthNumber,
    services,
    budgetCategories: categorizeServices(
      services,
      data?.budgetCategories,
      effectiveMonthNumber,
      effectiveYear,
    ),
    budgetItems: allBudgetItemsFlat,
    serviceItems: services,
    summary,
    participantAddress: data?.participantAddress ?? '',
    participantSuburb: data?.participantSuburb ?? '',
    participantState: data?.participantState ?? '',
    participantPostcode: data?.participantPostcode ?? '',
    myAgedCareIdNumber: data?.myAgedCareIdNumber ?? '',
    providerId: data?.providerId || fallbackProviderId,
    fundingSources: data.fundingSources,
  };
}

export function getTransactionStatusBadgeVariant(status?: string): 'destructive' | 'default' | 'secondary' {
  const normalized = status?.toLowerCase() || '';
  if (normalized.includes('cancelled')) return 'destructive';
  if (normalized.includes('delivered')) return 'default';
  return 'secondary';
}
