"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Calendar, User, FileText, AlertCircle, FileCheck, FileSpreadsheet } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import axios from "@/app/utils/axiosConfig";
import { fetchMonthlyStatementItems } from "@/app/utils/items";
import { format, startOfMonth, endOfMonth, isValid, parse } from "date-fns";
import Spinner from "@/components/ui/spin";
import { showSuccessToast, showErrorToast } from "@/lib/toast-utils";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

interface ServiceRecord {
  id: string;
  participant: string;
  participantName?: string;
  scheduledStart: string | null;
  scheduledServiceDate?: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  serviceDeliveryDate?: string | null;
  worker: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  govSubsidy: number;
  participantContribution: number;
  notes: string;
  taskName?: string;
  transactionStatus?: string;
  fundingSource?: string;
  service?: string;
  serviceCategory?: string;
  serviceProvider?: string;
  committedAtHmForDelivery?: number;
}

interface BudgetRecord {
  id: string;
  categoryCode: string;
  folderName?: string;
  participantName?: string;
  participantProfileId?: string | null;
  month?: string | null;
  year?: string | null;
  quarter?: string | null;
  fundingStartDate?: string | null;
  fundingEndDate?: string | null;
  totalAvailableBudget: number;
  availableFundStart?: number;
  quarterlyAdjustment?: number;
  primarySupplementAmount?: number;
  carryoverFunding?: number;
  unspentReturned?: number;
  commonwealthUnspent?: number;
  providerUnspent?: number;
  participantUnspent?: number;
  previousMonthSpending?: number;
  deliveredAmount: number;
  deliveredAmountRaw?: number;
  adjustmentAmount: number;
  remainingBalance: number;
  fundClassification?: string | null;
  fundAmount?: number;
  fund?: string;
  committedFunds?: number;
  fundingStreamId?: string | null;
}

interface BudgetCategory {
  name: string;
  code: string;
  availableFunds: number;
  remainingBudget: number;
  services?: ServiceRecord[];
  fundingEndDate?: string;
  committedFunds?: number;
  quarterStartMonth?: string;
  quarterEndMonth?: string;
  serviceDeliveredAmount?: number;
  govSubsidyAmount?: number;
  participantContributionAmount?: number;
  adjustmentAmount?: number;
  serviceCount?: number;
  availableBalanceRangeLabel?: string;
  expenditurePeriodLabel?: string;
  availableFundStart?: number;
  quarterlyAdjustment?: number;
  primarySupplementAmount?: number;
  carryoverFunding?: number;
  unspentReturned?: number;
  commonwealthUnspent?: number;
  providerUnspent?: number;
  participantUnspent?: number;
  previousMonthSpending?: number;
  fundAmount?: number;
  shouldDisplay?: boolean;
}

interface MonthlyStatementData {
  participant: string;
  participantProfile: string;
  month: string;
  year: string;
  monthNumber: string;
  services: ServiceRecord[];
  budgetCategories: BudgetCategory[];
  budgetItems?: BudgetRecord[];
  serviceItems?: ServiceRecord[];
  summary: {
    totalServices: number;
    totalHours: number;
    totalAmount: number;
    govSubsidy: number;
    participantContribution: number;
    averageServiceCost: number;
  };
  participantAddress?: string;
  participantSuburb?: string;
  participantState?: string;
  participantPostcode?: string;
  myAgedCareIdNumber?: string;
  providerId?: string;
}

interface BusinessDetails {
  companyName: string;
  phoneNumber: string;
  businessEmail: string;
  address: string;
  location: string;
  suburb: string;
  state: string;
  postcode: string;
  companyRegistrationId: string;
}

interface ChartBarDatum {
  name: string;
  label: string;
  shortLabel: string;
  value: number;
  color: string;
}

interface ChartCardConfig {
  code: string;
  title: string;
  subtitle: string;
  data: ChartBarDatum[];
  metrics: { label: string; value: number }[];
  chartConfig: ChartConfig;
  serviceCount?: number;
  hasData: boolean;
}

const BUDGET_CATEGORY_LABELS: Record<string, string> = {
  HSQ: 'Home Support Quarterly Budget',
  RCP: 'Restorative Care Pathway Budget',
  EOL: 'End-of-Life Pathway Budget',
  ATS: 'Assistive Technology - Short-term Budget',
  ATO: 'Assistive Technology - Ongoing Budget',
  HMB: 'Home Modification Budget',
};

