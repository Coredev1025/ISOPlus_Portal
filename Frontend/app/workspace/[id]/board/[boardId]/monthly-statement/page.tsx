"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Calendar, User, FileText, AlertCircle, FileCheck, FileSpreadsheet, ArrowUpDown, ArrowUp, ArrowDown, HelpCircle, Download } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect, useMemo, useRef, useCallback, forwardRef, type ReactElement } from "react";
import { toPng } from "html-to-image";
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
import { format, startOfMonth, endOfMonth, isValid, parse } from "date-fns";
import Spinner from "@/components/ui/spin";
import { showSuccessToast, showErrorToast, showInfoToast, showWarningToast } from "@/lib/toast-utils";
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
    averageServiceCost: number;
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

const PdfChartFrame = forwardRef<
  HTMLDivElement,
  {
    chart: ChartCardConfig;
    width: number;
    height: number;
    chartId: string;
    xAxisTick: ReactElement;
    formatAxisCurrency: (value: number) => string;
    formatCurrency: (amount?: number | null) => string;
  }
>(({ chart, width, height, chartId, xAxisTick, formatAxisCurrency, formatCurrency }, ref) => {
  const padding = 20;
  const gap = 12;
  const titleHeight = 24;
  const chartWidth = Math.max(0, Math.floor(width - padding * 2));
  const chartHeight = Math.max(0, Math.floor(height - padding * 2 - titleHeight - gap));
  
  const leftMargin = Math.max(10, Math.floor(chartWidth * 0.08));
  const rightMargin = Math.max(10, Math.floor(chartWidth * 0.02));
  const topMargin = 34;
  const bottomMargin = Math.min(150, Math.max(95, Math.floor(chartHeight * 0.28)));
  
  const numBars = chart.data.length;
  const barGapPercentage = numBars <= 2 ? "30%" : numBars === 3 ? "22%" : "18%";
  
  const availableWidth = chartWidth - leftMargin - rightMargin;
  const maxBarSize = Math.min(80, Math.floor(availableWidth / (numBars * 2)));

  const PdfChartYAxisTick = ({ x, y, payload }: { x?: number; y?: number; payload?: { value?: number | string } }) => {
    const raw = payload?.value;
    const asNumber = typeof raw === 'number' ? raw : Number(raw ?? 0);
    return (
      <text x={x} y={y} textAnchor="end" fill="currentColor" className="text-[14px] leading-tight" dy={4}>
        {formatAxisCurrency(asNumber)}
      </text>
    );
  };

  return (
    <div
      ref={ref}
      data-chart={chartId}
      className="text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none"
      style={{
        width: `${width}px`,
        height: `${height}px`,
        background: 'white',
        borderRadius: '8px',
        boxSizing: 'border-box',
        padding: `${padding}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: `${gap}px`,
        overflow: 'hidden',
      }}
    >
      <ChartStyle id={chartId} config={chart.chartConfig} />
      <div style={{ height: `${titleHeight}px`, fontSize: 16, fontWeight: 600, lineHeight: 1.2 }}>
        {chart.title}
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <BarChart
          width={chartWidth}
          height={chartHeight}
          data={chart.data}
          margin={{ left: leftMargin, right: rightMargin, top: topMargin, bottom: bottomMargin }}
          barCategoryGap={barGapPercentage}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="shortLabel"
            axisLine={false}
            tickLine={false}
            interval={0}
            height={bottomMargin - 10}
            tick={xAxisTick}
            allowDataOverflow={false}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            width={leftMargin - 5}
            tick={<PdfChartYAxisTick />}
          />
          <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={maxBarSize} isAnimationActive={false}>
            <LabelList
              dataKey="value"
              position="top"
              formatter={(value: number) => (Number.isFinite(value) ? formatCurrency(value) : '')}
              className="fill-muted-foreground text-[12px] font-semibold"
            />
            {chart.data.map((entry) => (
              <Cell key={`pdf-${chart.code}-${entry.name}`} fill={`var(--color-${entry.name})`} />
            ))}
          </Bar>
        </BarChart>
      </div>
    </div>
  );
});
PdfChartFrame.displayName = 'PdfChartFrame';

const BUDGET_CATEGORY_LABELS: Record<string, string> = {
  HSQ: 'Home Support Quarterly Budget',
  HSCM: 'Home Support Care Management Budget',
  RCP: 'Restorative Care Pathway Budget',
  EOL: 'End-of-Life Pathway Budget',
  ATS: 'Assistive Technology - Short-term Budget',
  ATO: 'Assistive Technology - Ongoing Budget',
  HMB: 'Home Modification Budget',
};

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
    'Current Balance ($)'
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
  type PdfChartCaptureRequest = {
    width: number;
    height: number;
    indices: number[]; // chart indices (into chartConfigs) in capture order
  } | null;
  const [pdfChartCaptureRequest, setPdfChartCaptureRequest] = useState<PdfChartCaptureRequest>(null);
  const pdfChartCaptureRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isPdfChartCaptureMode = pdfChartCaptureRequest !== null;
  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const syncCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const previousSyncStatusRef = useRef<{ boardId: string; status: string; startTime?: number; seenInContext?: boolean } | null>(null);


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

  // Fetch unique participants using dedicated endpoint
  useEffect(() => {
    const fetchParticipants = async () => {
      if (!id || !boardId) return;

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
            country: response.data.address?.country || "",
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

  const fetchServiceItems = async (page: number = 1, limit: number = servicePagination.limit, sortBy?: 'scheduledServiceDate' | 'serviceDeliveryDate' | '', sortOrder?: 'asc' | 'desc', transactionStatus?: string, fundingSource?: string) => {
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
      const previousSync = previousSyncStatusRef.current;
      const wasActive = previousSync &&
        previousSync.boardId === boardId &&
        (previousSync.status === 'started' || previousSync.status === 'in-progress');

      if (!wasActive) {
        return;
      }

      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/sync/workspace/status/${id}`
      );

      if (response.data && response.data.boards) {
        const board = response.data.boards.find((b: any) => b.boardId === boardId);

        if (board) {
          const isManualSync = board.jobStatus &&
            (board.jobStatus.state === 'active' || board.jobStatus.state === 'waiting' || board.jobStatus.state === 'failed');

          const isFailed = (board.syncExecution && (board.syncExecution.status === 'failed' || board.syncExecution.status === 'timeout')) ||
            (board.jobStatus && board.jobStatus.state === 'failed');

          const isActive = (board.syncExecution && (board.syncExecution.status === 'started' || board.syncExecution.status === 'in-progress')) ||
            (board.jobStatus && (board.jobStatus.state === 'active' || board.jobStatus.state === 'waiting'));

          const isCompleted = !isActive && !isFailed && wasActive;

          if (isManualSync) {
            const jobProgress = board.jobStatus?.progress || {};
            const syncStats = board.syncStats || {};

            const foldersProcessed = jobProgress.foldersProcessed ?? syncStats.foldersProcessed ?? 0;
            const totalFolders = jobProgress.totalFolders ?? 0;
            const currentFolder = jobProgress.currentFolder || null;
            const itemsProcessed = jobProgress.itemsProcessed ?? syncStats.itemsSynced ?? 0;

            const updatedSyncStatus = {
              boardId: board.boardId,
              boardName: board.boardName || board.boardId,
              status: board.jobStatus.state === 'active' ? 'in-progress' as const :
                board.jobStatus.state === 'failed' ? 'failed' as const : 'started' as const,
              syncType: board.syncStatus || 'manual_triggered_sync',
              startTime: board.jobStatus.processedOn
                ? new Date(board.jobStatus.processedOn).toISOString()
                : previousSync?.startTime ? new Date(previousSync.startTime).toISOString() : new Date().toISOString(),
              progress: {
                foldersProcessed,
                totalFolders,
                currentFolder,
                itemsProcessed
              },
              isManualSync: true,
              error: isFailed ? {
                message: board.jobStatus?.failedReason || board.lastSyncError || 'Sync failed with unknown error',
                stack: null,
                details: null
              } : null
            };

            setSyncStatuses(prev => {
              const existingIndex = prev.findIndex(s => s.boardId === boardId);
              if (existingIndex >= 0) {
                const updated = [...prev];
                updated[existingIndex] = updatedSyncStatus;
                return updated;
              } else {
                return [...prev, updatedSyncStatus];
              }
            });

            previousSyncStatusRef.current = {
              boardId: board.boardId,
              status: updatedSyncStatus.status,
              startTime: previousSync?.startTime || Date.now()
            };
          }

          if (isFailed && wasActive) {
            const errorMessage = board.jobStatus?.failedReason ||
              board.lastSyncError ||
              board.syncExecution?.error?.message ||
              'The sync job encountered an error. Please try again.';

            showErrorToast('Sync job failed', {
              description: errorMessage
            });

            stopSyncChecking();
          } else if (isCompleted) {
            showSuccessToast('Sync completed', {
              description: 'The sync job has finished successfully.'
            });

            setSyncStatuses(prev => prev.filter(s => s.boardId !== boardId));

            stopSyncChecking();
          }
        } else {
          const timeSinceStart = previousSync?.startTime ? Date.now() - previousSync.startTime : 0;

          if (timeSinceStart > 15000 && wasActive) {
            showSuccessToast('Sync completed', {
              description: 'The sync job has finished successfully.'
            });

            setSyncStatuses(prev => prev.filter(s => s.boardId !== boardId));

            stopSyncChecking();
          }
        }
      }
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
    const isValidWorkspaceId = id &&
      typeof id === 'string' &&
      id.trim() !== '' &&
      id !== 'undefined' &&
      id !== 'null';

    const isValidBoardId = boardId &&
      typeof boardId === 'string' &&
      boardId.trim() !== '' &&
      boardId !== 'undefined' &&
      boardId !== 'null';

    if (!isValidWorkspaceId || !isValidBoardId) {
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

        let boardName = boardId;
        try {
          const currentBoardData = sessionStorage.getItem('currentBoard');
          if (currentBoardData) {
            const boardData = JSON.parse(currentBoardData);
            boardName = boardData.boardName || boardId;
          }
        } catch (e) {
          // Use boardId as fallback
        }

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
    setServiceTransactionStatusFilter('all');
    setServiceFundingSourceFilter('all');
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
            serviceLimit: servicePagination.limit,
            ...(serviceSortBy ? { serviceSortBy, serviceSortOrder: serviceSortOrder || 'asc' } : {}),
            ...(serviceTransactionStatusFilter && serviceTransactionStatusFilter !== 'all' ? { serviceTransactionStatus: serviceTransactionStatusFilter } : {}),
            ...(serviceFundingSourceFilter && serviceFundingSourceFilter !== 'all' ? { serviceFundingSource: serviceFundingSourceFilter } : {}),
          },
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      const data = response.data;

      // Handle budget items
      let allBudgetItemsFlat: BudgetRecord[] = [];
      if (data?.budgetItems?.items) {
        const groupedItems = Object.entries(data.budgetItems.items).reduce(
          (acc, [folderName, group]) => {
            const groupItems = Array.isArray((group as any)?.items) ? (group as any).items : [];
            if (groupItems.length > 0) {
              acc[folderName] = groupItems as BudgetRecord[];
            }
            return acc;
          },
          {} as Record<string, BudgetRecord[]>
        );
        setBudgetItems(groupedItems);
        allBudgetItemsFlat = Object.values(groupedItems).flat();
        setBudgetPagination({
          page: data.budgetItems.page || budgetPagination.page,
          limit: data.budgetItems.limit || budgetPagination.limit,
          total: data.budgetItems.total || 0
        });
      } else {
        setBudgetItems({});
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
        setDistinctTransactionStatuses(Array.isArray(data.serviceItems.distinctTransactionStatuses) ? data.serviceItems.distinctTransactionStatuses : []);
        setDistinctFundingSources(Array.isArray(data.serviceItems.distinctFundingSources) ? data.serviceItems.distinctFundingSources : []);
      } else {
        setServiceItems([]);
        setServicePagination({ page: 1, limit: 10, total: 0 });
        setDistinctTransactionStatuses([]);
        setDistinctFundingSources([]);
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
        budgetItems: allBudgetItemsFlat,
        serviceItems: services,
        summary,
        participantAddress: data?.participantAddress ?? '',
        participantSuburb: data?.participantSuburb ?? '',
        participantState: data?.participantState ?? '',
        participantPostcode: data?.participantPostcode ?? '',
        myAgedCareIdNumber: data?.myAgedCareIdNumber ?? '',
        providerId: providerIdValue,
        fundingSources: data.fundingSources, // Set fundingSources dynamically
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

  const getPdfChartCellSize = (cols: number) => {
    if (cols === 3) return { width: 500, height: 600 };
    return { width: 800, height: 600 };
  };

  // Composite separate chart images into one image (cols per row) for PDF export.
  const compositeChartImages = async (
    dataUrls: string[],
    cols: number,
    cellSize?: { width: number; height: number }
  ): Promise<string> => {
    if (dataUrls.length === 0) return '';
    const gap = 16;
    const loadImage = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    const images = await Promise.all(dataUrls.map(loadImage));
    const w = cellSize?.width ?? Math.max(...images.map((img) => img.width));
    const h = cellSize?.height ?? Math.max(...images.map((img) => img.height));
    const rows = Math.ceil(images.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = cols * w + (cols - 1) * gap;
    canvas.height = rows * h + (rows - 1) * gap;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrls[0];
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    images.forEach((img, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * (w + gap);
      const y = row * (h + gap);
      ctx.fillStyle = "white";
      ctx.fillRect(x, y, w, h);
      ctx.drawImage(img, x, y, w, h);
    });
    return canvas.toDataURL("image/png");
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
      const dateRange = getSelectedMonthDateRange();
      if (!dateRange) {
        showErrorToast('Please choose a valid month and year before generating PDF.');
        return null;
      }

      // Use optimized export endpoints to fetch all data in parallel
      const exportBaseUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/export/${id}/${boardId}/monthly-statement-csv`;

      const [budgetResponse, serviceResponse] = await Promise.all([
        axios.get(exportBaseUrl, {
          params: {
            participant: selectedParticipant,
            month: selectedMonth,
            year: selectedYear,
            startDate: dateRange.startDate,
            endDate: dateRange.endDate,
            type: 'budget'
          },
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        }),
        axios.get(exportBaseUrl, {
          params: {
            participant: selectedParticipant,
            month: selectedMonth,
            year: selectedYear,
            startDate: dateRange.startDate,
            endDate: dateRange.endDate,
            type: 'service'
          },
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        })
      ]);

      const allBudgetItems: BudgetRecord[] = budgetResponse.data?.items || [];
      const allServiceItems: ServiceRecord[] = serviceResponse.data?.items || [];

      // Create updated statement data with all items
      const fullStatementData = {
        ...statementData,
        budgetItems: allBudgetItems,
        serviceItems: allServiceItems,
        services: allServiceItems, // Also update services for backward compatibility
      };

      let chartImage: string | undefined;
      const chartsWithData = chartConfigs.filter((c) => c.hasData);
      if (chartsWithData.length > 0 && chartCardRefs.current.length > 0) {
        try {
          const pdfCols = chartsWithData.length === 3 || chartsWithData.length > 4 ? 3 : 2;
          const { width: chartW, height: chartH } = getPdfChartCellSize(pdfCols);
          const chartIndicesWithData = chartsWithData.map((c) => chartConfigs.indexOf(c));
          // Render fixed-size offscreen charts for capture.
          setPdfChartCaptureRequest({ width: chartW, height: chartH, indices: chartIndicesWithData });

          // Allow React render + fonts + Recharts layout to settle before capture.
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          );
          // If fonts are still loading, wait (prevents layout differences in SVG text).
          try {
            if (document.fonts?.ready) await document.fonts.ready;
          } catch { /* ignore */ }

          // Wait until all capture nodes are mounted and sized correctly.
          const waitForCaptureNodes = async (expected: number, w: number, h: number) => {
            const start = performance.now();
            while (performance.now() - start < 2500) {
              const els = pdfChartCaptureRefs.current.slice(0, expected).filter(Boolean) as HTMLDivElement[];
              if (els.length === expected) {
                const ready = els.every((el) => {
                  const rect = el.getBoundingClientRect();
                  if (Math.abs(rect.width - w) > 1 || Math.abs(rect.height - h) > 1) return false;
                  const svg = el.querySelector('svg.recharts-surface') as SVGSVGElement | null;
                  if (!svg) return false;
                  const svgW = Number(svg.getAttribute('width'));
                  const svgH = Number(svg.getAttribute('height'));
                  return Number.isFinite(svgW) && svgW > 0 && Number.isFinite(svgH) && svgH > 0;
                });
                if (ready) return true;
              }
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }
            return false;
          };

          await waitForCaptureNodes(chartIndicesWithData.length, chartW, chartH);

          const imageDataUrls: string[] = [];
          for (let i = 0; i < chartIndicesWithData.length; i++) {
            const el = pdfChartCaptureRefs.current[i];
            if (!el) continue;
            const dataUrl = await toPng(el, {
              pixelRatio: 2,
              cacheBust: true,
              backgroundColor: "white",
            });
            imageDataUrls.push(dataUrl);
          }
          if (imageDataUrls.length > 0) {
            chartImage = await compositeChartImages(imageDataUrls, pdfCols, { width: chartW, height: chartH });
          }
        } catch (e) {
          console.warn("Chart capture for PDF failed:", e);
        } finally {
          setPdfChartCaptureRequest(null);
          pdfChartCaptureRefs.current = [];
        }
      }

      // Call backend PDF generation endpoint, sending browser timezone so dates are formatted correctly
      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf/${id}/${boardId}/monthly-statement`,
        {
          statementData: fullStatementData,
          businessDetails,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(chartImage ? { chartImage } : {}),
        }
      );

      const fileUrl = response.data?.fileUrl;
      if (fileUrl) {
        try {
          const pdfResponse = await fetch(fileUrl);
          const pdfBlob = await pdfResponse.blob();
          const pdfObjectUrl = URL.createObjectURL(pdfBlob);
          const link = document.createElement('a');
          link.href = pdfObjectUrl;
          link.download = response.data?.filename
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();

          setTimeout(() => {
            document.body.removeChild(link);
            URL.revokeObjectURL(pdfObjectUrl);
          }, 100);

          showSuccessToast(
            action === 'generate'
              ? 'Monthly statement PDF downloaded successfully'
              : 'PDF exported successfully'
          );
        } catch (downloadErr: any) {
          console.error('Error downloading PDF:', downloadErr);

          window.open(fileUrl, '_blank');
          showInfoToast('PDF opened in new tab', {
            description: 'Download failed, opened PDF in new tab instead.'
          });
        }
        return fileUrl;
      } else {
        showErrorToast('Failed to retrieve PDF link from server.');
        return null;
      }
    } catch (err) {
      console.error(`Error ${action === 'generate' ? 'generating' : 'exporting'} PDF:`, err);
      showErrorToast('Failed to generate PDF. Please try again.');
      return null;
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
      showErrorToast('Failed to export budget items', { description: err?.message || 'Unknown error' });
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
      showErrorToast(`Failed to export ${categoryTitle} budget items`, { description: err?.message || 'Unknown error' });
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
      if (typeof dateString === 'string') {
        const trimmed = dateString.trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
          return trimmed;
        }
        const parsedLocal = parse(trimmed, 'dd/MM/yyyy', new Date());
        if (isValid(parsedLocal)) {
          return format(parsedLocal, 'dd/MM/yyyy');
        }
      }
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

  const getBudgetColumnsForCode = (code?: string) =>
    BUDGET_TABLE_COLUMNS[code || 'HSQ'] || BUDGET_TABLE_COLUMNS.HSQ;

  // Shared category order used for rendering and export
  const CATEGORY_ORDER = ['HSQ', 'ATS', 'ATO', 'HMB', 'RCP', 'EOL', 'HSCM'] as const;

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
      return value.map(normalizeBudgetValue).filter(Boolean).join(', ');
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
      case 'Current Balance ($)':
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
            shortLabel: `${selectedMonthLabel} expenditure`,
            value: expenditure,
            color: '#dc2626' // Red
          },
          {
            name: 'hsq-balance',
            label: hsqBalanceLabel,
            shortLabel: hsqBalanceLabel,
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
        category.remainingBalanceAllocationPeriod ?? category.remainingBudget
      );
      const committed = Math.abs(toNumber(category.committedFunds ?? 0));
      const committedLabel =
        code === 'ATS'
          ? 'Committed AT Short-term Funds'
          : code === 'ATO'
            ? 'Committed AT Ongoing Funds'
            : 'Committed HM Funds';
      // Date A = Funding End Date for selected month/year; show N/A when not available (dynamic per selection)
      const fundingEndDisplay = category.fundingEndDate != null && String(category.fundingEndDate).trim() !== ''
        ? formatDate(category.fundingEndDate)
        : 'N/A';
      const remainingLabel = `Remaining budget ${fundingEndDisplay}`;
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
            shortLabel: `${selectedMonthLabel} expenditure`,
            value: expenditure,
            color: '#dc2626' // Red
          },
          {
            name: `${code}-committed`,
            label: committedLabel,
            shortLabel: committedLabel,
            value: committed,
            color: '#16a34a' // Green
          },
          {
            name: `${code}-balance`,
            label: remainingLabel,
            shortLabel: remainingLabel,
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
      const rcpCategory = categoryLookup.get('RCP');
      // Purple: Spending from previous month(s) = Fund Amount ($) - Available Fund at the Start of the Month ($)
      const previousSpending = getPreviousSpendingValue(category);
      const available = positive(category.availableFunds);
      // Blue bar per spec: value = Total Available Budget for Restorative Care ($) / End-of-Life Care ($)
      const totalAvailable = positive(category.totalAvailableBudget ?? category.availableFunds ?? 0);
      const blueBarValue =
        code === 'EOL'
          ? positive(rcpCategory?.remainingBudget ?? 0)
          : totalAvailable;
      // Red: [Month] expenditure = Service Delivered During the Month ($-) + Adjustments from Previous Months (signed then abs)
      const expenditure = calculateExpenditure(category, { signed: true });
      const remaining = positive(category.remainingBudget);

      // RCP fifth chart: blue bar = Remaining Restorative Care Balance as at the End of the Month ($)
      // EOL sixth chart: blue bar = Remaining End-of-Life Care Balance as at the End of the Month ($)
      const blueBarLabel =
        code === 'RCP'
          ? 'Remaining Restorative Care Balance as at the End of the Month ($)'
          : code === 'EOL'
            ? 'Remaining End-of-Life Care Balance as at the End of the Month ($)'
            : `Remaining budget ${formatDate(category.fundingEndDate)}`;
      const blueBarValueForChart = code === 'RCP' || code === 'EOL' ? remaining : blueBarValue;

      pushChartConfig({
        code,
        subtitle: title,
        title: `${title} (${statementData.year})`,
        data: [
          {
            name: `${code}-previous`,
            label: 'Spending from previous months',
            shortLabel: 'Spending from previous months',
            value: previousSpending,
            color: '#7c3aed' // Purple
          },
          {
            name: `${code}-expenditure`,
            label: `${selectedMonthLabel} expenditure`,
            shortLabel: `${selectedMonthLabel} expenditure`,
            value: expenditure,
            color: '#dc2626' // Red
          },
          {
            name: `${code}-balance`,
            label: blueBarLabel,
            shortLabel: blueBarLabel,
            value: blueBarValueForChart,
            color: '#2563eb' // Blue - RCP: Remaining Restorative Care Balance as at End of Month; EOL: Remaining End-of-Life Care Balance as at End of Month
          }
        ],
        metrics: [
          { label: code === 'EOL' ? 'Remaining End-of-Life Care Balance as at the End of the Month ($)' : code === 'RCP' ? 'Remaining Restorative Care Balance as at the End of the Month ($)' : 'Total available budget', value: code === 'RCP' || code === 'EOL' ? remaining : blueBarValue },
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
  const ChartXAxisTick = ({ x, y, payload }: { x?: number; y?: number; payload?: { value?: string } }) => {
    const raw = payload?.value ?? '';
    const maxCharsPerLine = 12;
    const lines = String(raw)
      .split(/\s+/)
      .reduce<string[]>((acc, word) => {
        if (acc.length === 0) return [word];
        const last = acc[acc.length - 1];
        if ((last + ' ' + word).length <= maxCharsPerLine) {
          acc[acc.length - 1] = `${last} ${word}`;
        } else {
          acc.push(word);
        }
        return acc;
      }, []);

    return (
      <text x={x} y={y} textAnchor="middle" fill="currentColor" className="text-[13px] leading-tight" style={{ overflow: 'visible' }}>
        {lines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? 13 : 15}>
            {line}
          </tspan>
        ))}
      </text>
    );
  };

  const PdfChartXAxisTick = ({ x, y, payload }: { x?: number; y?: number; payload?: { value?: string } }) => {
    const raw = payload?.value ?? '';
    const maxCharsPerLine = 12;
    const lines = String(raw)
      .split(/\s+/)
      .reduce<string[]>((acc, word) => {
        if (acc.length === 0) return [word];
        const last = acc[acc.length - 1];
        if ((last + ' ' + word).length <= maxCharsPerLine) {
          acc[acc.length - 1] = `${last} ${word}`;
        } else {
          acc.push(word);
        }
        return acc;
      }, []);

    return (
      <text x={x} y={y} textAnchor="middle" fill="currentColor" className="text-[15px] leading-tight" style={{ overflow: 'visible' }}>
        {lines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? 15 : 17}>
            {line}
          </tspan>
        ))}
      </text>
    );
  };

  const ChartYAxisTick = ({ x, y, payload }: { x?: number; y?: number; payload?: { value?: number | string } }) => {
    const raw = payload?.value;
    const asNumber = typeof raw === 'number' ? raw : Number(raw ?? 0);
    return (
      <text x={x} y={y} textAnchor="end" fill="currentColor" className="text-[13px] leading-tight" dy={4}>
        {formatAxisCurrency(asNumber)}
      </text>
    );
  };

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
                Manage participants&apos; budget and service records, and generate the Support at Home monthly statement.
              </p>
            </div>

            {/* Filters */}
            <Card className="p-6 mb-6 shadow-lg print:hidden">
              <div className="flex flex-nowrap items-end gap-4 overflow-x-auto pb-2">
                <div className="space-y-2 flex-shrink-0 min-w-[200px]">
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

                <div className="space-y-2 flex-shrink-0 min-w-[160px]">
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

                <div className="space-y-2 flex-shrink-0 min-w-[120px]">
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

                <div className="flex-shrink-0">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="secondary"
                          className="gap-2"
                          onClick={handleManualSync}
                          disabled={isManualSyncing || syncStatuses.some(sync => sync.boardId === boardId && (sync.status === 'started' || sync.status === 'in-progress'))}
                        >
                          {isManualSyncing ? (
                            <>
                              <Spinner className="h-4 w-4" />
                              Syncing...
                            </>
                          ) : (
                            <>
                              Resync Data
                            </>
                          )}
                          <HelpCircle className="h-4 w-4" aria-label="Learn more about Resync Data" onClick={(e) => { e.stopPropagation(); setShowHelpDialog(true); }} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        It downloads brand-new data from the server, including any edits and new records.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>

                <div className="flex-shrink-0">
                  <Button
                    onClick={fetchStatementData}
                    disabled={loading || exportingSection === 'statement-pdf' || !selectedParticipant || !selectedMonth || !selectedYear}
                  >
                    {loading && exportingSection !== 'statement-pdf' ? <Spinner /> : 'Load Statement'}
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
                    {exportingSection === 'statement-pdf' ? (
                      <>
                        <Spinner className="h-4 w-4" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <FileCheck className="h-4 w-4" />
                        Generate Monthly Statement
                      </>
                    )}
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

            <Card className="p-6 shadow-lg print:shadow-none">
              <div className="mb-6">
                <h3 className="text-xl font-semibold">Budget Mini Charts</h3>
                <p className="text-sm text-muted-foreground">
                  Visual summaries for each funding stream, including Expenditure, remaining budget, etc.
                </p>
              </div>
              {loadingServiceItems ? (
                <div className="text-center py-8">
                  <Spinner />
                </div>
              ) : chartConfigs.length > 0 ? (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" ref={chartContainerRef}>
                  {chartConfigs.map((chart, chartIndex) => (
                    <div
                      key={chart.code}
                      ref={(el) => { chartCardRefs.current[chartIndex] = el; }}
                      className="rounded-lg border border-border/60 bg-card p-5 flex flex-col gap-4 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3" data-pdf-chart-header="true">
                        <div>
                          <h4 className="text-base font-semibold leading-tight">{chart.title}</h4>
                        </div>
                      </div>

                      <ChartContainer
                        config={chart.chartConfig}
                        className="w-full aspect-auto min-h-[18rem] h-72 overflow-visible"
                        data-pdf-chart-container="true"
                      >
                        <BarChart data={chart.data} margin={{ left: 0, right: 0, top: 34, bottom: 24 }} barCategoryGap="22%">
                            <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis
                            dataKey="shortLabel"
                            axisLine={false}
                            tickLine={false}
                            interval={0}
                            height={150}
                            tick={<ChartXAxisTick />}
                            allowDataOverflow={false}
                          />
                          <YAxis axisLine={false} tickLine={false} tick={<ChartYAxisTick />} />
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
                          <Bar
                            dataKey="value"
                            radius={[6, 6, 0, 0]}
                            maxBarSize={42}
                            isAnimationActive={!isPdfChartCaptureMode}
                          >
                            <LabelList
                              dataKey="value"
                              position="top"
                              formatter={(value: number) => (Number.isFinite(value) ? formatCurrency(value) : '')}
                              className="fill-muted-foreground text-[12px] font-semibold"
                            />
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
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <AlertCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>No services found for the selected period</p>
                </div>
              )}
            </Card>

            {/* Offscreen fixed-size chart renderer for PDF capture (prevents Recharts layout mismatches). */}
            {pdfChartCaptureRequest && (
              <div
                aria-hidden="true"
                style={{
                  position: 'fixed',
                  left: '-100000px',
                  top: 0,
                  width: 0,
                  height: 0,
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                {pdfChartCaptureRequest.indices.map((chartIdx, i) => {
                  const chart = chartConfigs[chartIdx];
                  if (!chart) return null;
                  const chartId = `pdfchart-${chart.code}-${i}`;
                  return (
                    <PdfChartFrame
                      key={`pdf-capture-${chart.code}`}
                      ref={(el) => { pdfChartCaptureRefs.current[i] = el; }}
                      chart={chart}
                      width={pdfChartCaptureRequest.width}
                      height={pdfChartCaptureRequest.height}
                      chartId={chartId}
                      xAxisTick={<PdfChartXAxisTick />}
                      formatAxisCurrency={formatAxisCurrency}
                      formatCurrency={formatCurrency}
                    />
                  );
                })}
              </div>
            )}

            {/* Individualised Budgets */}
            <Card className="shadow-lg print:shadow-none">
              <div className="p-6 border-b">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="text-xl font-semibold">Individualised Budgets</h3>
                    <p className="text-sm text-muted-foreground">
                      Budget allocation and spending records for each funding stream
                    </p>
                  </div>
                </div>
              </div>

              {/* Budget Streams Subsections */}
              {loadingServiceItems ? (
                <div className="p-6 text-center">
                  <Spinner />
                </div>
              ) : (
                <div className="space-y-6 p-6">
                  {categorizedBudgetSections.map((section) => (
                    <div key={section.categoryCode} className="border rounded-lg p-4">
                      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div>
                          <h4 className="text-lg font-semibold">{section.sectionTitle}</h4>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-2 print:hidden"
                          onClick={() => handleBudgetCategoryExportCSV(section.categoryCode, section.sectionTitle)}
                          disabled={exportingSection === `budget-${section.categoryCode}`}
                        >
                          <FileSpreadsheet className="h-4 w-4" />
                          Export CSV
                        </Button>
                      </div>
                      <div className="overflow-x-auto">
                        {section.items.length === 0 ? (
                          <div className="py-4 text-center text-sm text-muted-foreground">
                            No budget items found for this stream.
                          </div>
                        ) : (
                          <Table className="text-sm min-w-max">
                            <TableHeader>
                              <TableRow>
                                {section.columns.map((column) => (
                                  <TableHead
                                    key={`${section.categoryCode}-${column}`}
                                    className={isCurrencyColumn(column) || isHourColumn(column) ? 'text-right whitespace-nowrap' : 'whitespace-normal break-words'}
                                  >
                                    {column}
                                  </TableHead>
                                ))}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {section.items.map((item) => (
                                <TableRow key={item.id} className="text-xs">
                                  {section.columns.map((column) => (
                                    <TableCell
                                      key={`${item.id}-${column}`}
                                      className={isCurrencyColumn(column) || isHourColumn(column) ? 'text-right whitespace-nowrap' : 'whitespace-normal break-words'}
                                    >
                                      {formatBudgetCellDisplay(column, item)}
                                    </TableCell>
                                  ))}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Service Records */}
            <Card className="shadow-lg print:shadow-none">
              <div className="p-6 border-b">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="text-xl font-semibold">Service Records</h3>
                    <p className="text-sm text-muted-foreground">
                      The services scheduled for the participants and their status
                    </p>
                  </div>
                  <div className="print:hidden flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="transaction-status-filter" className="text-sm whitespace-nowrap">Transaction Status</Label>
                      <Select
                        value={serviceTransactionStatusFilter}
                        onValueChange={(value) => {
                          setServiceTransactionStatusFilter(value);
                          fetchServiceItems(1, servicePagination.limit, serviceSortBy, serviceSortOrder, value, serviceFundingSourceFilter);
                        }}
                        disabled={!statementData || loadingServiceItems}
                      >
                        <SelectTrigger id="transaction-status-filter" className="w-[220px]">
                          <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          {distinctTransactionStatuses.map((status) => (
                            <SelectItem key={status} value={status}>
                              {status}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="funding-source-filter" className="text-sm whitespace-nowrap">Funding Source</Label>
                      <Select
                        value={serviceFundingSourceFilter}
                        onValueChange={(value) => {
                          setServiceFundingSourceFilter(value);
                          fetchServiceItems(1, servicePagination.limit, serviceSortBy, serviceSortOrder, serviceTransactionStatusFilter, value);
                        }}
                        disabled={!statementData || loadingServiceItems}
                      >
                        <SelectTrigger id="funding-source-filter" className="w-[220px]">
                          <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          {distinctFundingSources.map((source) => (
                            <SelectItem key={source} value={source}>
                              {source}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={handleServiceExportCSV}
                      disabled={!statementData || exportingSection === 'service-csv'}
                    >
                      <FileSpreadsheet className="h-4 w-4" />
                      Export CSV
                    </Button>
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto">
                {loadingServiceItems ? (
                  <div className="p-6 text-center">
                    <Spinner />
                  </div>
                ) : serviceItems.length > 0 ? (
                  <Table className="text-sm">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap">Participant</TableHead>
                        <TableHead className="whitespace-nowrap">Service</TableHead>
                        <TableHead className="whitespace-nowrap">Service Provider</TableHead>
                        <TableHead className="whitespace-nowrap">
                          <button
                            type="button"
                            className={`inline-flex items-center gap-1 hover:text-foreground ${serviceSortBy === 'scheduledServiceDate' ? 'text-red-600' : 'text-muted-foreground'}`}
                            onClick={() => {
                              const isActive = serviceSortBy === 'scheduledServiceDate';
                              const nextOrder = isActive && serviceSortOrder === 'asc' ? 'desc' : 'asc';
                              setServiceSortBy('scheduledServiceDate');
                              setServiceSortOrder(nextOrder);
                              fetchServiceItems(1, servicePagination.limit, 'scheduledServiceDate', nextOrder);
                            }}
                          >
                            Scheduled Service Date
                            {serviceSortBy === 'scheduledServiceDate' ? (serviceSortOrder === 'asc' ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />}
                          </button>
                        </TableHead>
                        <TableHead className="whitespace-nowrap">
                          <button
                            type="button"
                            className={`inline-flex items-center gap-1 hover:text-foreground ${serviceSortBy === 'serviceDeliveryDate' ? 'text-red-600' : 'text-muted-foreground'}`}
                            onClick={() => {
                              const nextBy = 'serviceDeliveryDate';
                              const nextOrder = serviceSortBy === 'serviceDeliveryDate' && serviceSortOrder === 'asc' ? 'desc' : 'asc';
                              setServiceSortBy(nextBy);
                              setServiceSortOrder(nextOrder);
                              fetchServiceItems(1, servicePagination.limit, nextBy, nextOrder);
                            }}
                          >
                            Service Delivery Date
                            {serviceSortBy === 'serviceDeliveryDate' ? (serviceSortOrder === 'asc' ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />}
                          </button>
                        </TableHead>
                        <TableHead className="whitespace-nowrap">Transaction Status</TableHead>
                        <TableHead className="whitespace-nowrap">Committed AT-HM for Delivery</TableHead>
                        <TableHead className="whitespace-nowrap">Unit</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Quantity</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Unit Price ($)</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Total Amount ($)</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Gov Subsidy ($)</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Participant Contribution ($)</TableHead>
                        <TableHead>Funding Source</TableHead>
                        <TableHead>Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {serviceItems.map((service) => (
                        <TableRow key={service.id} className="text-xs">
                          <TableCell className="whitespace-nowrap">
                            {service.participant || service.participantName || '-'}
                          </TableCell>
                          <TableCell className="min-w-[250px]">
                            {service.service || service.taskName || '-'}
                          </TableCell>
                          <TableCell className="min-w-[180px]">
                            {getServiceProviderLabel(service)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {service.scheduledServiceDate ? formatDate(service.scheduledServiceDate) : (service.scheduledShiftStart ? formatDate(service.scheduledShiftStart) : 'N/A')}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {service.serviceDeliveryDate ? formatDate(service.serviceDeliveryDate) : (service.actualShiftEndDateTime ? formatDate(service.actualShiftEndDateTime) : 'N/A')}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {service.transactionStatus && service.transactionStatus.trim() !== '' ? (
                              <Badge
                                variant={service.transactionStatus?.toLowerCase().includes('cancelled') ? 'destructive' : service.transactionStatus?.toLowerCase().includes('delivered') ? 'default' : 'secondary'}
                                className="text-xs w-max"
                              >
                                {service.transactionStatus}
                              </Badge>
                            ) : (
                              'N/A'
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            {service.committedAtHmForDelivery && service.committedAtHmForDelivery > 0 ? (
                              <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-blue-500 text-white">Yes</span>
                            ) : (
                              <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-white text-foreground border border-input">No</span>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">{service.unit || '-'}</TableCell>
                          <TableCell className="text-right">{Number(service.quantity ?? 0).toFixed(2)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(service.unitPrice ?? 0)}</TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(service.totalAmount ?? 0)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(service.govSubsidy ?? 0)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(service.participantContribution ?? 0)}</TableCell>
                          <TableCell className="min-w-[150px]">{service.fundingSource || 'N/A'}</TableCell>
                          <TableCell className="max-w-[250px]">
                            {service.notes && service.notes.trim() ? (
                              <div
                                className="notes-cell text-sm prose prose-p:my-0.5 prose-p:leading-tight max-w-none"
                                dangerouslySetInnerHTML={{ __html: sanitizeNotesHtml(service.notes) }}
                              />
                            ) : (
                              'N/A'
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="p-6 text-center text-muted-foreground">
                    <AlertCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
                    <p>No service records found for the selected period</p>
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

      <Dialog open={showHelpDialog} onOpenChange={setShowHelpDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5" />
              Resync Data
            </DialogTitle>
            <DialogDescription>
              Understanding how resync works
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <Download className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="font-semibold text-sm">Resync Data</h3>
                  <p className="text-sm text-muted-foreground">
                    It downloads brand-new data from the server, including any edits and new records. The button will be disabled while a sync is in progress.
                  </p>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowHelpDialog(false)}>Got it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            {businessDetailsErrors.length > 0 && (
              <div className="col-span-2 mb-2 p-4 bg-destructive/10 border border-destructive rounded-md">
                <h4 className="text-sm font-medium text-destructive mb-2">Please correct the following errors:</h4>
                <ul className="list-disc list-inside space-y-1">
                  {businessDetailsErrors.map((error, index) => (
                    <li key={index} className="text-sm text-destructive">
                      {error}
                    </li>
                  ))}
                </ul>
              </div>
            )}

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

            <div className="space-y-2">
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
              <Label htmlFor="country">Country</Label>
              <Select
                value={businessDetails.country}
                onValueChange={(value) =>
                  setBusinessDetails({
                    ...businessDetails,
                    country: value,
                    state: "", // Reset state when country changes
                  })
                }
              >
                <SelectTrigger id="country">
                  <SelectValue placeholder="Select country" />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(countryStates).map((country) => (
                    <SelectItem key={country} value={country}>
                      {country}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="state">State</Label>
              <Select
                value={businessDetails.state}
                onValueChange={(value) =>
                  setBusinessDetails({ ...businessDetails, state: value })
                }
                disabled={!businessDetails.country || countryStates[businessDetails.country]?.length === 0}
              >
                <SelectTrigger id="state">
                  <SelectValue placeholder={
                    !businessDetails.country
                      ? "Select country first"
                      : countryStates[businessDetails.country]?.length === 0
                        ? "No states available"
                        : "Select state"
                  } />
                </SelectTrigger>
                <SelectContent>
                  {businessDetails.country && countryStates[businessDetails.country]?.map((state: string) => (
                    <SelectItem key={state} value={state}>
                      {state}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="postcode">Postcode</Label>
              <Input
                id="postcode"
                value={businessDetails.postcode}
                onChange={(e) => setBusinessDetails({ ...businessDetails, postcode: e.target.value })}
                placeholder="Enter postcode"
                maxLength={8}
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
