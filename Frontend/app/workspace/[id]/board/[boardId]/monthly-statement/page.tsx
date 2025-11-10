"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Printer, Calendar, DollarSign, Clock, Package, User, FileText, TrendingUp, PieChart, Download, AlertCircle, FileCheck } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface ServiceRecord {
  id: string;
  participant: string;
  scheduledStart: string | null;
  actualStart: string | null;
  actualEnd: string | null;
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

interface BudgetCategory {
  name: string;
  code: string;
  availableFunds: number;
  expenditure: number;
  remainingBudget: number;
  services: ServiceRecord[];
  fundingEndDate?: string;
  committedFunds?: number;
  quarterStartMonth?: string;
  quarterEndMonth?: string;
  availableBalanceNextQuarter?: number;
  serviceDeliveredAmount?: number;
  govSubsidyAmount?: number;
  participantContributionAmount?: number;
  adjustmentAmount?: number;
  serviceCount?: number;
  availableBalanceRangeLabel?: string;
  expenditurePeriodLabel?: string;
}

interface MonthlyStatementData {
  participant: string;
  participantProfile: string;
  month: string;
  year: string;
  monthNumber: string;
  services: ServiceRecord[];
  budgetCategories: BudgetCategory[];
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
}

export default function MonthlyStatement() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split('/')[2];
  const boardId = pathname.split('/')[4];
  
  const [loading, setLoading] = useState(false);
  const [loadingParticipants, setLoadingParticipants] = useState(false);
  const [statementData, setStatementData] = useState<MonthlyStatementData | null>(null);
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
  });

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
        const data = await fetchMonthlyStatementItems(id, boardId, {
          folderName: 'Master Plan,Shift Planning and Reporting',
          limit: 1000,
        });

        if (data?.items) {
          const participantSet = new Set<string>(
            data.items
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
  }, []);

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

  // Categorize services into budget categories using data from API
  const categorizeServices = (
    services: ServiceRecord[], 
    budgetCategoriesFromAPI: BudgetCategory[] | undefined,
    monthNumber: string, 
    year: string
  ): BudgetCategory[] => {
    const quarterMonths = getQuarterMonths(monthNumber);
    const defaultFundingEndDate = new Date(parseInt(year), 11, 31).toISOString(); // End of year
    
    // If budget categories are provided from API, use them and just assign services
    if (budgetCategoriesFromAPI && budgetCategoriesFromAPI.length > 0) {
      // Create a map for quick lookup
      const categoryMap = new Map<string, BudgetCategory>();
      budgetCategoriesFromAPI.forEach(cat => {
        // Initialize services array while preserving backend-calculated figures
        const category: BudgetCategory = {
          ...cat,
          services: [],
        };
        categoryMap.set(cat.code, category);
      });

      // Categorize each service based on funding source
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
          category.services.push(service);
        }
      });

      // Return categories in the correct order
      const categoryOrder = ['HSQ', 'RCP', 'EOL', 'ATS', 'ATO', 'HMB'];
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
        expenditure: 0,
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
        expenditure: 0,
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
        expenditure: 0,
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
        expenditure: 0,
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
        expenditure: 0,
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
        expenditure: 0,
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
    try {
      // Calculate date range for selected month using date-fns for better timezone handling
      const monthDate = new Date(yearNum, monthNum - 1, 1);
      if (!isValid(monthDate)) {
        showErrorToast('Invalid date selected');
        return;
      }
      const startDate = startOfMonth(monthDate);
      const endDate = new Date(endOfMonth(monthDate));
      // Ensure endDate includes the full day (23:59:59.999)
      endDate.setHours(23, 59, 59, 999);

      const data = await fetchMonthlyStatementItems(id, boardId, {
        participant: selectedParticipant,
        folderName: 'Master Plan,Shift Planning and Reporting',
        limit: 1000,
        // deliveryStartDate: startDate.toISOString(),
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        // deliveryEndDate: endDate.toISOString(),
        month: selectedMonth,
        year: selectedYear,
      });

      if (data?.items) {
        const services: ServiceRecord[] = data.items;
        
        // Calculate summary
        const totalServices = services.length;
        const totalHours = services.reduce((sum, s) => sum + (s.unit === 'Hour' ? s.quantity : 0), 0);
        const totalAmount = services.reduce((sum, s) => sum + (s.totalAmount || 0), 0);
        const govSubsidy = services.reduce((sum, s) => sum + (s.govSubsidy || 0), 0);
        const participantContribution = services.reduce((sum, s) => sum + (s.participantContribution || 0), 0);
        const averageServiceCost = totalServices > 0 ? totalAmount / totalServices : 0;

        const monthLabel = months.find(m => m.value === selectedMonth)?.label || selectedMonth;
        
        // Use budget categories from API response, or calculate them
        // Type guard for budget categories
        const budgetCategoriesFromAPI = Array.isArray(data.budgetCategories) 
          ? (data.budgetCategories as BudgetCategory[])
          : undefined;
        const budgetCategories = categorizeServices(services, budgetCategoriesFromAPI, selectedMonth, selectedYear);

        // Get participant profile data from API if available
        const participantProfileData = data.participantProfile || {};

        setStatementData({
          participant: selectedParticipant,
          participantProfile: selectedParticipant,
          month: monthLabel,
          year: selectedYear,
          monthNumber: selectedMonth,
          services,
          budgetCategories,
          summary: {
            totalServices,
            totalHours,
            totalAmount,
            govSubsidy,
            participantContribution,
            averageServiceCost,
          },
          participantAddress: participantProfileData.address,
          participantSuburb: participantProfileData.suburb,
          participantState: participantProfileData.state,
          participantPostcode: participantProfileData.postcode,
          myAgedCareIdNumber: participantProfileData.myAgedCareIdNumber,
          providerId: participantProfileData.providerId,
        });
        
        showSuccessToast('Statement loaded successfully');
      }
    } catch (err) {
      console.error('Error fetching statement data:', err);
      showErrorToast('Failed to fetch statement data');
    } finally {
      setLoading(false);
    }
  };

  // Handle print
  const handlePrint = () => {
    setIsPrintMode(true);
    setTimeout(() => {
      window.print();
      setTimeout(() => setIsPrintMode(false), 100);
    }, 100);
  };

  // Handle PDF generation/export (consolidated function)
  const handlePDFAction = async (action: 'generate' | 'export' = 'generate') => {
    if (!statementData) {
      showErrorToast('Please load a statement first');
      return;
    }

    if (!businessDetails.companyName || !businessDetails.phoneNumber || !businessDetails.businessEmail) {
      showErrorToast(`Please configure business details before ${action === 'generate' ? 'generating' : 'exporting'} PDF`);
      setShowBusinessDialog(true);
      return;
    }

    try {
      setLoading(true);
      
      // Call backend PDF generation endpoint
      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf/${id}/${boardId}/monthly-statement`,
        {
          statementData,
          businessDetails,
        },
        {
          responseType: 'blob',
        }
      );

      // Download the PDF
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Monthly_Statement_${statementData.participant}_${statementData.month}_${statementData.year}.pdf`;
      link.click();
      window.URL.revokeObjectURL(url);

      showSuccessToast(
        action === 'generate' 
          ? 'Monthly statement PDF generated successfully'
          : 'PDF exported successfully'
      );
    } catch (err) {
      console.error(`Error ${action === 'generate' ? 'generating' : 'exporting'} PDF:`, err);
      if (action === 'export') {
        showErrorToast('Failed to export PDF. Using print as fallback.');
        handlePrint();
      } else {
        showErrorToast('Failed to generate PDF. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Alias functions for backward compatibility
  const handleGeneratePDF = () => handlePDFAction('generate');
  const handleExportPDF = () => handlePDFAction('export');

  // Save business details
  const handleSaveBusinessDetails = async () => {
    if (!businessDetails.companyName || !businessDetails.phoneNumber || !businessDetails.businessEmail) {
      showErrorToast('Please fill in all required fields (Company Name, Phone, Email)');
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
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: 'AUD',
    }).format(amount);
  };

  // Format date
  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'N/A';
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return 'N/A';
      return format(date, 'dd/MM/yyyy');
    } catch (e) {
      return 'N/A';
    }
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
              <h1 className="text-3xl font-bold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/80">
                Monthly Statement Generator
              </h1>
              <p className="text-muted-foreground">
                Generate comprehensive monthly service records and budget statements for Support at Home participants
              </p>
            </div>

            {/* Filters */}
            <Card className="p-6 mb-6 shadow-lg print:hidden">
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
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

                <div className="flex items-end">
                  <Button
                    variant="outline"
                    onClick={() => setShowBusinessDialog(true)}
                    className="w-full"
                  >
                    <FileText className="h-4 w-4 mr-2" />
                    Business Details
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
                {!isPrintMode && (
                  <div className="flex gap-2">
                    <Button onClick={handleExportPDF} variant="outline" className="gap-2 print:hidden">
                      <Download className="h-4 w-4" />
                      Export to PDF
                    </Button>
                    <Button onClick={handleGeneratePDF} className="gap-2 print:hidden bg-red-600 hover:bg-red-700">
                      <FileCheck className="h-4 w-4" />
                      Generate Monthly Statement PDF
                    </Button>
                  </div>
                )}
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
                  </div>
                </div>
              )}
            </Card>

            {/* Summary Tiles */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {/* Total Services */}
              <Card className="p-6 space-y-4 print:break-inside-avoid">
                <div className="flex items-center justify-between">
                  <div className="bg-blue-100 dark:bg-blue-900 w-12 h-12 rounded-full flex items-center justify-center">
                    <Package className="h-6 w-6 text-blue-600 dark:text-blue-300" />
                  </div>
                  <Badge variant="outline" className="text-lg font-semibold">
                    {statementData.summary.totalServices}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Services</p>
                  <p className="text-2xl font-bold">{statementData.summary.totalServices}</p>
                </div>
              </Card>

              {/* Total Hours */}
              <Card className="p-6 space-y-4 print:break-inside-avoid">
                <div className="flex items-center justify-between">
                  <div className="bg-purple-100 dark:bg-purple-900 w-12 h-12 rounded-full flex items-center justify-center">
                    <Clock className="h-6 w-6 text-purple-600 dark:text-purple-300" />
                  </div>
                  <Badge variant="outline" className="text-lg font-semibold">
                    {statementData.summary.totalHours.toFixed(1)}h
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Hours</p>
                  <p className="text-2xl font-bold">{statementData.summary.totalHours.toFixed(1)}</p>
                </div>
              </Card>

              {/* Total Amount */}
              <Card className="p-6 space-y-4 print:break-inside-avoid">
                <div className="flex items-center justify-between">
                  <div className="bg-green-100 dark:bg-green-900 w-12 h-12 rounded-full flex items-center justify-center">
                    <DollarSign className="h-6 w-6 text-green-600 dark:text-green-300" />
                  </div>
                  <Badge variant="outline" className="text-lg font-semibold">
                    {formatCurrency(statementData.summary.totalAmount)}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Amount</p>
                  <p className="text-2xl font-bold">{formatCurrency(statementData.summary.totalAmount)}</p>
                </div>
              </Card>

              {/* Government Subsidy */}
              <Card className="p-6 space-y-4 print:break-inside-avoid">
                <div className="flex items-center justify-between">
                  <div className="bg-amber-100 dark:bg-amber-900 w-12 h-12 rounded-full flex items-center justify-center">
                    <TrendingUp className="h-6 w-6 text-amber-600 dark:text-amber-300" />
                  </div>
                  <Badge variant="outline" className="text-lg font-semibold">
                    {formatCurrency(statementData.summary.govSubsidy)}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Government Subsidy</p>
                  <p className="text-2xl font-bold">{formatCurrency(statementData.summary.govSubsidy)}</p>
                </div>
              </Card>

              {/* Participant Contribution */}
              <Card className="p-6 space-y-4 print:break-inside-avoid">
                <div className="flex items-center justify-between">
                  <div className="bg-red-100 dark:bg-red-900 w-12 h-12 rounded-full flex items-center justify-center">
                    <FileText className="h-6 w-6 text-red-600 dark:text-red-300" />
                  </div>
                  <Badge variant="outline" className="text-lg font-semibold">
                    {formatCurrency(statementData.summary.participantContribution)}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Participant Contribution</p>
                  <p className="text-2xl font-bold">{formatCurrency(statementData.summary.participantContribution)}</p>
                </div>
              </Card>

              {/* Average Service Cost */}
              <Card className="p-6 space-y-4 print:break-inside-avoid">
                <div className="flex items-center justify-between">
                  <div className="bg-teal-100 dark:bg-teal-900 w-12 h-12 rounded-full flex items-center justify-center">
                    <PieChart className="h-6 w-6 text-teal-600 dark:text-teal-300" />
                  </div>
                  <Badge variant="outline" className="text-lg font-semibold">
                    {formatCurrency(statementData.summary.averageServiceCost)}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Average Service Cost</p>
                  <p className="text-2xl font-bold">{formatCurrency(statementData.summary.averageServiceCost)}</p>
                </div>
              </Card>
            </div>

            {/* Budget Snapshot */}
            <Card className="p-6 shadow-lg print:shadow-none">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h3 className="text-xl font-semibold mb-2">Budget Snapshot</h3>
                  <p className="text-sm text-muted-foreground">
                    Converted from Support at Home monthly statement funding charts into tabular insights for each budget stream.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {statementData.budgetCategories.map((category) => (
                  <div
                    key={category.code}
                    className="rounded-lg border border-border/60 bg-card p-5 space-y-4 shadow-sm hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <h4 className="text-base font-semibold leading-tight mb-1.5">{category.name}</h4>
                        {category.availableBalanceRangeLabel && (
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            Available balance period: <span className="font-medium text-foreground">{category.availableBalanceRangeLabel}</span>
                          </p>
                        )}
                      </div>
                      <Badge 
                        variant="secondary" 
                        className="text-[11px] px-2.5 py-1 bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 font-medium shrink-0"
                      >
                        {(category.serviceCount ?? 0).toLocaleString()} services
                      </Badge>
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-2">
                      <div className="space-y-1.5">
                        <p className="text-[10px] uppercase text-muted-foreground tracking-wider font-medium">Available Funds</p>
                        <p className="text-base font-semibold text-foreground">
                          {formatCurrency(category.availableFunds || 0)}
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <p className="text-[10px] uppercase text-muted-foreground tracking-wider font-medium">Remaining Budget</p>
                        <p className={`text-base font-semibold ${
                          (category.remainingBudget || 0) < 0 
                            ? 'text-red-600 dark:text-red-400' 
                            : 'text-foreground'
                        }`}>
                          {formatCurrency(category.remainingBudget || 0)}
                        </p>
                      </div>
                    </div>

                    {category.fundingEndDate && (
                      <div className="text-xs text-muted-foreground pt-1">
                        Funding end date: <span className="font-medium text-foreground">{formatDate(category.fundingEndDate)}</span>
                      </div>
                    )}

                    {['ATS', 'ATO', 'HMB'].includes(category.code) && category.committedFunds !== undefined && (
                      <div className="text-xs text-muted-foreground pt-1">
                        Committed funds: <span className="font-medium text-foreground">{formatCurrency(category.committedFunds || 0)}</span>
                      </div>
                    )}

                    <div className="border-t border-border/50 pt-4 space-y-3">
                      <div className="space-y-1.5">
                        <p className="text-[10px] uppercase text-muted-foreground tracking-wider font-medium">
                          Services Delivered ({category.expenditurePeriodLabel || 'Selected Month'})
                        </p>
                        <p className="text-base font-semibold text-foreground">
                          {formatCurrency(category.serviceDeliveredAmount || 0)}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-4 pt-1">
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">Government Subsidy</p>
                          <p className="text-sm font-medium text-foreground">
                            {formatCurrency(category.govSubsidyAmount || 0)}
                          </p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">Participant Contribution</p>
                          <p className="text-sm font-medium text-foreground">
                            {formatCurrency(category.participantContributionAmount || 0)}
                          </p>
                        </div>
                      </div>
                      {category.adjustmentAmount && category.adjustmentAmount !== 0 ? (
                        <div className="space-y-1 pt-1">
                          <p className="text-xs text-muted-foreground">Adjustments from previous months</p>
                          <p className="text-sm font-medium text-foreground">
                            {formatCurrency(category.adjustmentAmount)}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Budget Categories with Tabs */}
            <Card className="p-6 shadow-lg print:shadow-none">
              <h3 className="text-xl font-semibold mb-4">Budget Categories</h3>
              
              <Tabs defaultValue="0" className="w-full">
                <TabsList className="grid w-full grid-cols-3 lg:grid-cols-6">
                  {statementData.budgetCategories.map((category, index) => (
                    <TabsTrigger key={index} value={index.toString()} className="text-xs">
                      {category.code}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {statementData.budgetCategories.map((category, index) => (
                  <TabsContent key={index} value={index.toString()} className="mt-4">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-lg font-semibold">{category.name}</h4>
                        <Badge variant={category.remainingBudget < 0 ? "destructive" : "default"}>
                          {formatCurrency(category.remainingBudget)} Remaining
                        </Badge>
                      </div>

                      <div className={`grid gap-4 p-4 bg-muted/30 rounded-lg ${(category.code === 'ATS' || category.code === 'ATO' || category.code === 'HMB') ? 'grid-cols-4' : 'grid-cols-3'}`}>
                        <div>
                          <p className="text-sm text-muted-foreground">Available Funds</p>
                          <p className="text-lg font-bold">{formatCurrency(category.availableFunds)}</p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">Expenditure</p>
                          <p className="text-lg font-bold text-red-600">{formatCurrency(category.expenditure)}</p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">Remaining Budget</p>
                          <p className={`text-lg font-bold ${category.remainingBudget < 0 ? 'text-red-600' : 'text-green-600'}`}>
                            {formatCurrency(category.remainingBudget)}
                          </p>
                        </div>
                        {(category.code === 'ATS' || category.code === 'ATO' || category.code === 'HMB') && (
                          <div>
                            <p className="text-sm text-muted-foreground">Committed Funds</p>
                            <p className="text-lg font-bold text-orange-600">{formatCurrency(category.committedFunds || 0)}</p>
                          </div>
                        )}
                      </div>

                      {category.services.length > 0 ? (
                        <div className="overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Date</TableHead>
                                <TableHead>Service</TableHead>
                                <TableHead>Provider</TableHead>
                                <TableHead>Unit</TableHead>
                                <TableHead className="text-right">Qty</TableHead>
                                <TableHead className="text-right">Unit Price</TableHead>
                                <TableHead className="text-right">Total</TableHead>
                                <TableHead className="text-right">Gov. Subsidy</TableHead>
                                <TableHead className="text-right">Participant</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {category.services.map((service) => (
                                <TableRow key={service.id}>
                                  <TableCell className="whitespace-nowrap">
                                    {formatDate(service.scheduledStart)}
                                  </TableCell>
                                  <TableCell>{service.service || service.taskName || service.notes || 'Service'}</TableCell>
                                  <TableCell>{service.serviceProvider || service.worker || 'N/A'}</TableCell>
                                  <TableCell>{service.unit}</TableCell>
                                  <TableCell className="text-right">{service.quantity}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(service.unitPrice)}</TableCell>
                                  <TableCell className="text-right font-medium">{formatCurrency(service.totalAmount)}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(service.govSubsidy)}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(service.participantContribution)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ) : (
                        <div className="text-center py-8 text-muted-foreground">
                          <AlertCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
                          <p>No services recorded for this budget category</p>
                        </div>
                      )}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            </Card>

            {/* All Service Details Table */}
            <Card className="p-6 shadow-lg print:shadow-none">
              <h3 className="text-xl font-semibold mb-4">All Service Details</h3>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Scheduled Date</TableHead>
                      <TableHead>Delivery Date</TableHead>
                      <TableHead>Service</TableHead>
                      <TableHead>Worker</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Funding Source</TableHead>
                      <TableHead>Unit</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Unit Price</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Gov. Subsidy</TableHead>
                      <TableHead className="text-right">Your Share</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statementData.services.length > 0 ? (
                      statementData.services.map((service) => (
                        <TableRow key={service.id}>
                          <TableCell className="whitespace-nowrap text-xs">
                            {formatDate(service.scheduledStart)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            {formatDate(service.actualEnd || service.actualStart)}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate">{service.service || service.taskName || service.notes || 'Service'}</TableCell>
                          <TableCell>{service.worker || 'N/A'}</TableCell>
                          <TableCell>
                            <Badge variant={service.transactionStatus === 'Delivered' ? 'default' : 'secondary'} className="text-xs">
                              {service.transactionStatus || 'Delivered'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">{service.fundingSource || 'Home Support'}</TableCell>
                          <TableCell className="text-xs">{service.unit}</TableCell>
                          <TableCell className="text-right">{service.quantity}</TableCell>
                          <TableCell className="text-right">{formatCurrency(service.unitPrice)}</TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(service.totalAmount)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(service.govSubsidy)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(service.participantContribution)}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                          No services found for the selected period
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
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

              {/* Important Notes */}
              <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                <h4 className="font-semibold text-sm mb-2 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" />
                  Important Information
                </h4>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                  <li>This statement shows all services delivered during the selected month.</li>
                  <li>Budget amounts are indicative and may vary based on your care plan.</li>
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
