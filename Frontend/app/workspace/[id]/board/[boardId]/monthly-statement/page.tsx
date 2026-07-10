"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Calendar, User, FileText, AlertCircle, FileCheck, FileSpreadsheet, ArrowUpDown, ArrowUp, ArrowDown, HelpCircle, Download } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { toJpeg } from "html-to-image";
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
import { useAppContext } from "@/app/context";
import { fetchMonthlyStatementItems } from "@/app/utils/items";
import { format } from "date-fns";
import Spinner from "@/components/ui/spin";
import { showSuccessToast, showErrorToast, showInfoToast, showWarningToast, getApiErrorMessage } from "@/lib/toast-utils";
import { wrapChartTickLabel } from "@/lib/chart-tick-helpers";
import {
  buildMonthlyStatementQueryParams,
  buildStatementViewModel,
  getTransactionStatusBadgeVariant,
  groupBudgetItemsByFolder,
  validateStatementDateInputs,
} from "@/lib/monthly-statement-helpers";
import { executeMonthlyStatementPdfAction } from "@/lib/monthly-statement-pdf-helpers";
import { MonthlyStatementPageView } from "@/lib/monthly-statement-page-view";
import { pollBoardManualSyncStatus } from "@/lib/invoice-generator-sync-helpers";
import { getBoardNameFromSession, isValidRouteIdParam } from "@/lib/sync-manual-helpers";
import { isCareManagementLabel, isLowCatCareManagementLabel } from "@/lib/access";
import { ChartContainer, ChartStyle, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from "recharts";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { dateOnlyToStartOfDayISO, dateOnlyToEndOfDayISO, formatDateDDMMYYYY, getMonthBoundaryDates } from "@/lib/timezone";

interface ServiceRecord {
  id: string;
  participant: string;
  participantName?: string;
  scheduledStart: string | null;
  scheduledServiceDate?: string | null;
  scheduledShiftStart?: string | null;
  scheduledShiftStartDateTime?: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  actualShiftEndDateTime?: string | null;
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
  deliveredBy?: string;
  loanedByOrganisationName?: string;
  committedAtHmForDelivery?: number;
  allocatedTime?: number;
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
  /** Remaining ... as at End of Month ($) - from formula: Total Available + Delivered ($-) + Adjustments */
  remainingBalanceEndOfMonth?: number;
  /** Remaining ... for Allocation Period ($) - for ATS/ATO/HMB: End of Month + Committed - to be delivered */
  remainingBalanceAllocationPeriod?: number;
  fundClassification?: string | null;
  fundAmount?: number;
  fund?: string;
  committedFunds?: number;
  primarySupplementLabel?: string;
  fundingStreamId?: string | null;
  hscmDate?: string | null;
  hscmTransactionType?: string;
  hscmReceivedAmount?: number;
  hscmAllocatedTime?: number;
  hscmAllocatedAmount?: number;
  hscmCurrentBalance?: number;
  rawData?: Record<string, unknown>;
}

interface BudgetCategory {
  name: string;
  code: string;
  availableFunds: number;
  remainingBudget: number;
  /** For ATS/ATO/HMB: Remaining ... Balance for Allocation Period ($) - used for blue bar */
  remainingBalanceAllocationPeriod?: number;
  /** For ATS/ATO/HMB: Remaining ... Balance as at the End of the Month ($) */
  remainingBalanceEndOfMonth?: number;
  services?: ServiceRecord[];
  fundingEndDate?: string | null;
  committedFunds?: number;
  quarterStartMonth?: string;
  quarterEndMonth?: string;
  serviceDeliveredAmount?: number;
  serviceDeliveredAmountRaw?: number;
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
  deliveredAmount?: number;
  totalAvailableBudget?: number;
  hscmTotalAllocatedTime?: number;
  hscmTotalReceivedAmount?: number;
  hscmTotalAllocatedAmount?: number;
  hscmItemCount?: number;
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
  };
  participantAddress?: string;
  participantSuburb?: string;
  participantState?: string;
  participantPostcode?: string;
  myAgedCareIdNumber?: string;
  providerId?: string;
  fundingSources: string[]; // Add fundingSources to the interface
}

interface BusinessDetails {
  companyName: string;
  phoneNumber: string;
  businessEmail: string;
  address: string;
  location: string;
  country: string;
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
  HSCM: 'Home Support Care Management Budget',
  RCP: 'Restorative Care Pathway Budget',
  EOL: 'End-of-Life Pathway Budget',
  ATS: 'Assistive Technology - Short-term Budget',
  ATO: 'Assistive Technology - Ongoing Budget',
  HMB: 'Home Modification Budget',
};

// Shared category order used for rendering and export
const CATEGORY_ORDER = ['HSQ', 'ATS', 'ATO', 'HMB', 'RCP', 'EOL', 'HSCM'] as const;

const BUDGET_TABLE_COLUMNS: Record<string, string[]> = {
  HSQ: [
    'Funding Stream',
    'Participant Profile',
    'Fund',
    'Year',
    'FY Quarter',
    'Month',
    'Funding Start Date',
    'Funding End Date',
    'Fund Classification',
    'Fund Amount ($)',
    'Quarterly Budget ($)',
    'Available Fund at the Start of the Month ($)',
    'Classification Quarterly Budget Adjustment ($)',
    'Primary Supplement',
    'Primary Supplement ($)',
    'Carryover Funding from the Previous Quarter ($)',
    'Unspent Budget at the End of the Quarter-Returned ($-)',
    'Unspent HCP Funds Commonwealth Portion (Provider-held) ($)',
    'Commonwealth-held HCP Unspent Funds (Notional Home Care Account) ($)',
    'Unspent HCP Funds-Participant Portion (Provider-held) ($)',
    'Spending from Previous Month(s) within same Quarter ($)',
    'Total Available Budget for Home Support ($)',
    'Home Support Delivered During the Month ($-)',
    'Adjustments from Previous Months [Charges($-)/Refund($)]',
    'Remaining Home Support Balance as at the End of the Month ($)',
    'Notes'
  ],
  ATS: [
    'Funding Stream',
    'Participant Profile',
    'Fund',
    'Year',
    'Month',
    'Funding Start Date',
    'Funding End Date',
    'Fund Amount ($)',
    'Available Fund at the Start of the Month ($)',
    'Primary Supplement',
    'Primary Supplement ($)',
    'Additional amount approved (AT high tier) ($)',
    'Spending from Previous Month(s) within Allocated Period ($)',
    'Total Available Fund for AT - Short-term ($)',
    'AT - Short-term Delivered During the Month ($-)',
    'Adjustments from Previous Months [Charges($-)/Refund($)]',
    'Remaining AT - Short-term Balance as at the End of the Month ($)',
    'Committed AT Short-term Funds - to be delivered ($-)',
    'Remaining AT - Short-term Balance for Allocation Period ($)',
    'Notes'
  ],
  ATO: [
    'Funding Stream',
    'Participant Profile',
    'Fund',
    'Year',
    'Month',
    'Funding Start Date',
    'Funding End Date',
    'Fund Amount ($)',
    'Available Fund at the Start of the Month ($)',
    'Primary Supplement',
    'Primary Supplement ($)',
    'Spending from Previous Month(s) within Allocated Period ($)',
    'Total Available Fund for AT Ongoing ($)',
    'AT - Ongoing Delivered During the Month ($-)',
    'Adjustments from Previous Months [Charges($-)/Refund($)]',
    'Remaining AT - Ongoing Balance as at the End of the Month ($)',
    'Committed AT Ongoing Funds - to be delivered ($-)',
    'Remaining AT - Ongoing Balance for Allocation Period ($)',
    'Notes'
  ],
  HMB: [
    'Funding Stream',
    'Participant Profile',
    'Fund',
    'Year',
    'Month',
    'Funding Start Date',
    'Funding End Date',
    'Fund Amount ($)',
    'Available Fund at the Start of the Month ($)',
    'Primary Supplement',
    'Primary Supplement ($)',
    'Spending from Previous Month(s) within Allocated Period ($)',
    'Total Available Fund for HM ($)',
    'Home Modification Delivered During the Month ($-)',
    'Adjustments from Previous Months [Charges($-)/Refund($)]',
    'Remaining HM Balance as at the End of the Month ($)',
    'Committed HM Funds - to be delivered ($-)',
    'Remaining HM Balance for Allocation Period ($)',
    'Notes'
  ],
  RCP: [
    'Funding Stream',
    'Participant Profile',
    'Fund',
    'Year',
    'Month',
    'Funding Start Date',
    'Funding End Date',
    'Fund Amount ($)',
    'Available Fund at the Start of the Month ($)',
    'Primary Supplement',
    'Primary Supplement ($)',
    'Spending from Previous Month(s) within Allocated Period ($)',
    'Total Available Budget for Restorative Care ($)',
    'Restorative Care Delivered During the Month ($-)',
    'Adjustments from Previous Months [Charges($-)/Refund($)]',
    'Remaining Restorative Care Balance as at the End of the Month ($)',
    'Notes'
  ],
  EOL: [
    'Funding Stream',
    'Participant Profile',
    'Fund',
    'Year',
    'Month',
    'Funding Start Date',
    'Funding End Date',
    'Fund Amount ($)',
    'Available Fund at the Start of the Month ($)',
    'Primary Supplement',
    'Primary Supplement ($)',
    'Spending from Previous Month(s) within Allocated Period ($)',
    'Total Available Budget for End-of-Life Care ($)',
    'End-of-Life Care Delivered During the Month ($-)',
    'Adjustments from Previous Months [Charges($-)/Refund($)]',
    'Remaining End-of-Life Care Balance as at the End of the Month ($)',
    'Notes'
  ],
  HSCM: [
    'Date',
    'Transaction Type',
    'Associated Participant',
    'Received Amount ($)',
    'Allocated Time (Hr.)',
    'Allocated Amount ($-)',
    'Net Movement ($)'
  ]
};