export default function MonthlyStatement() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split('/')[2];
  const boardId = pathname.split('/')[4];
  
  const [loading, setLoading] = useState(false);
  const [loadingParticipants, setLoadingParticipants] = useState(false);
  const [loadingBudgetItems, setLoadingBudgetItems] = useState(false);
  const [loadingServiceItems, setLoadingServiceItems] = useState(false);
  const [statementData, setStatementData] = useState<MonthlyStatementData | null>(null);
  const [budgetItems, setBudgetItems] = useState<BudgetRecord[]>([]);
  const [serviceItems, setServiceItems] = useState<ServiceRecord[]>([]);
  const [budgetPagination, setBudgetPagination] = useState({ page: 1, limit: 10, total: 0 });
  const [servicePagination, setServicePagination] = useState({ page: 1, limit: 10, total: 0 });
  const [selectedParticipant, setSelectedParticipant] = useState<string>("");
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [selectedYear, setSelectedYear] = useState<string>("");
  const [uniqueParticipants, setUniqueParticipants] = useState<string[]>([]);
  const [isPrintMode, setIsPrintMode] = useState(false);
  const [showBusinessDialog, setShowBusinessDialog] = useState(false);
  const [businessDetails, setBusinessDetails] = useState<BusinessDetails>({
    companyName: "",
    phoneNumber: "",
    businessEmail: "",
    address: "",
    location: "",
    suburb: "",
    state: "",
    postcode: "",
    companyRegistrationId: "",
  });
  const [exportingSection, setExportingSection] = useState<null | 'budget-csv' | 'service-csv' | 'statement-pdf'>(null);


  // Budget data will come from the API response

  // Generate month and year options
  const months = [
    { value: "01", label: "January" },
    { value: "02", label: "February" },
    { value: "03", label: "March" },
    { value: "04", label: "April" },
    { value: "05", label: "May" },
    { value: "06", label: "June" },
    { value: "07", label: "July" },
    { value: "08", label: "August" },
    { value: "09", label: "September" },
    { value: "10", label: "October" },
    { value: "11", label: "November" },
    { value: "12", label: "December" },
  ];

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => (currentYear - i).toString());

  // Fetch unique participants
  useEffect(() => {
    const fetchParticipants = async () => {
      if (!id || !boardId) return;
      
      setLoadingParticipants(true);
      try {
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/monthly-statement`,
          {
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            }
          }
        );

        if (response.data?.serviceItems?.items) {
          const participantSet = new Set<string>(
            response.data.serviceItems.items
              .map((item: ServiceRecord) => item.participant)
              .filter((p: string) => p && p.trim() !== '')
          );
          const participants = Array.from(participantSet).sort();
          setUniqueParticipants(participants as string[]);
        }
      } catch (err) {
        console.error('Error fetching participants:', err);
        showErrorToast('Failed to fetch participants');
      } finally {
        setLoadingParticipants(false);
      }
    };

    fetchParticipants();
  }, [id, boardId]);

  // Set default month and year
  useEffect(() => {
    const now = new Date();
    if (!selectedMonth) {
      setSelectedMonth((now.getMonth() + 1).toString().padStart(2, '0'));
    }
    if (!selectedYear) {
      setSelectedYear(now.getFullYear().toString());
    }
  }, [selectedMonth, selectedYear]);

  // Load business details
  useEffect(() => {
    const loadBusinessDetails = async () => {
      try {
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
          { params: { workspaceId: id } }
        );
        if (response.data) {
          setBusinessDetails({
            companyName: response.data.name || "",
            phoneNumber: response.data.phone || "",
            businessEmail: response.data.email || "",
            address: response.data.address?.street || "",
            location: `${response.data.address?.suburb || ""}, ${response.data.address?.state || ""}`,
            suburb: response.data.address?.suburb || "",
            state: response.data.address?.state || "",
            postcode: response.data.address?.postcode || "",
            companyRegistrationId: response.data.companyRegistrationId || "",
          });
        }
      } catch (err) {
        console.error('Error loading business details:', err);
      }
    };

    if (id) {
      loadBusinessDetails();
    }
  }, [id]);

  // Helper function to get quarter months
  const getQuarterMonths = (monthNumber: string): { start: string; end: string } => {
    const month = parseInt(monthNumber);
    if (month >= 1 && month <= 3) {
      return { start: "January", end: "March" };
    } else if (month >= 4 && month <= 6) {
      return { start: "April", end: "June" };
    } else if (month >= 7 && month <= 9) {
      return { start: "July", end: "September" };
    } else {
      return { start: "October", end: "December" };
    }
  };

  const getSelectedMonthDateRange = () => {
    if (!selectedMonth || !selectedYear) {
      return null;
    }

    const monthNum = parseInt(selectedMonth, 10);
    const yearNum = parseInt(selectedYear, 10);

    if (Number.isNaN(monthNum) || Number.isNaN(yearNum)) {
      return null;
    }

    const monthDate = new Date(yearNum, monthNum - 1, 1);
    const startDate = startOfMonth(monthDate);
    const endDate = new Date(endOfMonth(monthDate));
    endDate.setHours(23, 59, 59, 999);

    return {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    };
  };

  const sanitizeForFileName = (value: string) =>
    value.replace(/[^\w.-]+/g, "_");

  const escapeForCsv = (value: unknown) => {
    if (value === null || value === undefined) {
      return '""';
    }
    const stringValue = String(value).replace(/"/g, '""');
    return `"${stringValue}"`;
  };

  const downloadCsv = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const formatDateForCsv = (dateString: string | null | undefined) => {
    if (!dateString) {
      return '';
    }
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
      return dateString;
    }
    return format(date, 'dd/MM/yyyy');
  };

  const handleServicePageChange = (page: number) => {
    if (loadingServiceItems) return;
    const totalPages = Math.max(1, Math.ceil(servicePagination.total / servicePagination.limit));
    if (page < 1 || page > totalPages || page === servicePagination.page) return;
    fetchServiceItems(page, servicePagination.limit);
  };

  const serviceTotalPages = Math.max(1, Math.ceil((servicePagination.total || 0) / (servicePagination.limit || 1)));

  const fetchServiceItems = async (page: number = 1, limit: number = servicePagination.limit) => {
    if (!selectedParticipant || !selectedMonth || !selectedYear) {
      return;
    }

    setLoadingServiceItems(true);
    try {
      const monthNum = parseInt(selectedMonth);
      const yearNum = parseInt(selectedYear);
      const monthDate = new Date(yearNum, monthNum - 1, 1);
      const startDate = startOfMonth(monthDate);
      const endDate = new Date(endOfMonth(monthDate));
      endDate.setHours(23, 59, 59, 999);

      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/monthly-statement`,
        {
          params: {
            participant: selectedParticipant,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            month: selectedMonth,
            year: selectedYear,
            servicePage: page,
            serviceLimit: limit,
          },
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      if (response.data?.serviceItems) {
        const serviceData = response.data.serviceItems;
        setServiceItems(serviceData.items as ServiceRecord[]);
        setServicePagination({
          page: serviceData.page || page,
          limit: serviceData.limit || limit,
          total: serviceData.total || 0,
        });
      } else {
        setServiceItems([]);
        setServicePagination({ page: 1, limit, total: 0 });
      }
    } catch (err) {
      console.error('Error fetching service items:', err);
      showErrorToast('Failed to fetch service items');
      setServiceItems([]);
      setServicePagination({ page: 1, limit, total: 0 });
    } finally {
      setLoadingServiceItems(false);
    }
  };

  // Categorize services into budget categories using data from API
  const categorizeServices = (
    services: ServiceRecord[],
    budgetCategoriesFromAPI: BudgetCategory[] | undefined,
    monthNumber: string,
    year: string
  ): BudgetCategory[] => {
    const quarterMonths = getQuarterMonths(monthNumber);
    const defaultFundingEndDate = new Date(parseInt(year), 11, 31).toISOString(); // End of year
    
    // If budget categories are provided from API, use them directly (services are already categorized in backend)
    if (budgetCategoriesFromAPI && budgetCategoriesFromAPI.length > 0) {
      // Create a map for quick lookup
      const categoryMap = new Map<string, BudgetCategory>();
      budgetCategoriesFromAPI.forEach(cat => {
        // Use the category data from API, ensuring services array exists
        const category: BudgetCategory = {
          ...cat,
          services: cat.services || [],
        };
        categoryMap.set(cat.code, category);
      });

      // Optionally categorize services if they need to be assigned to categories
      // (Backend should already have calculated totals, but we can still assign individual services for display)
      services.forEach(service => {
        const fundingSource = (service.fundingSource || '').toLowerCase();
        const serviceCategory = (service.serviceCategory || '').toLowerCase();
        const notes = (typeof service.notes === 'string' ? service.notes : String(service.notes || '')).toLowerCase();
        const taskName = (typeof service.taskName === 'string' ? service.taskName : String(service.taskName || '')).toLowerCase();

        let categoryCode = 'HSQ'; // Default to Home Support

        if (fundingSource.includes('restorative care') || serviceCategory.includes('restorative')) {
          categoryCode = 'RCP';
        } else if (fundingSource.includes('end-of-life') || fundingSource.includes('end of life') ||
          notes.includes('end of life') || taskName.includes('end of life')) {
          categoryCode = 'EOL';
        } else if ((fundingSource.includes('assistive') && fundingSource.includes('short')) ||
          (notes.includes('assistive') && notes.includes('short'))) {
          categoryCode = 'ATS';
        } else if ((fundingSource.includes('assistive') && fundingSource.includes('ongoing')) ||
          (notes.includes('assistive') && notes.includes('ongoing'))) {
          categoryCode = 'ATO';
        } else if (fundingSource.includes('modification') || fundingSource.includes('home modification') ||
          notes.includes('modification') || taskName.includes('modification')) {
          categoryCode = 'HMB';
        } else if (fundingSource.includes('home support') || fundingSource.includes('hs') ||
          serviceCategory.includes('home support')) {
          categoryCode = 'HSQ';
        }

        const category = categoryMap.get(categoryCode);
        if (category) {
          if (!category.services) {
            category.services = [];
          }
          category.services.push(service);
        }
      });

      // Return categories in the correct order
      const categoryOrder = ['HSQ', 'ATS', 'ATO', 'HMB', 'RCP', 'EOL'];
      return categoryOrder
        .map(code => categoryMap.get(code))
        .filter((cat): cat is BudgetCategory => cat !== undefined);
    }

    // Fallback: If no budget categories from API, create empty categories structure
    // This should not happen in normal operation, but provides a fallback
    return [
      {
        name: `Home Support Quarterly Budget ${quarterMonths.start}-${quarterMonths.end} ${year}`,
        code: "HSQ",
        availableFunds: 0,
        remainingBudget: 0,
        services: [],
        quarterStartMonth: quarterMonths.start,
        quarterEndMonth: quarterMonths.end,
        fundingEndDate: defaultFundingEndDate,
        serviceDeliveredAmount: 0,
        govSubsidyAmount: 0,
        participantContributionAmount: 0,
        adjustmentAmount: 0,
        serviceCount: 0,
      },
      {
        name: "Restorative Care Pathway Budget",
        code: "RCP",
        availableFunds: 0,
        remainingBudget: 0,
        services: [],
        fundingEndDate: defaultFundingEndDate,
        serviceDeliveredAmount: 0,
        govSubsidyAmount: 0,
        participantContributionAmount: 0,
        adjustmentAmount: 0,
        serviceCount: 0,
      },
      {
        name: "End-of-Life Pathway",
        code: "EOL",
        availableFunds: 0,
        remainingBudget: 0,
        services: [],
        fundingEndDate: defaultFundingEndDate,
        serviceDeliveredAmount: 0,
        govSubsidyAmount: 0,
        participantContributionAmount: 0,
        adjustmentAmount: 0,
        serviceCount: 0,
      },
      {
        name: "Assistive Technology - Short-term Budget",
        code: "ATS",
        availableFunds: 0,
        remainingBudget: 0,
        services: [],
        fundingEndDate: defaultFundingEndDate,
        committedFunds: 0,
        serviceDeliveredAmount: 0,
        govSubsidyAmount: 0,
        participantContributionAmount: 0,
        adjustmentAmount: 0,
        serviceCount: 0,
      },
      {
        name: "Assistive Technology - Ongoing Budget",
        code: "ATO",
        availableFunds: 0,
        remainingBudget: 0,
        services: [],
        fundingEndDate: defaultFundingEndDate,
        committedFunds: 0,
        serviceDeliveredAmount: 0,
        govSubsidyAmount: 0,
        participantContributionAmount: 0,
        adjustmentAmount: 0,
        serviceCount: 0,
      },
      {
        name: "Home Modification Budget",
        code: "HMB",
        availableFunds: 0,
        remainingBudget: 0,
        services: [],
        fundingEndDate: defaultFundingEndDate,
        committedFunds: 0,
        serviceDeliveredAmount: 0,
        govSubsidyAmount: 0,
        participantContributionAmount: 0,
        adjustmentAmount: 0,
        serviceCount: 0,
      },
    ];
  };

  // Fetch budget items from budget folders
  const fetchBudgetItems = async (page: number = 1, limit: number = 10) => {
    if (!selectedParticipant || !selectedMonth || !selectedYear) {
      return;
    }

    setLoadingBudgetItems(true);
    try {
      const monthNum = parseInt(selectedMonth);
      const yearNum = parseInt(selectedYear);
      const monthDate = new Date(yearNum, monthNum - 1, 1);
      const startDate = startOfMonth(monthDate);
      const endDate = new Date(endOfMonth(monthDate));
      endDate.setHours(23, 59, 59, 999);

      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/monthly-statement`,
        {
          params: {
            participant: selectedParticipant,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            month: selectedMonth,
            year: selectedYear,
            budgetPage: page,
            budgetLimit: limit
          },
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      if (response.data?.budgetItems) {
        setBudgetItems(response.data.budgetItems.items as BudgetRecord[]);
        setBudgetPagination({
          page: response.data.budgetItems.page || page,
          limit: response.data.budgetItems.limit || limit,
          total: response.data.budgetItems.total || 0
        });
      } else {
        setBudgetItems([]);
        setBudgetPagination({ page: 1, limit: 10, total: 0 });
      }
    } catch (err) {
      console.error('Error fetching budget items:', err);
      showErrorToast('Failed to fetch budget items');
      setBudgetItems([]);
      setBudgetPagination({ page: 1, limit: 10, total: 0 });
    } finally {
      setLoadingBudgetItems(false);
    }
  };

  // Fetch statement data
  const fetchStatementData = async () => {
    // Input validation
    if (!selectedParticipant || !selectedMonth || !selectedYear) {
      showErrorToast('Please select participant, month, and year');
      return;
    }

    const monthNum = parseInt(selectedMonth);
    const yearNum = parseInt(selectedYear);
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();

    // Validate month range
    if (monthNum < 1 || monthNum > 12) {
      showErrorToast('Please select a valid month (01-12)');
      return;
    }

    // Validate year range (not too far in the future, reasonable past)
    if (yearNum > currentYear + 1) {
      showErrorToast('Cannot generate statements for future years beyond next year');
      return;
    }
    if (yearNum < currentYear - 10) {
      showErrorToast('Cannot generate statements for years more than 10 years ago');
      return;
    }

    setLoading(true);
    setLoadingServiceItems(true);
    try {
      // Calculate date range for selected month using date-fns for better timezone handling
      const monthDate = new Date(yearNum, monthNum - 1, 1);
      if (!isValid(monthDate)) {
        showErrorToast('Invalid date selected');
        return;
      }
      const startDate = startOfMonth(monthDate);
      const endDate = new Date(endOfMonth(monthDate));
      endDate.setHours(23, 59, 59, 999);

      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/monthly-statement`,
        {
          params: {
            participant: selectedParticipant,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            month: selectedMonth,
            year: selectedYear,
            budgetPage: budgetPagination.page,
            budgetLimit: budgetPagination.limit,
            servicePage: servicePagination.page,
            serviceLimit: servicePagination.limit
          },
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      const data = response.data;

      // Handle budget items
      if (data?.budgetItems) {
        setBudgetItems(data.budgetItems.items as BudgetRecord[]);
        setBudgetPagination({
          page: data.budgetItems.page || budgetPagination.page,
          limit: data.budgetItems.limit || budgetPagination.limit,
          total: data.budgetItems.total || 0
        });
      } else {
        setBudgetItems([]);
      }

      // Handle service items
      const services: ServiceRecord[] = data?.serviceItems?.items || [];
      if (data?.serviceItems) {
        setServiceItems(services);
        setServicePagination({
          page: data.serviceItems.page || servicePagination.page,
          limit: data.serviceItems.limit || servicePagination.limit,
          total: data.serviceItems.total || 0
        });
      } else {
        setServiceItems([]);
        setServicePagination({ page: 1, limit: 10, total: 0 });
      }

      // Derive summary figures (prefer backend-provided values)
      const fallbackSummary = {
        totalServices: services.length,
        totalHours: services.reduce((sum, s) => sum + (s.unit === 'Hour' ? s.quantity : 0), 0),
        totalAmount: services.reduce((sum, s) => sum + (s.totalAmount || 0), 0),
        govSubsidy: services.reduce((sum, s) => sum + (s.govSubsidy || 0), 0),
        participantContribution: services.reduce((sum, s) => sum + (s.participantContribution || 0), 0),
      };

      const backendSummary = data?.summary;
      const totalServices = backendSummary?.totalServices ?? fallbackSummary.totalServices;
      const totalAmount = backendSummary?.totalAmount ?? fallbackSummary.totalAmount;

      const summary = {
        totalServices,
        totalHours: backendSummary?.totalHours ?? fallbackSummary.totalHours,
        totalAmount,
        govSubsidy: backendSummary?.govSubsidy ?? fallbackSummary.govSubsidy,
        participantContribution: backendSummary?.participantContribution ?? fallbackSummary.participantContribution,
        averageServiceCost:
          backendSummary?.averageServiceCost ??
          (totalServices > 0 ? totalAmount / totalServices : 0),
      };

      const effectiveMonthNumber = (data?.monthNumber ?? selectedMonth ?? '01').toString().padStart(2, '0');
      const effectiveYear = (data?.year ?? selectedYear).toString();
      const monthLabel =
        data?.month ??
        months.find((m) => m.value === effectiveMonthNumber)?.label ??
        effectiveMonthNumber;
      const participantName = data?.participant ?? selectedParticipant;
      const participantProfile = data?.participantProfile ?? participantName;
      const providerIdValue = data?.providerId || businessDetails.companyRegistrationId || '';

      const budgetCategories = categorizeServices(
        services,
        data?.budgetCategories,
        effectiveMonthNumber,
        effectiveYear
      );

      setStatementData({
        participant: participantName,
        participantProfile,
        month: monthLabel,
        year: effectiveYear,
        monthNumber: effectiveMonthNumber,
        services,
        budgetCategories,
        budgetItems: data?.budgetItems?.items ?? [],
        serviceItems: services,
        summary,
        participantAddress: data?.participantAddress ?? '',
        participantSuburb: data?.participantSuburb ?? '',
        participantState: data?.participantState ?? '',
        participantPostcode: data?.participantPostcode ?? '',
        myAgedCareIdNumber: data?.myAgedCareIdNumber ?? '',
        providerId: providerIdValue,
      });

      showSuccessToast('Statement loaded successfully');
    } catch (err) {
      console.error('Error fetching statement data:', err);
      showErrorToast('Failed to fetch statement data');
    } finally {
      setLoading(false);
      setLoadingServiceItems(false);
    }
  };

  // Handle PDF generation/export (consolidated function)
  const handlePDFAction = async (action: 'generate' | 'export' = 'generate') => {
    if (!statementData) {
      showErrorToast('Please load a statement first');
      return null;
    }

    if (!businessDetails.companyName || !businessDetails.companyRegistrationId || !businessDetails.phoneNumber || !businessDetails.businessEmail) {
      showErrorToast(`Please configure business details before ${action === 'generate' ? 'generating' : 'exporting'} PDF`);
      setShowBusinessDialog(true);
      return null;
    }

    try {
      setLoading(true);
      
      // Call backend PDF generation endpoint
      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf/${id}/${boardId}/monthly-statement`,
        {
          statementData,
          businessDetails,
        }
      );

      const fileUrl = response.data?.fileUrl;
      if (fileUrl) {
        window.open(fileUrl, '_blank', 'noopener,noreferrer');
        showSuccessToast(
          action === 'generate'
            ? 'Monthly statement PDF generated successfully'
            : 'PDF exported successfully'
        );
        return fileUrl;
      } else {
        showErrorToast('Failed to retrieve PDF link from server.');
        return null;
      }
    } catch (err) {
      console.error(`Error ${action === 'generate' ? 'generating' : 'exporting'} PDF:`, err);
      showErrorToast('Failed to generate PDF. Please try again.');
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleBudgetExportCSV = async () => {
    if (!statementData) {
      showErrorToast('Please load a statement before exporting.');
      return;
    }

    const dateRange = getSelectedMonthDateRange();
    if (!dateRange) {
      showErrorToast('Please choose a valid month and year before exporting.');
      return;
    }

    try {
      setExportingSection('budget-csv');
      const response = await fetchMonthlyStatementItems(id, boardId, {
        participant: selectedParticipant,
        month: selectedMonth,
        year: selectedYear,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        budgetPage: 1,
        budgetLimit: 5000,
      });

      const items: BudgetRecord[] = response?.budgetItems?.items || [];
      if (!items.length) {
        showErrorToast('No budget items to export.');
        return;
      }

      const headers = [
        'Funding Stream',
        'Participant',
        'Month',
        'Year',
        'FY Quarter',
        'Total Available',
        'Delivered (Selected Month)',
        'Adjustments',
        'Remaining Balance',
        'Funding Start',
        'Funding End',
        'Fund',
        'Committed Funds'
      ];

      const rows = items.map((item) => [
        item.folderName || BUDGET_CATEGORY_LABELS[item.categoryCode] || 'Budget',
        item.participantName || statementData.participant || 'N/A',
        item.month || '',
        item.year || '',
        item.quarter || '',
        Number(item.totalAvailableBudget ?? 0).toFixed(2),
        Number(item.deliveredAmount ?? 0).toFixed(2),
        Number(item.adjustmentAmount ?? 0).toFixed(2),
        Number(item.remainingBalance ?? 0).toFixed(2),
        formatDateForCsv(item.fundingStartDate),
        formatDateForCsv(item.fundingEndDate),
        item.fund || item.fundClassification || '',
        Number(item.committedFunds ?? 0).toFixed(2),
      ]);

      const csvContent = [headers, ...rows]
        .map((row) => row.map(escapeForCsv).join(','))
        .join('\n');

      const participantSlug = sanitizeForFileName(statementData.participant || 'participant');
      const monthSlug = sanitizeForFileName(statementData.monthNumber || selectedMonth || '01');
      const filename = `Individualised_Budgets_${participantSlug}_${statementData.year}_${monthSlug}.csv`;
      downloadCsv(csvContent, filename);
      showSuccessToast(`Exported ${items.length} budget item${items.length === 1 ? '' : 's'} to CSV.`);
    } catch (err: any) {
      console.error('Error exporting budget items:', err);
      showErrorToast('Failed to export budget items', { description: err?.message || 'Unknown error' });
    } finally {
      setExportingSection(null);
    }
  };


  const handleServiceExportCSV = async () => {
    if (!statementData) {
      showErrorToast('Please load a statement before exporting.');
      return;
    }

    const dateRange = getSelectedMonthDateRange();
    if (!dateRange) {
      showErrorToast('Please choose a valid month and year before exporting.');
      return;
    }

    try {
      setExportingSection('service-csv');
      const response = await fetchMonthlyStatementItems(id, boardId, {
        participant: selectedParticipant,
        month: selectedMonth,
        year: selectedYear,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        servicePage: 1,
        serviceLimit: 5000,
      });

      const items: ServiceRecord[] = response?.serviceItems?.items || [];
      if (!items.length) {
        showErrorToast('No service records to export.');
        return;
      }

      const headers = [
        'Participant',
        'Service',
        'Service Provider',
        'Scheduled Service Date',
        'Actual Service Date',
        'Transaction Status',
        'Committed AT-HM for Delivery',
        'Unit',
        'Quantity',
        'Unit Price (AUD)',
        'Total Amount (AUD)',
        'Gov Subsidy (AUD)',
        'Participant Contribution (AUD)',
        'Funding Source',
        'Notes'
      ];

      const rows = items.map((service) => [
        service.participant || '',
        service.service || service.taskName || '',
        service.serviceProvider || '',
        formatDateForCsv(service.scheduledServiceDate),
        formatDateForCsv(service.serviceDeliveryDate),
        service.transactionStatus || '',
        Number(service.committedAtHmForDelivery ?? 0).toFixed(2),
        service.unit || '',
        service.quantity ?? 0,
        Number(service.unitPrice ?? 0).toFixed(2),
        Number(service.totalAmount ?? 0).toFixed(2),
        Number(service.govSubsidy ?? 0).toFixed(2),
        Number(service.participantContribution ?? 0).toFixed(2),
        service.fundingSource || '',
        (service.notes || '').replace(/[\r\n]+/g, ' '),
      ]);

      const csvContent = [headers, ...rows]
        .map((row) => row.map(escapeForCsv).join(','))
        .join('\n');

      const participantSlug = sanitizeForFileName(statementData.participant || 'participant');
      const monthSlug = sanitizeForFileName(statementData.monthNumber || selectedMonth || '01');
      const filename = `Service_Records_${participantSlug}_${statementData.year}_${monthSlug}.csv`;
      downloadCsv(csvContent, filename);
      showSuccessToast(`Service records CSV exported successfully. ${items.length} record${items.length === 1 ? '' : 's'} exported.`);
    } catch (err: any) {
      console.error('Error exporting service records:', err);
      showErrorToast('Failed to export service records', { description: err?.message || 'Unknown error' });
    } finally {
      setExportingSection(null);
    }
  };

  const handleSaHMonthlyStatement = async () => {
    if (!statementData) {
      showErrorToast('Please load a statement before generating.');
      return;
    }
    try {
      setExportingSection('statement-pdf');
      await handlePDFAction('generate');
    } finally {
      setExportingSection(null);
    }
  };

  // Save business details
  const handleSaveBusinessDetails = async () => {
    if (!businessDetails.companyName || !businessDetails.phoneNumber || !businessDetails.businessEmail || !businessDetails.companyRegistrationId) {
      showErrorToast('Please fill in all required fields (Company Name, Registration ID, Phone, Email)');
      return;
    }

    try {
      setLoading(true);
      await axios.put(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
        {
          workspaceId: id,
          name: businessDetails.companyName,
          phone: businessDetails.phoneNumber,
          email: businessDetails.businessEmail,
          street: businessDetails.address,
          suburb: businessDetails.suburb,
          state: businessDetails.state,
          postcode: businessDetails.postcode,
          companyRegistrationId: businessDetails.companyRegistrationId,
        }
      );
      setShowBusinessDialog(false);
      showSuccessToast('Business details saved successfully');
    } catch (err) {
      console.error('Error saving business details:', err);
      showErrorToast('Failed to save business details. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Format currency
  const formatCurrency = (amount?: number | null) => {
    const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: 'AUD',
    }).format(value);
  };

  // Format date
  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return 'N/A';
    try {
      // Handle date-only strings (YYYY-MM-DD) by adding time component if needed
      let dateStr = dateString;
      if (dateStr && !dateStr.includes('T') && !dateStr.includes(' ')) {
        // It's a date-only string, parse it directly
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          if (!isNaN(date.getTime())) {
            return format(date, 'dd/MM/yyyy');
          }
        }
      }
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return 'N/A';
      return format(date, 'dd/MM/yyyy');
    } catch (e) {
      return 'N/A';
    }
  };

  const formatAxisCurrency = (value: number) => {
    if (!Number.isFinite(value)) return '$0';
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    if (abs >= 1_000_000) {
      return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    }
    if (abs >= 1_000) {
      return `${sign}$${(abs / 1_000).toFixed(1)}k`;
    }
    return `${sign}$${abs.toFixed(0)}`;
  };

  const toNumber = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };

  const positive = (value: unknown): number => Math.max(0, toNumber(value));

  const chartConfigs = useMemo(() => {
    if (!statementData?.budgetCategories?.length) {
      return [];
    }

    const charts: ChartCardConfig[] = [];
    const categoryLookup = new Map<string, BudgetCategory>();
    statementData.budgetCategories.forEach((cat) => {
      categoryLookup.set(cat.code, cat);
    });

    const normalizedMonthNumber = statementData.monthNumber?.padStart(2, '0') || '01';
    const monthIndex = months.findIndex((monthOption) => monthOption.value === normalizedMonthNumber);
    const nextMonthLabel = monthIndex >= 0
      ? months[(monthIndex + 1) % months.length].label
      : statementData.month;
    const selectedMonthLabel = statementData.month || months[monthIndex]?.label || 'Selected month';

    const getPreviousSpendingValue = (category?: BudgetCategory) => {
      if (!category) return 0;
      if (category.previousMonthSpending && category.previousMonthSpending !== 0) {
        return positive(category.previousMonthSpending);
      }
      const derived = toNumber(category.fundAmount) - toNumber(category.availableFundStart);
      return derived > 0 ? derived : 0;
    };

    const pushChartConfig = (chart: Omit<ChartCardConfig, 'chartConfig' | 'hasData'>) => {
      const chartData = chart.data.map((datum) => ({
        ...datum,
        value: toNumber(datum.value)
      }));
      const chartConfig: ChartConfig = chartData.reduce((acc, datum) => {
        acc[datum.name] = { label: datum.label, color: datum.color };
        return acc;
      }, {} as ChartConfig);

      const hasData = chartData.some((datum) => Math.abs(datum.value) > 0.0001);

      charts.push({ ...chart, data: chartData, chartConfig, hasData });
    };

    const getQuarterRange = () => {
      const monthNum = parseInt(normalizedMonthNumber, 10) || 1;
      if (monthNum >= 1 && monthNum <= 3) {
        return { start: 'January', end: 'March' };
      }
      if (monthNum >= 4 && monthNum <= 6) {
        return { start: 'April', end: 'June' };
      }
      if (monthNum >= 7 && monthNum <= 9) {
        return { start: 'July', end: 'September' };
      }
      return { start: 'October', end: 'December' };
    };

    const defaultQuarterRange = getQuarterRange();

    const homeSupport = categoryLookup.get('HSQ') ?? ({ code: 'HSQ' } as BudgetCategory);
    {
      const available = positive(homeSupport.availableFunds);
      const remaining = positive(homeSupport.remainingBudget);
      const expenditure = Math.max(0, available - remaining);
      const quarterStart = homeSupport.quarterStartMonth ?? defaultQuarterRange.start;
      const quarterEnd = homeSupport.quarterEndMonth ?? defaultQuarterRange.end;
      const balanceLabel = quarterEnd
        ? (nextMonthLabel === quarterEnd ? 'Next quarter' : `${nextMonthLabel} - ${quarterEnd}`)
        : nextMonthLabel;

      pushChartConfig({
        code: 'HSQ',
        subtitle: 'Quarterly Budget',
        title: `Home Support ${quarterStart} - ${quarterEnd} ${statementData.year}`,
        data: [
          {
            name: 'hsq-expenditure',
            label: `${selectedMonthLabel} expenditure`,
            shortLabel: 'Expenditure',
            value: expenditure,
            color: '#dc2626'
          },
          {
            name: 'hsq-balance',
            label: `Available balance ${balanceLabel}`,
            shortLabel: 'Balance',
            value: remaining,
            color: '#2563eb'
          }
        ],
        metrics: [
          { label: 'Available funds', value: available },
          { label: 'Remaining budget', value: remaining },
        ],
        serviceCount: homeSupport.serviceCount
      });
    }

    const addAssistiveOrModificationChart = (code: 'ATS' | 'ATO' | 'HMB', title: string) => {
      const category = categoryLookup.get(code) ?? ({ code } as BudgetCategory);
      const available = positive(category.availableFunds);
      const remaining = positive(category.remainingBudget);
      const expenditure = Math.max(0, available - remaining);
      const committed = positive(category.committedFunds);

      pushChartConfig({
        code,
        subtitle: title,
        title: `${title} (${statementData.year})`,
        data: [
          {
            name: `${code}-expenditure`,
            label: `${selectedMonthLabel} expenditure`,
            shortLabel: 'Expenditure',
            value: expenditure,
            color: '#dc2626'
          },
          {
            name: `${code}-committed`,
            label: 'Committed funds',
            shortLabel: 'Committed',
            value: committed,
            color: '#16a34a'
          },
          {
            name: `${code}-balance`,
            label: `Remaining budget ${formatDate(category.fundingEndDate)}`,
            shortLabel: 'Balance',
            value: remaining,
            color: '#2563eb'
          }
        ],
        metrics: [
          { label: 'Available funds', value: available },
          { label: 'Remaining budget', value: remaining },
        ],
        serviceCount: category.serviceCount
      });
    };

    addAssistiveOrModificationChart('ATS', 'Assistive Technology - Short-term');
    addAssistiveOrModificationChart('ATO', 'Assistive Technology - Ongoing');
    addAssistiveOrModificationChart('HMB', 'Home Modification Budget');

    const addRestorativeChart = (code: 'RCP' | 'EOL', title: string) => {
      const category = categoryLookup.get(code) ?? ({ code } as BudgetCategory);
      const previousSpending = getPreviousSpendingValue(category);
      const available = positive(category.availableFunds);
      const totalAvailable = positive(category.availableFunds);
      const remaining = positive(category.remainingBudget);
      const expenditure = Math.max(0, available - remaining);

      pushChartConfig({
        code,
        subtitle: title,
        title: `${title} (${statementData.year})`,
        data: [
          {
            name: `${code}-previous`,
            label: 'Spending from previous months',
            shortLabel: 'Prev. spend',
            value: previousSpending,
            color: '#7c3aed'
          },
          {
            name: `${code}-expenditure`,
            label: `${selectedMonthLabel} expenditure`,
            shortLabel: 'Expenditure',
            value: expenditure,
            color: '#dc2626'
          },
          {
            name: `${code}-balance`,
            label: `Remaining budget ${formatDate(category.fundingEndDate)}`,
            shortLabel: 'Balance',
            value: totalAvailable,
            color: '#2563eb'
          }
        ],
        metrics: [
          { label: 'Available funds', value: totalAvailable },
          { label: 'Remaining balance', value: remaining },
        ],
        serviceCount: category.serviceCount
      });
    };

    addRestorativeChart('RCP', 'Restorative Care Pathway Budget');
    addRestorativeChart('EOL', 'End-of-Life Pathway Budget');

    return charts;
  }, [statementData]);

  const visibleBudgetCategories = useMemo(() => {
    if (!statementData) return [];
    return statementData.budgetCategories.filter((category) => category.shouldDisplay !== false);
  }, [statementData]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        {!isPrintMode && (
          <>
            <Button
              variant="ghost"
              className="mb-6 print:hidden"
              onClick={() => router.push(`/workspace/${id}/board/${boardId}`)}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Board
            </Button>

            {/* Header */}
            <div className="mb-8">
              <h1 className="text-3xl font-bold mb-2 text-black">
                Monthly Statement Generator
              </h1>
              <p className="text-muted-foreground">
                Generate comprehensive monthly service records and budget statements for Support at Home participants
              </p>
            </div>

            {/* Filters */}
            <Card className="p-6 mb-6 shadow-lg print:hidden">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Participant</label>
                  <Select value={selectedParticipant} onValueChange={setSelectedParticipant} disabled={loadingParticipants}>
                    <SelectTrigger>
                      <SelectValue placeholder={loadingParticipants ? "Loading participants..." : "Select participant"} />
                    </SelectTrigger>
                    <SelectContent>
                      {loadingParticipants ? (
                        <SelectItem value="loading" disabled>Loading...</SelectItem>
                      ) : uniqueParticipants.length > 0 ? (
                        uniqueParticipants.map((participant) => (
                          <SelectItem key={participant} value={participant}>
                            {participant}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="none" disabled>No participants found</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Month</label>
                  <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select month" />
                    </SelectTrigger>
                    <SelectContent>
                      {months.map((month) => (
                        <SelectItem key={month.value} value={month.value}>
                          {month.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Year</label>
                  <Select value={selectedYear} onValueChange={setSelectedYear}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select year" />
                    </SelectTrigger>
                    <SelectContent>
                      {years.map((year) => (
                        <SelectItem key={year} value={year}>
                          {year}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-end">
                  <Button
                    onClick={fetchStatementData}
                    className="w-full"
                    disabled={loading || !selectedParticipant || !selectedMonth || !selectedYear}
                  >
                    {loading ? <Spinner /> : 'Load Statement'}
                  </Button>
                </div>

              </div>
            </Card>
          </>
        )}

        {/* Statement Content */}
        {statementData && (
          <div className="space-y-6">
            {/* Statement Header */}
            <Card className="p-6 shadow-lg print:shadow-none">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h2 className="text-2xl font-bold mb-2">
                    Support at Home Monthly Statement
                  </h2>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Calendar className="h-4 w-4" />
                      <span className="font-medium">{statementData.month} {statementData.year}</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <User className="h-4 w-4" />
                      <span className="font-medium">{statementData.participant}</span>
                    </div>
                  </div>
                </div>
                <div className="print:hidden">
                  <Button
                    className="gap-2"
                    onClick={handleSaHMonthlyStatement}
                    disabled={!statementData || exportingSection === 'statement-pdf' || loading}
                  >
                    <FileCheck className="h-4 w-4" />
                    SaH Monthly Statement
                  </Button>
                </div>
              </div>

              {/* Business Details Display */}
              {businessDetails.companyName && (
                <div className="mt-4 p-4 bg-muted/30 rounded-lg">
                  <h3 className="font-semibold mb-2">Service Provider Details</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><span className="font-medium">Company:</span> {businessDetails.companyName}</div>
                    <div><span className="font-medium">Phone:</span> {businessDetails.phoneNumber}</div>
                    <div><span className="font-medium">Email:</span> {businessDetails.businessEmail}</div>
                    <div><span className="font-medium">Address:</span> {businessDetails.address}</div>
                    <div className="col-span-2"><span className="font-medium">Registration ID:</span> {businessDetails.companyRegistrationId || "N/A"}</div>
                  </div>
                </div>
              )}


              {statementData && (
                <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs uppercase tracking-wide">Participant Address</p>
                    <p className="font-medium text-foreground">{statementData.participantAddress || 'Not provided'}</p>
                    <p className="text-muted-foreground">
                      {[statementData.participantSuburb, statementData.participantState, statementData.participantPostcode]
                        .filter(Boolean)
                        .join(', ') || '—'}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs uppercase tracking-wide">Identifiers</p>
                    <p className="font-medium">My Aged Care ID</p>
                    <p className="text-muted-foreground">{statementData.myAgedCareIdNumber || 'Not provided'}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs uppercase tracking-wide">Provider ID</p>
                    <p className="font-medium text-foreground">{statementData.providerId || 'Not provided'}</p>
                  </div>
                </div>
              )}
            </Card>

            {chartConfigs.length > 0 && (
              <Card className="p-6 shadow-lg print:shadow-none">
                <div className="mb-6">
                  <h3 className="text-xl font-semibold">Budget Mini Charts</h3>
                  <p className="text-sm text-muted-foreground">
                    Visual summaries for each funding stream showing the ordered Support at Home layout.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {chartConfigs.map((chart) => (
                    <div key={chart.code} className="rounded-lg border border-border/60 bg-card p-5 space-y-4 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase text-muted-foreground tracking-wide">{chart.subtitle}</p>
                          <h4 className="text-base font-semibold leading-tight">{chart.title}</h4>
                        </div>
                        {(chart.serviceCount ?? 0) > 0 && (
                          <Badge
                            variant="secondary"
                            className="text-[11px] px-2 py-1 font-medium"
                          >
                            {(chart.serviceCount ?? 0).toLocaleString()} services
                          </Badge>
                        )}
                      </div>

                      <ChartContainer config={chart.chartConfig} className="h-56">
                        <BarChart data={chart.data} margin={{ left: 0, right: 0, top: 10 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="shortLabel" axisLine={false} tickLine={false} />
                          <YAxis tickFormatter={formatAxisCurrency} axisLine={false} tickLine={false} />
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                formatter={(value, name, item) => [
                                  formatCurrency(typeof value === 'number' ? value : Number(value)),
                                  (item?.payload as ChartBarDatum)?.label || name,
                                ]}
                              />
                            }
                          />
                          <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={42}>
                            {chart.data.map((entry) => (
                              <Cell key={`${chart.code}-${entry.name}`} fill={`var(--color-${entry.name})`} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ChartContainer>
                      {!chart.hasData && (
                        <p className="text-xs text-muted-foreground text-center">
                          No data available for this period.
                        </p>
                      )}

                      {chart.metrics.length > 0 && (
                        <div className="grid grid-cols-2 gap-3">
                          {chart.metrics.map((metric) => (
                            <div key={`${chart.code}-${metric.label}`}>
                              <p className="text-xs text-muted-foreground">{metric.label}</p>
                              <p className="text-sm font-semibold text-foreground">{formatCurrency(metric.value)}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Individualised Budgets */}
            <Card className="p-6 shadow-lg print:shadow-none">
              <div className="flex flex-col gap-2 mb-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="text-xl font-semibold">Budget Items</h3>
                  <p className="text-sm text-muted-foreground">
                    Items from: Home Support Quarterly Budget, Restorative Care Pathway Budget, End-of-Life Pathway Budget, Assistive Technology - Short-term Budget, Assistive Technology - Ongoing Budget, Home Modification Budget
                  </p>
                </div>
                <div className="print:hidden">
                  <Button
                    variant="outline"
                    className="gap-2"
                    onClick={handleBudgetExportCSV}
                    disabled={!statementData || exportingSection === 'budget-csv'}
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    Export to CSV
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                {loadingBudgetItems ? (
                  <div className="text-center py-8">
                    <Spinner />
                  </div>
                ) : budgetItems.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Funding Stream</TableHead>
                        <TableHead>Participant</TableHead>
                        <TableHead>Month</TableHead>
                        <TableHead>Year</TableHead>
                        <TableHead>FY Quarter</TableHead>
                        <TableHead className="text-right">Total Available</TableHead>
                        <TableHead className="text-right">Delivered (Selected Month)</TableHead>
                        <TableHead className="text-right">Adjustments</TableHead>
                        <TableHead className="text-right">Remaining Balance</TableHead>
                        <TableHead>Funding Start</TableHead>
                        <TableHead>Funding End</TableHead>
                        <TableHead>Fund</TableHead>
                        <TableHead className="text-right">Committed Funds</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {budgetItems.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="whitespace-nowrap">
                            {item.folderName || BUDGET_CATEGORY_LABELS[item.categoryCode] || 'Budget'}
                          </TableCell>
                          <TableCell>{item.participantName || 'N/A'}</TableCell>
                          <TableCell>{item.month || 'N/A'}</TableCell>
                          <TableCell>{item.year || 'N/A'}</TableCell>
                          <TableCell>{item.quarter || 'N/A'}</TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(item.totalAvailableBudget || 0)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(item.deliveredAmount || 0)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(item.adjustmentAmount || 0)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(item.remainingBalance || 0)}</TableCell>
                          <TableCell className="whitespace-nowrap">{formatDate(item.fundingStartDate)}</TableCell>
                          <TableCell className="whitespace-nowrap">{formatDate(item.fundingEndDate)}</TableCell>
                          <TableCell>{item.fund || 'N/A'}</TableCell>
                          <TableCell className="text-right">{formatCurrency(item.committedFunds || 0)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <AlertCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
                    <p>No budget items found</p>
                  </div>
                )}
              </div>
            </Card>

            {/* Service Records */}
            <Card className="p-6 shadow-lg print:shadow-none">
              <div className="flex flex-col gap-2 mb-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="text-xl font-semibold">Service Records</h3>
                  <p className="text-sm text-muted-foreground">
                    Items from: Master Plan, Shift Planning and Reporting
                  </p>
                </div>
                <div className="print:hidden">
                  <Button
                    variant="outline"
                    className="gap-2"
                    onClick={handleServiceExportCSV}
                    disabled={!statementData || exportingSection === 'service-csv'}
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    Export to CSV
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                {loadingServiceItems ? (
                  <div className="text-center py-8">
                    <Spinner />
                  </div>
                ) : serviceItems.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Participant</TableHead>
                        <TableHead>Service</TableHead>
                        <TableHead>Service Provider</TableHead>
                        <TableHead>Scheduled Service Date</TableHead>
                        <TableHead>Service Delivery Date</TableHead>
                        <TableHead>Transaction Status</TableHead>
                        <TableHead>Committed AT-HM for Delivery</TableHead>
                        <TableHead>Unit</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                        <TableHead className="text-right">Unit Price ($)</TableHead>
                        <TableHead className="text-right">Total Amount</TableHead>
                        <TableHead className="text-right">Gov Subsidy</TableHead>
                        <TableHead className="text-right">Participant Contribution</TableHead>
                        <TableHead>Funding Source</TableHead>
                        <TableHead>Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {serviceItems.map((service) => (
                        <TableRow key={service.id}>
                          <TableCell className="whitespace-nowrap">
                            {service.participant || 'N/A'}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate">
                            {service.service || service.taskName || service.notes || 'Service'}
                          </TableCell>
                          <TableCell>{service.serviceProvider || 'N/A'}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            {service.scheduledServiceDate ? formatDate(service.scheduledServiceDate) : 'N/A'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            {service.serviceDeliveryDate ? formatDate(service.serviceDeliveryDate) : 'N/A'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={service.transactionStatus === 'Delivered' ? 'default' : 'secondary'} className="text-xs">
                              {service.transactionStatus || 'Delivered'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {service.committedAtHmForDelivery !== undefined ? formatCurrency(service.committedAtHmForDelivery) : 'N/A'}
                          </TableCell>
                          <TableCell className="text-xs">{service.unit}</TableCell>
                          <TableCell className="text-right">{service.quantity}</TableCell>
                          <TableCell className="text-right">{formatCurrency(service.unitPrice)}</TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(service.totalAmount)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(service.govSubsidy)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(service.participantContribution)}</TableCell>
                          <TableCell className="text-xs">{service.fundingSource || 'Home Support'}</TableCell>
                          <TableCell className="max-w-[200px] truncate text-xs">{service.notes || 'N/A'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <AlertCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
                    <p>No services found for the selected period</p>
                  </div>
                )}
              </div>

              {!loadingServiceItems && serviceItems.length > 0 && (
                <div className="mt-6">
                  <Pagination>
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          onClick={() => handleServicePageChange(servicePagination.page - 1)}
                          className={servicePagination.page === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                        />
                      </PaginationItem>

                      {Array.from({ length: serviceTotalPages }, (_, i) => i + 1)
                        .filter((page) =>
                          page === 1 ||
                          page === serviceTotalPages ||
                          (page >= servicePagination.page - 1 && page <= servicePagination.page + 1)
                        )
                        .map((page, index, arr) => (
                          <div key={`service-pagination-${page}`} className="flex">
                            {index > 0 && arr[index - 1] !== page - 1 && (
                              <PaginationItem>
                                <PaginationEllipsis />
                              </PaginationItem>
                            )}
                            <PaginationItem>
                              <PaginationLink
                                onClick={() => handleServicePageChange(page)}
                                isActive={servicePagination.page === page}
                              >
                                {page}
                              </PaginationLink>
                            </PaginationItem>
                          </div>
                        ))}

                      <PaginationItem>
                        <PaginationNext
                          onClick={() => handleServicePageChange(servicePagination.page + 1)}
                          className={servicePagination.page === serviceTotalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                </div>
              )}
            </Card>

            {/* Summary Footer */}
            <Card className="p-6 shadow-lg print:shadow-none print:break-inside-avoid">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Statement Period</p>
                  <p className="text-lg font-semibold">
                    {statementData.month} {statementData.year}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Generated Date</p>
                  <p className="text-lg font-semibold">
                    {format(new Date(), 'dd/MM/yyyy')}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Total Services</p>
                  <p className="text-lg font-semibold">
                    {statementData.summary.totalServices} services
                  </p>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Government Subsidy</p>
                  <p className="text-lg font-semibold">
                    {formatCurrency(statementData.summary.govSubsidy)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Participant Contribution</p>
                  <p className="text-lg font-semibold">
                    {formatCurrency(statementData.summary.participantContribution)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Average Service Cost</p>
                  <p className="text-lg font-semibold">
                    {formatCurrency(statementData.summary.averageServiceCost)}
                  </p>
                </div>
              </div>

              {/* Important Notes */}
              <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                <h4 className="font-semibold text-sm mb-2 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" />
                  Important Information
                </h4>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                  <li>This statement shows all services delivered during the selected month.</li>
                  <li>Budget amounts are indicative and may vary based on your care plan.</li>
                  <li>Funding streams with zero balances are hidden automatically.</li>
                  <li>For queries or concerns, please contact your service provider.</li>
                  <li>Keep this statement for your records.</li>
                </ul>
              </div>
            </Card>
          </div>
        )}

        {/* Empty State */}
        {!statementData && !loading && (
          <Card className="p-12 text-center shadow-lg">
            <div className="flex flex-col items-center gap-4">
              <div className="bg-primary/10 w-16 h-16 rounded-full flex items-center justify-center">
                <Calendar className="h-8 w-8 text-primary" />
              </div>
              <div>
                <h3 className="text-xl font-semibold mb-2">No Statement Loaded</h3>
                <p className="text-muted-foreground">
                  Select a participant, month, and year above to generate the monthly statement
                </p>
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* Business Details Dialog */}
      <Dialog open={showBusinessDialog} onOpenChange={setShowBusinessDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Business Details Configuration</DialogTitle>
            <DialogDescription>
              Configure your business details for PDF generation. These will appear on the monthly statement.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="companyName">Company Name *</Label>
              <Input
                id="companyName"
                value={businessDetails.companyName}
                onChange={(e) => setBusinessDetails({ ...businessDetails, companyName: e.target.value })}
                placeholder="Enter company name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="companyRegistrationId">Company Registration ID *</Label>
              <Input
                id="companyRegistrationId"
                value={businessDetails.companyRegistrationId}
                onChange={(e) => setBusinessDetails({ ...businessDetails, companyRegistrationId: e.target.value })}
                placeholder="Enter provider registration ID"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phoneNumber">Phone Number *</Label>
              <Input
                id="phoneNumber"
                value={businessDetails.phoneNumber}
                onChange={(e) => setBusinessDetails({ ...businessDetails, phoneNumber: e.target.value })}
                placeholder="Enter phone number"
              />
            </div>

            <div className="space-y-2 col-span-2">
              <Label htmlFor="businessEmail">Business Email *</Label>
              <Input
                id="businessEmail"
                type="email"
                value={businessDetails.businessEmail}
                onChange={(e) => setBusinessDetails({ ...businessDetails, businessEmail: e.target.value })}
                placeholder="Enter business email"
              />
            </div>

            <div className="space-y-2 col-span-2">
              <Label htmlFor="address">Street Address</Label>
              <Input
                id="address"
                value={businessDetails.address}
                onChange={(e) => setBusinessDetails({ ...businessDetails, address: e.target.value })}
                placeholder="Enter street address"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="suburb">Suburb</Label>
              <Input
                id="suburb"
                value={businessDetails.suburb}
                onChange={(e) => setBusinessDetails({ ...businessDetails, suburb: e.target.value })}
                placeholder="Enter suburb"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="state">State</Label>
              <Input
                id="state"
                value={businessDetails.state}
                onChange={(e) => setBusinessDetails({ ...businessDetails, state: e.target.value })}
                placeholder="Enter state"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="postcode">Postcode</Label>
              <Input
                id="postcode"
                value={businessDetails.postcode}
                onChange={(e) => setBusinessDetails({ ...businessDetails, postcode: e.target.value })}
                placeholder="Enter postcode"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBusinessDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveBusinessDetails}>
              Save Details
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Print Styles */}
      <style jsx global>{`
        @media print {
          body {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
          .print\\:hidden {
            display: none !important;
          }
          .print\\:shadow-none {
            box-shadow: none !important;
          }
          .print\\:break-inside-avoid {
            break-inside: avoid;
          }
          @page {
            margin: 1cm;
            size: A4;
          }
        }
      `}</style>
    </div>
  );
}