const BUDGET_COLUMN_ALIASES: Record<string, string[]> = {
  'Funding Stream': ['Funding Stream', 'Funding Source'],
  'Participant Profile': ['Participant Profile', 'Participant'],
  'Unspent Budget at the End of the Quarter-Returned ($-)': [
    'Unspent Budget at the End of the Quarter – Returned ($-)',
    'Unspent Budget at the End of the Quarter-Returned ($-)',
    'Unspent Budget at the End of the Quarter - Returned ($-)'
  ],
  'Unspent HCP Funds Commonwealth Portion (Provider-held) ($)': [
    'Unspent HCP Funds - Commonwealth Portion (Provider-held) ($)'
  ],
  'Commonwealth-held HCP Unspent Funds (Notional Home Care Account) ($)': [
    'Commonwealth-held HCP Unspent Funds (Notional Home Care Account) ($)',
    'Commonwealth-held HCP Unspent Funds ($)'
  ],
  'Unspent HCP Funds-Participant Portion (Provider-held) ($)': [
    'Unspent HCP Funds - Participant Portion (Provider-held) ($)',
    'Participant Portion HCP Unspent Funds ($)'
  ]
};

const countryStates: { [key: string]: string[] } = {
  "Afghanistan": [],
  "Albania": [],
  "Algeria": [],
  "Andorra": [],
  "Angola": [],
  "Antigua and Barbuda": [],
  "Argentina": [],
  "Armenia": [],
  "Australia": ["New South Wales", "Victoria", "Queensland", "Western Australia", "South Australia", "Tasmania", "Northern Territory", "Australian Capital Territory"],
  "Austria": [],
  "Azerbaijan": [],
  "Bahamas": [],
  "Bahrain": [],
  "Bangladesh": [],
  "Barbados": [],
  "Belarus": [],
  "Belgium": [],
  "Belize": [],
  "Benin": [],
  "Bhutan": [],
  "Bolivia": [],
  "Bosnia and Herzegovina": [],
  "Botswana": [],
  "Brazil": [],
  "Brunei": [],
  "Bulgaria": [],
  "Burkina Faso": [],
  "Burundi": [],
  "Cabo Verde": [],
  "Cambodia": [],
  "Cameroon": [],
  "Canada": ["Alberta", "British Columbia", "Manitoba", "New Brunswick", "Newfoundland and Labrador", "Nova Scotia", "Ontario", "Prince Edward Island", "Quebec", "Saskatchewan", "Northwest Territories", "Nunavut", "Yukon"],
  "Central African Republic": [],
  "Chad": [],
  "Chile": [],
  "China": [],
  "Colombia": [],
  "Comoros": [],
  "Congo, Democratic Republic of the": [],
  "Congo, Republic of the": [],
  "Costa Rica": [],
  "Croatia": [],
  "Cuba": [],
  "Cyprus": [],
  "Czech Republic": [],
  "Denmark": [],
  "Djibouti": [],
  "Dominica": [],
  "Dominican Republic": [],
  "Ecuador": [],
  "Egypt": [],
  "El Salvador": [],
  "Equatorial Guinea": [],
  "Eritrea": [],
  "Estonia": [],
  "Eswatini": [],
  "Ethiopia": [],
  "Fiji": [],
  "Finland": [],
  "France": [],
  "Gabon": [],
  "Gambia": [],
  "Georgia": [],
  "Germany": [],
  "Ghana": [],
  "Greece": [],
  "Grenada": [],
  "Guatemala": [],
  "Guinea": [],
  "Guinea-Bissau": [],
  "Guyana": [],
  "Haiti": [],
  "Honduras": [],
  "Hungary": [],
  "Iceland": [],
  "India": ["Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu", "Lakshadweep", "Delhi", "Puducherry", "Ladakh", "Jammu and Kashmir"],
  "Indonesia": [],
  "Iran": [],
  "Iraq": [],
  "Ireland": [],
  "Israel": [],
  "Italy": [],
  "Jamaica": [],
  "Japan": [],
  "Jordan": [],
  "Kazakhstan": [],
  "Kenya": [],
  "Kiribati": [],
  "Korea, North": [],
  "Korea, South": [],
  "Kosovo": [],
  "Kuwait": [],
  "Kyrgyzstan": [],
  "Laos": [],
  "Latvia": [],
  "Lebanon": [],
  "Lesotho": [],
  "Liberia": [],
  "Libya": [],
  "Liechtenstein": [],
  "Lithuania": [],
  "Luxembourg": [],
  "Madagascar": [],
  "Malawi": [],
  "Malaysia": [],
  "Maldives": [],
  "Mali": [],
  "Malta": [],
  "Marshall Islands": [],
  "Mauritania": [],
  "Mauritius": [],
  "Mexico": [],
  "Micronesia": [],
  "Moldova": [],
  "Monaco": [],
  "Mongolia": [],
  "Montenegro": [],
  "Morocco": [],
  "Mozambique": [],
  "Myanmar": [],
  "Namibia": [],
  "Nauru": [],
  "Nepal": [],
  "Netherlands": [],
  "New Zealand": [],
  "Nicaragua": [],
  "Niger": [],
  "Nigeria": [],
  "North Macedonia": [],
  "Norway": [],
  "Oman": [],
  "Pakistan": ["Balochistan", "Khyber Pakhtunkhwa", "Punjab", "Sindh", "Islamabad Capital Territory", "Gilgit-Baltistan", "Azad Jammu and Kashmir"],
  "Palau": [],
  "Palestine": [],
  "Panama": [],
  "Papua New Guinea": [],
  "Paraguay": [],
  "Peru": [],
  "Philippines": [],
  "Poland": [],
  "Portugal": [],
  "Qatar": [],
  "Romania": [],
  "Russia": [],
  "Rwanda": [],
  "Saint Kitts and Nevis": [],
  "Saint Lucia": [],
  "Saint Vincent and the Grenadines": [],
  "Samoa": [],
  "San Marino": [],
  "Sao Tome and Principe": [],
  "Saudi Arabia": [],
  "Senegal": [],
  "Serbia": [],
  "Seychelles": [],
  "Sierra Leone": [],
  "Singapore": [],
  "Slovakia": [],
  "Slovenia": [],
  "Solomon Islands": [],
  "Somalia": [],
  "South Africa": [],
  "South Sudan": [],
  "Spain": [],
  "Sri Lanka": [],
  "Sudan": [],
  "Suriname": [],
  "Sweden": [],
  "Switzerland": [],
  "Syria": [],
  "Taiwan": [],
  "Tajikistan": [],
  "Tanzania": [],
  "Thailand": [],
  "Timor-Leste": [],
  "Togo": [],
  "Tonga": [],
  "Trinidad and Tobago": [],
  "Tunisia": [],
  "Turkey": [],
  "Turkmenistan": [],
  "Tuvalu": [],
  "Uganda": [],
  "Ukraine": [],
  "United Arab Emirates": ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah and Fujairah"],
  "United Kingdom": ["England", "Scotland", "Wales", "Northern Ireland"],
  "United States": ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"],
  "Uruguay": [],
  "Uzbekistan": [],
  "Vanuatu": [],
  "Vatican City": [],
  "Venezuela": [],
  "Vietnam": [],
  "Yemen": [],
  "Zambia": [],
  "Zimbabwe": []
};

export default function MonthlyStatement() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split('/')[2];
  const boardId = pathname.split('/')[4];

  const { syncStatuses, setSyncStatuses } = useAppContext();

  const [boardLabel, setBoardLabel] = useState<string>("");
  const [boardLabelChecked, setBoardLabelChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingParticipants, setLoadingParticipants] = useState(false);
  const [loadingServiceItems, setLoadingServiceItems] = useState(false);
  const [statementData, setStatementData] = useState<MonthlyStatementData | null>(null);
  const [budgetItems, setBudgetItems] = useState<Record<string, BudgetRecord[]>>({});
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
    country: "",
    suburb: "",
    state: "",
    postcode: "",
    companyRegistrationId: "",
  });
  const [exportingSection, setExportingSection] = useState<null | 'budget-csv' | 'service-csv' | 'statement-pdf' | 'budget-HSQ' | 'budget-HSCM' | 'budget-ATS' | 'budget-ATO' | 'budget-HMB' | 'budget-RCP' | 'budget-EOL'>(null);
  const [businessDetailsErrors, setBusinessDetailsErrors] = useState<string[]>([]);
  const [serviceSortBy, setServiceSortBy] = useState<'scheduledServiceDate' | 'serviceDeliveryDate' | ''>('scheduledServiceDate');
  const [serviceSortOrder, setServiceSortOrder] = useState<'asc' | 'desc'>('asc');
  const [serviceTransactionStatusFilter, setServiceTransactionStatusFilter] = useState<string>('all');
  const [distinctTransactionStatuses, setDistinctTransactionStatuses] = useState<string[]>([]);
  const [serviceFundingSourceFilter, setServiceFundingSourceFilter] = useState<string>('all');
  const [distinctFundingSources, setDistinctFundingSources] = useState<string[]>([]);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartCardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const syncCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const previousSyncStatusRef = useRef<{ boardId: string; status: string; startTime?: number; seenInContext?: boolean } | null>(null);
  const fetchStatementDataRef = useRef<(() => Promise<void>) | null>(null);
  const [businessTimezone, setBusinessTimezone] = useState<string>("Australia/Sydney");


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

  const canUseMonthlyStatement =
    boardLabelChecked &&
    isCareManagementLabel(boardLabel) &&
    !isLowCatCareManagementLabel(boardLabel);

  useEffect(() => {
    const fetchBoardLabel = async () => {
      try {
        setBoardLabelChecked(false);
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/boards?id=${boardId}`,
          {
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            }
          }
        );

        setBoardLabel(response.data?.board?.label || "");
      } catch (err) {
        console.error('Error fetching board label:', err);
        setBoardLabel("");
      } finally {
        setBoardLabelChecked(true);
      }
    };

    if (boardId) {
      fetchBoardLabel();
    }
  }, [boardId]);

  useEffect(() => {
    if (boardLabelChecked && !canUseMonthlyStatement) {
      router.replace("/workspace/access-denied");
    }
  }, [boardLabelChecked, canUseMonthlyStatement, router]);

  // Fetch unique participants using dedicated endpoint
  useEffect(() => {
    const fetchParticipants = async () => {
      if (!id || !boardId) return;
      if (!canUseMonthlyStatement) return;

      setLoadingParticipants(true);
      try {
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/monthly-statement/participants`,
          {
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            }
          }
        );

        if (response.data?.participants) {
          const participants = response.data.participants.filter((p: string) => p && p.trim() !== '');
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
  }, [id, boardId, canUseMonthlyStatement]);

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
            country: response.data.address?.country || "",
            suburb: response.data.address?.suburb || "",
            state: response.data.address?.state || "",
            postcode: response.data.address?.postcode || "",
            companyRegistrationId: response.data.companyRegistrationId || "",
          });
          if (response.data.headOfficeTimezone) {
            setBusinessTimezone(response.data.headOfficeTimezone);
          }
        }
      } catch (err) {
        console.error('Error loading business details:', err);
      }
    };

    if (id) {
      if (!canUseMonthlyStatement) return;
      loadBusinessDetails();
    }
  }, [id, canUseMonthlyStatement]);

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

    const { firstDay, lastDay } = getMonthBoundaryDates(yearNum, monthNum);

    return {
      startDate: dateOnlyToStartOfDayISO(firstDay, businessTimezone),
      endDate: dateOnlyToEndOfDayISO(lastDay, businessTimezone),
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
    // Prepend BOM for Excel to recognise UTF-8
    const bom = '\uFEFF';
    const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const formatDateForCsv = (dateString: string | null | undefined) => {
    if (!dateString) return '';
    if (typeof dateString === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(dateString.trim())) {
      return dateString.trim();
    }
    return formatDateDDMMYYYY(dateString, businessTimezone) || '';
  };

  const handleServicePageChange = (page: number) => {
    if (loadingServiceItems) return;
    const totalPages = Math.max(1, Math.ceil(servicePagination.total / servicePagination.limit));
    if (page < 1 || page > totalPages || page === servicePagination.page) return;
    fetchServiceItems(page, servicePagination.limit);
  };

  const serviceTotalPages = Math.max(1, Math.ceil((servicePagination.total || 0) / (servicePagination.limit || 1)));

  const fetchServiceItems = async (page: number = 1, limit: number = servicePagination.limit, sortBy?: 'scheduledServiceDate' | 'serviceDeliveryDate' | '', sortOrder?: 'asc' | 'desc', transactionStatus?: string, fundingSource?: string) => {
    if (!selectedParticipant || !selectedMonth || !selectedYear) {
      return;
    }

    setLoadingServiceItems(true);
    try {
      const monthNum = parseInt(selectedMonth);
      const yearNum = parseInt(selectedYear);
      const { firstDay, lastDay } = getMonthBoundaryDates(yearNum, monthNum);
      const startDateISO = dateOnlyToStartOfDayISO(firstDay, businessTimezone);
      const endDateISO = dateOnlyToEndOfDayISO(lastDay, businessTimezone);

      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/monthly-statement`,
        {
          params: {
            participant: selectedParticipant,
            startDate: startDateISO,
            endDate: endDateISO,
            month: selectedMonth,
            year: selectedYear,
            servicePage: page,
            serviceLimit: limit,
            ...((sortBy ?? serviceSortBy) ? { serviceSortBy: sortBy ?? serviceSortBy, serviceSortOrder: (sortOrder ?? serviceSortOrder) || 'asc' } : {}),
            ...(transactionStatus !== undefined ? { serviceTransactionStatus: transactionStatus } : { serviceTransactionStatus: serviceTransactionStatusFilter }),
            ...(fundingSource !== undefined ? { serviceFundingSource: fundingSource } : { serviceFundingSource: serviceFundingSourceFilter }),
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
        if (Array.isArray(serviceData.distinctTransactionStatuses)) {
          setDistinctTransactionStatuses(serviceData.distinctTransactionStatuses);
        }
        if (Array.isArray(serviceData.distinctFundingSources)) {
          setDistinctFundingSources(serviceData.distinctFundingSources);
        }
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
    services: Array<Record<string, any>>,
    budgetCategoriesFromAPI: unknown,
    monthNumber: string,
    year: string
  ): BudgetCategory[] => {
    const apiCategories = budgetCategoriesFromAPI as BudgetCategory[] | undefined;
    const quarterMonths = getQuarterMonths(monthNumber);
    const defaultFundingEndDate = new Date(parseInt(year), 11, 31).toISOString(); // End of year

    // If budget categories are provided from API, use them directly (services are already categorized in backend)
    if (apiCategories && apiCategories.length > 0) {
      // Create a map for quick lookup
      const categoryMap = new Map<string, BudgetCategory>();
      apiCategories.forEach(cat => {
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
          category.services.push(service as ServiceRecord);
        }
      });

      // Return categories in the correct order
      const categoryOrder = ['HSQ', 'HSCM', 'ATS', 'ATO', 'HMB', 'RCP', 'EOL'];
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

  const stopSyncChecking = useCallback(() => {
    if (syncCheckIntervalRef.current) {
      clearInterval(syncCheckIntervalRef.current);
      syncCheckIntervalRef.current = null;
    }
    previousSyncStatusRef.current = null;
  }, []);

  const checkSyncStatus = useCallback(async () => {
    if (!id || !boardId) {
      return;
    }

    try {
      await pollBoardManualSyncStatus({
        workspaceId: id,
        boardId,
        previousSync: previousSyncStatusRef.current,
        axios,
        setSyncStatuses,
        previousSyncStatusRef,
        stopSyncChecking,
        showErrorToast,
        showSuccessToast,
        onCompleted: () => {
          void fetchStatementDataRef.current?.();
        },
      });
    } catch (err: any) {
      console.error('Error checking sync status:', err);
    }
  }, [id, boardId, stopSyncChecking, setSyncStatuses]);

  useEffect(() => {
    return () => {
      stopSyncChecking();
    };
  }, [stopSyncChecking]);

  const handleManualSync = async () => {
    if (!isValidRouteIdParam(id) || !isValidRouteIdParam(boardId)) {
      console.error('Invalid parameters for manual sync:', {
        workspaceId: id,
        boardId,
        workspaceIdType: typeof id,
        boardIdType: typeof boardId
      });
      showErrorToast('Workspace or board missing', {
        description: 'Please navigate back and select a workspace and board again. The current URL may be invalid.'
      });
      return;
    }

    try {
      setIsManualSyncing(true);
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/sync/board/manual`;
      const response = await axios.post(apiUrl, {
        workspaceId: id.trim(),
        boardId: boardId.trim()
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (response.data?.success) {
        showSuccessToast('Manual sync queued', {
          description: 'Your job is in the queue and will be processed shortly. Data will refresh automatically when complete. You can track progress in the sync indicator.'
        });

        if (syncCheckIntervalRef.current) {
          clearInterval(syncCheckIntervalRef.current);
          syncCheckIntervalRef.current = null;
        }

        const boardName = getBoardNameFromSession(boardId);

        const initialSyncStatus = {
          boardId: boardId,
          boardName: boardName,
          status: 'started' as const,
          syncType: 'manual_triggered_sync',
          startTime: new Date().toISOString(),
          progress: {
            foldersProcessed: 0,
            totalFolders: 0,
            currentFolder: undefined,
            itemsProcessed: 0
          },
          isManualSync: true
        };

        setSyncStatuses(prev => {
          const existingIndex = prev.findIndex(s => s.boardId === boardId);
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = {
              ...initialSyncStatus,
              ...updated[existingIndex],
              status: 'started' as const,
              startTime: new Date().toISOString()
            };
            return updated;
          } else {
            return [...prev, initialSyncStatus];
          }
        });

        previousSyncStatusRef.current = {
          boardId: boardId,
          status: 'started',
          startTime: Date.now(),
          seenInContext: false
        };

        setTimeout(() => {
          checkSyncStatus();
        }, 10000);

        syncCheckIntervalRef.current = setInterval(() => {
          checkSyncStatus();
        }, 10000);
      } else if (response.data?.alreadyRunning) {
        showWarningToast('Sync already running', {
          description: response.data?.message || 'A manual sync is already in progress. Please wait for it to complete.',
          duration: 5000
        });
      } else {
        showErrorToast('Sync not started', {
          description: response.data?.message || 'Sync could not be started. It may already be in progress.'
        });
      }
    } catch (err: any) {
      console.error('Error triggering manual sync:', err);
      const errorMessage = err.response?.data?.message || err.message || 'Unknown error';
      const statusCode = err.response?.status;

      if (err.response?.data?.alreadyRunning) {
        showWarningToast('Sync already running', {
          description: err.response.data?.message || 'A manual sync is already in progress. Please wait for it to complete.',
          duration: 5000
        });
      } else if (statusCode === 404 || errorMessage.toLowerCase().includes('board not found')) {
        showErrorToast('Board not found', {
          description: 'The board could not be found. Please navigate back and select a valid board, or check if the board ID is correct.',
          duration: 7000
        });
      } else if (statusCode === 400) {
        showErrorToast('Invalid request', {
          description: errorMessage || 'Please check that workspace and board IDs are valid.',
          duration: 7000
        });
      } else {
        showErrorToast('Failed to trigger manual sync', {
          description: errorMessage
        });
      }
    } finally {
      setIsManualSyncing(false);
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

    const dateValidationError = validateStatementDateInputs(monthNum, yearNum, currentYear);
    if (dateValidationError) {
      showErrorToast(dateValidationError);
      return;
    }

    setLoading(true);
    setLoadingServiceItems(true);
    setServiceTransactionStatusFilter('all');
    setServiceFundingSourceFilter('all');
    try {
      // Calculate date range for selected month using timezone-aware boundaries
      if (Number.isNaN(monthNum) || Number.isNaN(yearNum)) {
        showErrorToast('Invalid date selected');
        return;
      }
      const { firstDay: fd, lastDay: ld } = getMonthBoundaryDates(yearNum, monthNum);
      const startDateISO2 = dateOnlyToStartOfDayISO(fd, businessTimezone);
      const endDateISO2 = dateOnlyToEndOfDayISO(ld, businessTimezone);

      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/monthly-statement`,
        {
          params: buildMonthlyStatementQueryParams({
            participant: selectedParticipant,
            startDate: startDateISO2,
            endDate: endDateISO2,
            month: selectedMonth,
            year: selectedYear,
            budgetPage: budgetPagination.page,
            budgetLimit: budgetPagination.limit,
            servicePage: servicePagination.page,
            serviceLimit: servicePagination.limit,
            serviceSortBy,
            serviceSortOrder,
            serviceTransactionStatusFilter: 'all',
            serviceFundingSourceFilter: 'all',
          }),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      const data = response.data;

      const { grouped: groupedItems, flat: allBudgetItemsFlat } = groupBudgetItemsByFolder(data?.budgetItems);
      setBudgetItems(groupedItems as Record<string, BudgetRecord[]>);
      if (data?.budgetItems) {
        setBudgetPagination({
          page: data.budgetItems.page || budgetPagination.page,
          limit: data.budgetItems.limit || budgetPagination.limit,
          total: data.budgetItems.total || 0
        });
      }

      const services: ServiceRecord[] = data?.serviceItems?.items || [];
      if (data?.serviceItems) {
        setServiceItems(services);
        setServicePagination({
          page: data.serviceItems.page || servicePagination.page,
          limit: data.serviceItems.limit || servicePagination.limit,
          total: data.serviceItems.total || 0
        });
        setDistinctTransactionStatuses(Array.isArray(data.serviceItems.distinctTransactionStatuses) ? data.serviceItems.distinctTransactionStatuses : []);
        setDistinctFundingSources(Array.isArray(data.serviceItems.distinctFundingSources) ? data.serviceItems.distinctFundingSources : []);
      } else {
        setServiceItems([]);
        setServicePagination({ page: 1, limit: 10, total: 0 });
        setDistinctTransactionStatuses([]);
        setDistinctFundingSources([]);
      }

      setStatementData(buildStatementViewModel(
        data,
        services,
        allBudgetItemsFlat as BudgetRecord[],
        selectedParticipant,
        selectedMonth,
        selectedYear,
        months,
        businessDetails.companyRegistrationId || '',
        categorizeServices,
      ) as typeof statementData);

      showSuccessToast('Statement loaded successfully');
    } catch (err) {
      console.error('Error fetching statement data:', err);
      showErrorToast('Failed to fetch statement data');
    } finally {
      setLoading(false);
      setLoadingServiceItems(false);
    }
  };
  fetchStatementDataRef.current = fetchStatementData;

  const getPdfChartCellSize = (cols: number) => {
    if (cols === 3) return { width: 500, height: 600 };
    return { width: 800, height: 600 };
  };

  const waitForFontsAndNextPaint = async () => {
    try {
      if (typeof document !== 'undefined' && document.fonts) {
        await document.fonts.ready;
      }
    } catch {
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  };

  const captureChartAsLightPng = async (captureEl: HTMLElement) => {
    const rect = captureEl.getBoundingClientRect();
    const clone = captureEl.cloneNode(true) as HTMLElement;

    const stripDarkVariantClasses = (el: Element) => {
      const classList = (el as HTMLElement).classList;
      if (!classList) return;
      const toRemove: string[] = [];
      classList.forEach((cls) => {
        if (cls.startsWith('dark:')) toRemove.push(cls);
      });
      toRemove.forEach((cls) => classList.remove(cls));
    };
    stripDarkVariantClasses(clone);
    clone.querySelectorAll('*').forEach(stripDarkVariantClasses);

    const width = Math.max(1, Math.ceil(rect.width));
    const height = Math.max(1, Math.ceil(rect.height));
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;

    clone.style.backgroundColor = '#ffffff';
    clone.style.color = '#000000';
    clone.style.setProperty('--background', '0 0% 100%');
    clone.style.setProperty('--foreground', '0 0% 0%');
    clone.style.setProperty('--card', '0 0% 100%');
    clone.style.setProperty('--card-foreground', '0 0% 0%');
    clone.style.setProperty('--popover', '0 0% 100%');
    clone.style.setProperty('--popover-foreground', '0 0% 0%');
    clone.style.setProperty('--muted', '0 0% 96%');
    clone.style.setProperty('--muted-foreground', '0 0% 45%');
    clone.style.setProperty('--border', '0 0% 90%');

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      svg text, svg tspan { fill: hsl(var(--foreground)) !important; }
    `;
    clone.prepend(styleEl);

    const wrapper = document.createElement('div');
    wrapper.style.position = 'fixed';
    wrapper.style.left = '-100000px';
    wrapper.style.top = '0';
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.style.pointerEvents = 'none';
    wrapper.style.zIndex = '-1';
    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      // Use JPEG + lower pixel ratio to keep request payload small (prevents 413 at proxies).
      return await toJpeg(clone, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: 'white',
        quality: 0.85,
      });
    } finally {
      document.body.removeChild(wrapper);
    }
  };

  // Composite separate chart images into one image (cols per row) for PDF export.
  const compositeChartImages = async (
    dataUrls: string[],
    cols: number,
    cellSize?: { width: number; height: number },
    options?: {
      targetAspect?: number;
      gap?: number;
      background?: string;
      fit?: 'contain' | 'cover';
    }
  ): Promise<string> => {
    if (dataUrls.length === 0) return '';
    const gap = options?.gap ?? 0;
    const background = options?.background ?? 'white';
    const fit = options?.fit ?? 'contain';
    const loadImage = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    const images = await Promise.all(dataUrls.map((src) => loadImage(src)));
    const maxW = cellSize?.width ?? Math.max(...images.map((img) => img.width));
    const maxH = cellSize?.height ?? Math.max(...images.map((img) => img.height));
    const rows = Math.ceil(images.length / cols);

    // IMPORTANT:
    // - pdfme scales images into a fixed (w,h) box without preserving aspect ratio.
    // - Cropping loses information (your current issue).
    // So we render a composite PNG that ALREADY matches the PDF box aspect ratio,
    // and we *scale charts down to fit* (contain) instead of cropping.
    const targetAspect = options?.targetAspect;
    const validTargetAspect = !!targetAspect && Number.isFinite(targetAspect) && targetAspect > 0;
    if (!validTargetAspect) {
      // Fallback to a simple grid canvas (no enforced aspect).
      const gridW = cols * maxW + (cols - 1) * gap;
      const gridH = rows * maxH + (rows - 1) * gap;
      const canvas = document.createElement("canvas");
      canvas.width = gridW;
      canvas.height = gridH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return dataUrls[0];
      ctx.imageSmoothingEnabled = true;
      (ctx as unknown as { imageSmoothingQuality?: string }).imageSmoothingQuality = 'high';
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      images.forEach((img, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = col * (maxW + gap);
        const y = row * (maxH + gap);
        ctx.fillStyle = background;
        ctx.fillRect(x, y, maxW, maxH);
        const scale = Math.min(maxW / img.width, maxH / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, x + (maxW - dw) / 2, y + (maxH - dh) / 2, dw, dh);
      });
      return canvas.toDataURL("image/jpeg", 0.82);
    }

    // Choose a canvas size that preserves the target aspect while minimizing downscaling.
    // Candidate A: base on width; Candidate B: base on height; pick larger effective scale.
    const target = targetAspect as number;
    const candA_W = Math.max(1, Math.round(cols * maxW + (cols - 1) * gap));
    const candA_H = Math.max(1, Math.round(candA_W / target));
    const candA_cellW = (candA_W - (cols - 1) * gap) / cols;
    const candA_cellH = (candA_H - (rows - 1) * gap) / rows;
    const candA_scale = Math.min(candA_cellW / maxW, candA_cellH / maxH);

    const candB_H = Math.max(1, Math.round(rows * maxH + (rows - 1) * gap));
    const candB_W = Math.max(1, Math.round(candB_H * target));
    const candB_cellW = (candB_W - (cols - 1) * gap) / cols;
    const candB_cellH = (candB_H - (rows - 1) * gap) / rows;
    const candB_scale = Math.min(candB_cellW / maxW, candB_cellH / maxH);

    const canvasW = candB_scale > candA_scale ? candB_W : candA_W;
    const canvasH = candB_scale > candA_scale ? candB_H : candA_H;
    const cellW = (canvasW - (cols - 1) * gap) / cols;
    const cellH = (canvasH - (rows - 1) * gap) / rows;

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrls[0];
    ctx.imageSmoothingEnabled = true;
    (ctx as unknown as { imageSmoothingQuality?: string }).imageSmoothingQuality = 'high';
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    images.forEach((img, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * (cellW + gap);
      const y = row * (cellH + gap);
      ctx.fillStyle = background;
      ctx.fillRect(x, y, cellW, cellH);

      // Per-cell fitting:
      // - contain keeps everything visible
      // - cover fills cell but may crop (avoid unless explicitly requested)
      const scale = fit === 'cover'
        ? Math.max(cellW / img.width, cellH / img.height)
        : Math.min(cellW / img.width, cellH / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      const dx = x + (cellW - dw) / 2;
      const dy = y + (cellH - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
    });

    return canvas.toDataURL("image/jpeg", 0.82);
  };

  // Handle PDF generation/export (consolidated function)
  const handlePDFAction = async (action: 'generate' | 'export' = 'generate') => {
    if (!statementData) {
      showErrorToast('Please load a statement first');
      return null;
    }

    return executeMonthlyStatementPdfAction({
      action,
      statementData: statementData as unknown as Record<string, unknown> & { monthNumber?: string; year?: string },
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
    });
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

      // Use optimized export endpoint for faster CSV generation
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/export/${id}/${boardId}/monthly-statement-csv`;
      const response = await axios.get(apiUrl, {
        params: {
          participant: selectedParticipant,
          month: selectedMonth,
          year: selectedYear,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          type: 'budget'
        },
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const allItems: BudgetRecord[] = response.data?.items || [];
      const exportDuration = response.data?.exportDurationMs;

      if (allItems.length === 0) {
        showErrorToast('No budget items to export.');
        setExportingSection(null);
        return;
      }

      const items = allItems;

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
      const durationText = exportDuration ? ` (${(exportDuration / 1000).toFixed(1)}s)` : '';
      showSuccessToast(`Exported ${items.length} budget item${items.length === 1 ? '' : 's'} to CSV${durationText}.`);
    } catch (err: any) {
      console.error('Error exporting budget items:', err);
      showErrorToast('Budget CSV export failed', {
        description: getApiErrorMessage(
          err,
          'Unable to export budget items right now. Please try again.'
        ),
      });
    } finally {
      setExportingSection(null);
    }
  };

  // Export CSV for a specific budget category
  const handleBudgetCategoryExportCSV = async (categoryCode: string, categoryTitle: string) => {
    if (!statementData) {
      showErrorToast('Please load a statement before exporting.');
      return;
    }

    try {
      const exportState = `budget-${categoryCode}` as typeof exportingSection;
      setExportingSection(exportState);

      const matchingSection = categorizedBudgetSections.find((s) => s.categoryCode === categoryCode);
      const items = matchingSection?.items || [];

      if (items.length === 0) {
        showErrorToast('No budget items to export for this category.');
        setExportingSection(null);
        return;
      }

      const columns = getBudgetColumnsForCode(categoryCode);
      const rows = items.map((item) =>
        columns.map((column) => formatBudgetCellCsv(column, item))
      );

      const csvContent = [columns, ...rows]
        .map((row) => row.map(escapeForCsv).join(','))
        .join('\n');

      const participantSlug = sanitizeForFileName(statementData.participant || 'participant');
      const monthSlug = sanitizeForFileName(statementData.monthNumber || selectedMonth || '01');
      const categorySlug = sanitizeForFileName(categoryTitle || categoryCode);
      const filename = `Budget_${categorySlug}_${participantSlug}_${statementData.year}_${monthSlug}.csv`;
      downloadCsv(csvContent, filename);
      showSuccessToast(`Exported ${items.length} ${categoryTitle} item${items.length === 1 ? '' : 's'} to CSV.`);
    } catch (err: any) {
      console.error(`Error exporting budget items for ${categoryCode}:`, err);
      showErrorToast(`${categoryTitle} budget CSV export failed`, {
        description: getApiErrorMessage(
          err,
          `Unable to export ${categoryTitle} budget items right now. Please try again.`
        ),
      });
    } finally {
      setExportingSection(null);
    }
  };

  // Export CSV for Home Support Care Management Budget
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

      // Use optimized export endpoint for faster CSV generation
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/export/${id}/${boardId}/monthly-statement-csv`;
      const response = await axios.get(apiUrl, {
        params: {
          participant: selectedParticipant,
          month: selectedMonth,
          year: selectedYear,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          type: 'service',
          ...(serviceTransactionStatusFilter && serviceTransactionStatusFilter !== 'all' ? { serviceTransactionStatus: serviceTransactionStatusFilter } : {}),
          ...(serviceFundingSourceFilter && serviceFundingSourceFilter !== 'all' ? { serviceFundingSource: serviceFundingSourceFilter } : {}),
        },
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const allItems: ServiceRecord[] = response.data?.items || [];
      const exportDuration = response.data?.exportDurationMs;

      if (allItems.length === 0) {
        showErrorToast('No service records to export.');
        setExportingSection(null);
        return;
      }

      const items = allItems;

      const headers = [
        'Participant',
        'Service',
        'Service Provider',
        'Scheduled Service Date',
        'Service Delivery Date',
        'Transaction Status',
        'Committed AT-HM for Delivery',
        'Unit',
        'Quantity',
        'Unit Price ($)',
        'Total Amount ($)',
        'Gov Subsidy ($)',
        'Participant Contribution ($)',
        'Funding Source',
        'Notes'
      ];

      const rows = items.map((service) => [
        service.participant || service.participantName || '',
        service.service || service.taskName || '',
        service.serviceProvider || service.loanedByOrganisationName || '',
        formatDateForCsv(service.scheduledServiceDate || service.scheduledShiftStart),
        formatDateForCsv(service.serviceDeliveryDate || service.actualShiftEndDateTime),
        service.transactionStatus || '',
        service.committedAtHmForDelivery && service.committedAtHmForDelivery > 0 ? 'Yes' : 'No',
        service.unit || '',
        Number(service.quantity ?? 0).toFixed(2),
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
      const durationText = exportDuration ? ` (${(exportDuration / 1000).toFixed(1)}s)` : '';
      showSuccessToast(`Service records CSV exported successfully. ${items.length} record${items.length === 1 ? '' : 's'} exported${durationText}.`);
    } catch (err: any) {
      console.error('Error exporting service records:', err);
      showErrorToast('Service records CSV export failed', {
        description: getApiErrorMessage(
          err,
          'Unable to export service records right now. Please try again.'
        ),
      });
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
    // Clear previous errors
    setBusinessDetailsErrors([]);

    // Validation
    const errors: string[] = [];

    if (!businessDetails.companyName?.trim()) {
      errors.push('Company Name is required');
    }

    if (!businessDetails.companyRegistrationId?.trim()) {
      errors.push('Company Registration ID is required');
    }

    if (!businessDetails.phoneNumber?.trim()) {
      errors.push('Phone Number is required');
    }

    if (!businessDetails.businessEmail?.trim()) {
      errors.push('Business Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessDetails.businessEmail)) {
      errors.push('Business Email must be a valid email address');
    }

    // Validate postcode if provided (should be numeric and max 8 characters)
    if (businessDetails.postcode && businessDetails.postcode.trim()) {
      if (!/^\d{1,8}$/.test(businessDetails.postcode)) {
        errors.push('Postcode must be numeric and maximum 8 digits');
      }
    }

    if (errors.length > 0) {
      setBusinessDetailsErrors(errors);
      showErrorToast('Please correct the validation errors');
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
          country: businessDetails.country,
          suburb: businessDetails.suburb,
          state: businessDetails.state,
          postcode: businessDetails.postcode,
          companyRegistrationId: businessDetails.companyRegistrationId,
        }
      );
      setShowBusinessDialog(false);
      setBusinessDetailsErrors([]);
      showSuccessToast('Business details saved successfully');
    } catch (err: any) {
      console.error('Error saving business details:', err);
      if (err.response?.data?.errors) {
        setBusinessDetailsErrors(err.response.data.errors);
      } else if (err.response?.data?.message) {
        showErrorToast(err.response.data.message);
      } else {
        showErrorToast('Failed to save business details. Please try again.');
      }
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
      if (typeof dateString === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(dateString.trim())) {
        return dateString.trim();
      }
      return formatDateDDMMYYYY(dateString, businessTimezone) || 'N/A';
    } catch (e) {
      return 'N/A';
    }
  };

  const getBudgetColumnsForCode = (code?: string) =>
    BUDGET_TABLE_COLUMNS[code || 'HSQ'] || BUDGET_TABLE_COLUMNS.HSQ;

  // Determine budget category code from item data or folder name
  const resolveBudgetCategoryCode = useCallback((folderName: string, items: BudgetRecord[]): string => {
    const itemCode = items[0]?.categoryCode;
    if (itemCode && (CATEGORY_ORDER as readonly string[]).includes(itemCode)) return itemCode;
    const fn = (folderName || '').toLowerCase();
    if (fn.includes('care management')) return 'HSCM';
    if (fn.includes('restorative')) return 'RCP';
    if (fn.includes('end-of-life') || fn.includes('end of life')) return 'EOL';
    if (fn.includes('short-term') || fn.includes('short term')) return 'ATS';
    if (fn.includes('ongoing')) return 'ATO';
    if (fn.includes('home modification')) return 'HMB';
    return 'HSQ';
  }, []);

  // Pre-compute categorized budget items grouped by category code
  const categorizedBudgetSections = useMemo(() => {
    const groupedByCode = new Map<string, { folderName: string; items: BudgetRecord[] }>();

    // Group all budget items by their resolved category code
    Object.entries(budgetItems).forEach(([folderName, items]) => {
      const code = resolveBudgetCategoryCode(folderName, items);
      const existing = groupedByCode.get(code);
      if (existing) {
        existing.items.push(...items);
      } else {
        groupedByCode.set(code, { folderName, items: [...items] });
      }
    });

    // Build the ordered sections array
    return CATEGORY_ORDER.map((code) => {
      const group = groupedByCode.get(code);
      return {
        categoryCode: code,
        sectionTitle: group?.folderName || BUDGET_CATEGORY_LABELS[code] || 'Budget',
        items: group?.items || [],
        columns: getBudgetColumnsForCode(code),
      };
    });
  }, [budgetItems, resolveBudgetCategoryCode]);

  const isCurrencyColumn = (label: string) => label.includes('($');
  const isHourColumn = (label: string) => label.includes('(Hr.)');
  const isDateColumn = (label: string) => label.toLowerCase().includes('date');

  const parseBudgetNumber = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    if (Array.isArray(value) && value.length > 0) {
      return parseBudgetNumber(value[0]);
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === 'string') {
      const normalized = value.replace(/[^0-9.\-]/g, '');
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };

  const normalizeBudgetValue = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeBudgetValue(entry)).filter((entry) => Boolean(entry)).join(', ');
    }
    if (typeof value === 'object') {
      const maybeName = (value as { name?: string }).name;
      if (maybeName) return String(maybeName);
      const maybeId = (value as { id?: string }).id;
      if (maybeId) return String(maybeId);
      return value.toString ? value.toString() : '';
    }
    return String(value);
  };

  const looksLikeId = (value: unknown) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

  const isIdArray = (value: unknown) =>
    Array.isArray(value) && value.some((entry) => looksLikeId(entry));

  const getBudgetRawValue = (item: BudgetRecord, columnLabel: string) => {
    const rawData = item.rawData || {};
    const aliases = BUDGET_COLUMN_ALIASES[columnLabel] || [columnLabel];
    for (const key of aliases) {
      const value = (rawData as Record<string, unknown>)[key];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
    return undefined;
  };

  const getBudgetFallbackValue = (item: BudgetRecord, columnLabel: string) => {
    switch (columnLabel) {
      case 'Funding Stream':
        return item.folderName || '';
      case 'Participant Profile':
      case 'Associated Participant':
        return item.participantName || '';
      case 'Month':
        return item.month || '';
      case 'Year':
        return item.year || '';
      case 'FY Quarter':
        return item.quarter || '';
      case 'Funding Start Date':
        return item.fundingStartDate || '';
      case 'Funding End Date':
        return item.fundingEndDate || '';
      case 'Fund':
        return item.fund || '';
      case 'Fund Classification':
        return item.fundClassification || '';
      case 'Fund Amount ($)':
        return item.fundAmount ?? 0;
      case 'Quarterly Budget ($)':
        return 0;
      case 'Available Fund at the Start of the Month ($)':
        return item.availableFundStart ?? 0;
      case 'Classification Quarterly Budget Adjustment ($)':
        return item.quarterlyAdjustment ?? 0;
      case 'Primary Supplement ($)':
        return item.primarySupplementAmount ?? 0;
      case 'Carryover Funding from the Previous Quarter ($)':
        return item.carryoverFunding ?? 0;
      case 'Unspent Budget at the End of the Quarter-Returned ($-)':
        return item.unspentReturned ?? 0;
      case 'Unspent HCP Funds Commonwealth Portion (Provider-held) ($)':
        return item.commonwealthUnspent ?? 0;
      case 'Commonwealth-held HCP Unspent Funds (Notional Home Care Account) ($)':
        return item.providerUnspent ?? 0;
      case 'Unspent HCP Funds-Participant Portion (Provider-held) ($)':
        return item.participantUnspent ?? 0;
      case 'Spending from Previous Month(s) within same Quarter ($)':
      case 'Spending from Previous Month(s) within Allocated Period ($)':
        return item.previousMonthSpending ?? 0;
      case 'Total Available Budget for Home Support ($)':
      case 'Total Available Fund for AT - Short-term ($)':
      case 'Total Available Fund for AT Ongoing ($)':
      case 'Total Available Fund for HM ($)':
      case 'Total Available Budget for Restorative Care ($)':
      case 'Total Available Budget for End-of-Life Care ($)':
        return item.totalAvailableBudget ?? 0;
      case 'Home Support Delivered During the Month ($-)':
      case 'AT - Short-term Delivered During the Month ($-)':
      case 'AT - Ongoing Delivered During the Month ($-)':
      case 'Home Modification Delivered During the Month ($-)':
      case 'Restorative Care Delivered During the Month ($-)':
      case 'End-of-Life Care Delivered During the Month ($-)':
        return item.deliveredAmountRaw ?? item.deliveredAmount ?? 0;
      case 'Adjustments from Previous Months [Charges($-)/Refund($)]':
        return item.adjustmentAmount ?? 0;
      case 'Remaining Home Support Balance as at the End of the Month ($)':
      case 'Remaining AT - Short-term Balance as at the End of the Month ($)':
      case 'Remaining AT - Ongoing Balance as at the End of the Month ($)':
      case 'Remaining HM Balance as at the End of the Month ($)':
      case 'Remaining Restorative Care Balance as at the End of the Month ($)':
      case 'Remaining End-of-Life Care Balance as at the End of the Month ($)':
        return item.remainingBalanceEndOfMonth ?? item.remainingBalance ?? 0;
      case 'Remaining AT - Short-term Balance for Allocation Period ($)':
      case 'Remaining AT - Ongoing Balance for Allocation Period ($)':
      case 'Remaining HM Balance for Allocation Period ($)':
        return item.remainingBalanceAllocationPeriod ?? item.remainingBalance ?? 0;
      case 'Committed AT Short-term Funds - to be delivered ($-)':
      case 'Committed AT Ongoing Funds - to be delivered ($-)':
      case 'Committed HM Funds - to be delivered ($-)':
        return item.committedFunds ?? 0;
      case 'Date':
        return item.hscmDate || '';
      case 'Transaction Type':
        return item.hscmTransactionType || '';
      case 'Received Amount ($)':
        return item.hscmReceivedAmount ?? 0;
      case 'Allocated Time (Hr.)':
        return item.hscmAllocatedTime ?? 0;
      case 'Allocated Amount ($-)':
        return item.hscmAllocatedAmount ?? 0;
      case 'Net Movement ($)':
        return item.hscmCurrentBalance ?? item.remainingBalance ?? 0;
      default:
        return '';
    }
  };

  const getBudgetCellValue = (item: BudgetRecord, columnLabel: string) => {
    const rawValue = getBudgetRawValue(item, columnLabel);
    if (rawValue !== undefined) {
      if (columnLabel === 'Funding Stream' && (looksLikeId(rawValue) || isIdArray(rawValue))) {
        return item.folderName || '';
      }
      if (columnLabel === 'Participant Profile' && (looksLikeId(rawValue) || isIdArray(rawValue))) {
        return item.participantName || '';
      }
      if (columnLabel === 'Associated Participant' && (looksLikeId(rawValue) || isIdArray(rawValue))) {
        return item.participantName || '';
      }
      if (columnLabel === 'Primary Supplement' && (looksLikeId(rawValue) || isIdArray(rawValue))) {
        return item.primarySupplementLabel || '';
      }
      return rawValue;
    }
    return getBudgetFallbackValue(item, columnLabel);
  };

  const formatBudgetCellDisplay = (columnLabel: string, item: BudgetRecord) => {
    const rawValue = getBudgetCellValue(item, columnLabel);
    if (isDateColumn(columnLabel)) {
      return formatDate(normalizeBudgetValue(rawValue));
    }
    if (isHourColumn(columnLabel)) {
      return parseBudgetNumber(rawValue).toFixed(2);
    }
    if (isCurrencyColumn(columnLabel)) {
      return formatCurrency(parseBudgetNumber(rawValue));
    }
    const normalized = normalizeBudgetValue(rawValue);
    return normalized || 'N/A';
  };

  const formatBudgetCellCsv = (columnLabel: string, item: BudgetRecord) => {
    const rawValue = getBudgetCellValue(item, columnLabel);
    if (isDateColumn(columnLabel)) {
      return formatDateForCsv(normalizeBudgetValue(rawValue));
    }
    if (isHourColumn(columnLabel) || isCurrencyColumn(columnLabel)) {
      return parseBudgetNumber(rawValue).toFixed(2);
    }
    return normalizeBudgetValue(rawValue);
  };

  // Sanitize HTML for safe display in Notes (allow common inline/block tags, strip scripts and event handlers)
  const sanitizeNotesHtml = (html: string): string => {
    if (!html || typeof html !== 'string') return '';
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/\s*on\w+\s*=\s*[^\s>]*/gi, '');
  };

  const getServiceProviderLabel = (service: ServiceRecord) => {
    const candidates = [
      service.serviceProvider,
      service.loanedByOrganisationName
    ];
    const first = candidates.find((value) => typeof value === 'string' && value.trim() !== '');
    const looksLikeUuid =
      typeof first === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(first.trim());
    if (first && !looksLikeUuid) {
      return first;
    }
    if (service.deliveredBy && service.deliveredBy.trim() !== '') {
      return service.deliveredBy;
    }
    if (first) {
      return first;
    }
    return 'N/A';
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

  const chartConfigs = useMemo(() => {
    if (!statementData?.budgetCategories?.length) {
      return [];
    }

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

    const localMonths = [
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

    const charts: ChartCardConfig[] = [];
    const categoryLookup = new Map<string, BudgetCategory>();
    statementData.budgetCategories.forEach((cat) => {
      categoryLookup.set(cat.code, cat);
    });

    const normalizedMonthNumber = statementData.monthNumber?.padStart(2, '0') || '01';
    const monthIndex = localMonths.findIndex((monthOption) => monthOption.value === normalizedMonthNumber);
    const nextMonthLabel = monthIndex >= 0
      ? localMonths[(monthIndex + 1) % localMonths.length].label
      : statementData.month;
    const selectedMonthLabel = statementData.month || localMonths[monthIndex]?.label || 'Selected month';
    const selectedMonthTickLabel = `${selectedMonthLabel}\nexpenditure`;

    // Helper function to calculate expenditure as Delivered Amount + Adjustment Amount
    const calculateExpenditure = (
      category?: BudgetCategory,
      options: { signed?: boolean } = {}
    ) => {
      if (!category) return 0;
      const delivered = options.signed
        ? toNumber(
          category.serviceDeliveredAmountRaw ??
            category.serviceDeliveredAmount ??
            category.deliveredAmount ??
            0
        )
        : positive(category.serviceDeliveredAmount ?? category.deliveredAmount ?? 0);
      const adjustment = options.signed
        ? toNumber(category.adjustmentAmount ?? 0)
        : positive(category.adjustmentAmount ?? 0);
      return Math.abs(delivered + adjustment);
    };

    // Helper function to get previous spending value
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

    // When last month of quarter is selected, Blue bar shows next quarter's range (e.g. April - June).
    const getNextQuarterRange = () => {
      const monthNum = parseInt(normalizedMonthNumber, 10) || 1;
      if (monthNum <= 3) return { start: 'April', end: 'June' };
      if (monthNum <= 6) return { start: 'July', end: 'September' };
      if (monthNum <= 9) return { start: 'October', end: 'December' };
      return { start: 'January', end: 'March' };
    };

    const defaultQuarterRange = getQuarterRange();

    // 1st Chart: Home Support Quarterly Budget (HSQ)
    const homeSupport = categoryLookup.get('HSQ') ?? ({ code: 'HSQ' } as BudgetCategory);
    {
      // Available fund = Available Fund at Start of Month + Classification Quarterly Budget Adjustment (per spec)
      const available = positive(
        toNumber(homeSupport.availableFundStart) + toNumber(homeSupport.quarterlyAdjustment)
      );
      const expenditure = calculateExpenditure(homeSupport, { signed: true });
      const remaining = positive(homeSupport.remainingBudget);
      const quarterStart = homeSupport.quarterStartMonth ?? defaultQuarterRange.start;
      const quarterEnd = homeSupport.quarterEndMonth ?? defaultQuarterRange.end;
      const selectedMonthNum = parseInt(normalizedMonthNumber, 10) || 1;
      const isLastMonthOfQuarter = [3, 6, 9, 12].includes(selectedMonthNum);
      // Blue bar label: when last month of quarter, show next quarter range (e.g. "April - June"); otherwise "W - Y" where W is month after selected, Y is quarter end
      const balanceLabel = isLastMonthOfQuarter
        ? (() => {
            const nextQ = getNextQuarterRange();
            return `${nextQ.start} - ${nextQ.end}`;
          })()
        : quarterEnd
          ? (nextMonthLabel === quarterEnd ? 'Next quarter' : `${nextMonthLabel} - ${quarterEnd}`)
          : nextMonthLabel;
      const hsqBalanceLabel = `Available balance ${balanceLabel}`;

      pushChartConfig({
        code: 'HSQ',
        subtitle: 'Quarterly Budget',
        title: `Home Support Quarterly Budget ${quarterStart} - ${quarterEnd} ${statementData.year}`,
        data: [
          {
            name: 'hsq-expenditure',
            label: `${selectedMonthLabel} expenditure`,
            shortLabel: selectedMonthTickLabel,
            value: expenditure,
            color: '#dc2626' // Red
          },
          {
            name: 'hsq-balance',
            label: hsqBalanceLabel,
            shortLabel: `Available\nbalance\n${balanceLabel}`,
            value: remaining,
            color: '#2563eb' // Blue
          }
        ],
        metrics: [
          { label: 'Available funds', value: available },
          { label: 'Remaining budget', value: remaining },
        ]
      });
    }

    // 2nd, 3rd, 4th Charts: Assistive Technology & Home Modification
    const addAssistiveOrModificationChart = (code: 'ATS' | 'ATO' | 'HMB', title: string) => {
      const category = categoryLookup.get(code) ?? ({ code } as BudgetCategory);
      const available = positive(category.availableFunds);
      const isAssistive = code === 'ATS' || code === 'ATO';
      const isHomeModification = code === 'HMB';
      const expenditure = calculateExpenditure(category, { signed: isAssistive || isHomeModification });
      // Blue bar: ATS/ATO use Remaining ... Balance for Allocation Period ($) per spec
      const remaining = positive(
        category.remainingBalanceAllocationPeriod ??
          category.remainingBalanceEndOfMonth ??
          category.remainingBudget
      );
      const committed = Math.abs(toNumber(category.committedFunds ?? 0));
      const committedLabel =
        code === 'ATS'
          ? 'Committed AT Short-term Funds'
          : code === 'ATO'
            ? 'Committed AT Ongoing Funds'
            : 'Committed HM Funds';
      const committedShortLabel =
        code === 'ATS'
          ? 'Committed\nShort-term'
          : code === 'ATO'
            ? 'Committed\nOngoing'
            : 'Committed\nFunds';
      // Date A = Funding End Date for selected month/year; show N/A when not available (dynamic per selection)
      const fundingEndDisplay = category.fundingEndDate != null && String(category.fundingEndDate).trim() !== ''
        ? formatDate(category.fundingEndDate)
        : 'N/A';
      const remainingLabel = `Remaining budget ${fundingEndDisplay}`;
      const remainingShortLabel = `Remaining\nbudget\n${fundingEndDisplay}`;
      const subtitle = isAssistive
        ? 'Assistive Technology'
        : isHomeModification
          ? 'Home Modification'
          : title;
      const chartTitle = isAssistive || isHomeModification ? title : `${title} (${statementData.year})`;

      pushChartConfig({
        code,
        subtitle,
        title: chartTitle,
        data: [
          {
            name: `${code}-expenditure`,
            label: `${selectedMonthLabel} expenditure`,
            shortLabel: selectedMonthTickLabel,
            value: expenditure,
            color: '#dc2626' // Red
          },
          {
            name: `${code}-committed`,
            label: committedLabel,
            shortLabel: committedShortLabel,
            value: committed,
            color: '#16a34a' // Green
          },
          {
            name: `${code}-balance`,
            label: remainingLabel,
            shortLabel: remainingShortLabel,
            value: remaining,
            color: '#2563eb' // Blue
          }
        ],
        metrics: [
          { label: 'Available funds', value: available },
          { label: 'Remaining budget', value: remaining },
          { label: 'Committed funds', value: committed },
        ]
      });
    };

    addAssistiveOrModificationChart('ATS', 'Assistive Technology - Short-term Budget');
    addAssistiveOrModificationChart('ATO', 'Assistive Technology - Ongoing Budget');
    addAssistiveOrModificationChart('HMB', 'Home Modification Budget');

    // 5th, 6th Charts: Restorative Care & End-of-Life (per spec: Purple = Spending from previous months, Red = expenditure, Blue = Total Available Budget)
    const addRestorativeChart = (code: 'RCP' | 'EOL', title: string) => {
      const category = categoryLookup.get(code) ?? ({ code } as BudgetCategory);
      // Purple: Spending from previous month(s) = Fund Amount ($) - Available Fund at the Start of the Month ($)
      const previousSpending = getPreviousSpendingValue(category);
      const available = positive(category.availableFunds);
      // Blue bar per spec: value = Total Available Budget for Restorative Care ($) / End-of-Life Care ($)
      const totalAvailable = positive(category.totalAvailableBudget ?? category.availableFunds ?? 0);
      // Red: [Month] expenditure = Service Delivered During the Month ($-) + Adjustments from Previous Months (signed then abs)
      const expenditure = calculateExpenditure(category, { signed: true });
      const remaining = positive(category.remainingBudget);

      const fundingEndDisplay =
        category.fundingEndDate != null && String(category.fundingEndDate).trim() !== ''
          ? formatDate(category.fundingEndDate)
          : 'N/A';

      const blueBarLabel = `Remaining budget ${fundingEndDisplay}`;
      const blueBarShortLabel = `Remaining\nbudget\n${fundingEndDisplay}`;
      const blueBarValueForChart = remaining;

      pushChartConfig({
        code,
        subtitle: title,
        title: `${title} (${statementData.year})`,
        data: [
          {
            name: `${code}-previous`,
            label: 'Spending from previous months',
            shortLabel: 'Previous\nspending',
            value: previousSpending,
            color: '#7c3aed' // Purple
          },
          {
            name: `${code}-expenditure`,
            label: `${selectedMonthLabel} expenditure`,
            shortLabel: selectedMonthTickLabel,
            value: expenditure,
            color: '#dc2626' // Red
          },
          {
            name: `${code}-balance`,
            label: blueBarLabel,
            shortLabel: blueBarShortLabel,
            value: blueBarValueForChart,
            color: '#2563eb' // Blue - Total Available Budget for the funding stream
          }
        ],
        metrics: [
          { label: code === 'EOL' ? 'Total Available Budget for End-of-Life Care ($)' : 'Total Available Budget for Restorative Care ($)', value: totalAvailable },
          { label: 'Previous spending', value: previousSpending },
          { label: 'Remaining balance', value: remaining },
        ]
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

  // X-axis tick: wrap into short lines so each label stays in its bar slot (no overlap) and full text is visible (no clip)
  const ChartXAxisTick = ({
    x,
    y,
    width,
    payload,
  }: {
    x?: number;
    y?: number;
    width?: number;
    payload?: { value?: string };
  }) => {
    const raw = String(payload?.value ?? '');
    const tickFontSize = 14;
    const tickLineHeight = tickFontSize + 2;
    const availableWidth = typeof width === 'number' && width > 0 ? width : 84;
    const approxCharWidth = tickFontSize * 0.56;
    const maxCharsPerLine = Math.max(8, Math.floor((availableWidth - 6) / approxCharWidth));
    const maxLines = 4;
    const clampedLines = wrapChartTickLabel(raw, maxCharsPerLine, maxLines);

    const startY = (y ?? 0) + 6;

    return (
      <text
        x={x}
        y={startY}
        textAnchor="middle"
        dominantBaseline="hanging"
        fill="hsl(var(--muted-foreground))"
        style={{
          overflow: 'visible',
          fontSize: tickFontSize,
          fontWeight: 400,
        }}
      >
        {clampedLines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? 0 : tickLineHeight}>
            {line}
          </tspan>
        ))}
      </text>
    );
  };

  const ChartBarValueLabel = ({
    x,
    y,
    width: barWidth,
    height: barHeight,
    value,
  }: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    value?: number;
  }) => {
    if (x == null || y == null || barWidth == null || barHeight == null || value == null) return null;
    const label = Number.isFinite(value) ? formatCurrency(value) : '';
    if (!label) return null;

    const cx = x + barWidth / 2;
    const valueFontSize = 22;
    // Always draw value just above the bar top.
    const cy = Math.max(valueFontSize + 2, y - 10);

    return (
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="hsl(var(--foreground))"
        style={{ fontSize: valueFontSize, fontWeight: 400 }}
      >
        {label}
      </text>
    );
  };

  const monthlyStatementViewProps = {
    router, id, boardId, isPrintMode, loadingParticipants, uniqueParticipants, selectedParticipant, setSelectedParticipant,
    months, selectedMonth, setSelectedMonth, years, selectedYear, setSelectedYear,
    handleManualSync, isManualSyncing, syncStatuses, setShowHelpDialog,
    fetchStatementData, loading, exportingSection, statementData, businessDetails,
    chartConfigs, chartCardRefs, chartContainerRef, formatCurrency, formatDate,
    getQuarterMonths, visibleBudgetCategories, categorizedBudgetSections, loadingServiceItems,
    handleBudgetCategoryExportCSV, isCurrencyColumn, isHourColumn, formatBudgetCellDisplay,
    serviceTransactionStatusFilter, setServiceTransactionStatusFilter, fetchServiceItems,
    servicePagination, serviceSortBy, serviceSortOrder, serviceFundingSourceFilter,
    setServiceFundingSourceFilter, distinctTransactionStatuses, distinctFundingSources,
    handleServiceExportCSV, handleServicePageChange, serviceItems, getTransactionStatusBadgeVariant,
    getServiceProviderLabel, sanitizeNotesHtml, handlePDFAction, handleBudgetExportCSV,
    handleSaHMonthlyStatement, showHelpDialog, showBusinessDialog, setShowBusinessDialog,
    businessDetailsErrors, setBusinessDetails, handleSaveBusinessDetails, countryStates,
    ChartXAxisTick, ChartBarValueLabel, serviceTotalPages, setServiceSortBy, setServiceSortOrder,
  };

  return <MonthlyStatementPageView {...monthlyStatementViewProps} />;
}
