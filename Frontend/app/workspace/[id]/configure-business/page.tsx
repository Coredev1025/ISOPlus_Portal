"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Upload, Loader2, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Header } from "@/components/ui/header";
import axios from "@/app/utils/axiosConfig";
import {
  loadBusinessLogoPreviews,
  LOGO_FIELDS,
  revokeBlobUrl,
  type LogoField,
} from "@/lib/business-logo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { showSaveSuccessToast, showSaveErrorToast, showFetchSuccessToast, showFetchErrorToast } from "@/lib/toast-utils";
import {
  cloneDefaultSequences,
  extractDocumentNumberingSequences,
  mapBusinessProfileToFormData,
  type NumberSequence,
} from "@/lib/configure-business-helpers";

export default function ConfigureBusinessPage() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split("/")[2];
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [squareLogoFile, setSquareLogoFile] = useState<File | null>(null);
  const [wideLogoFile, setWideLogoFile] = useState<File | null>(null);
  const [defaultLogoPreview, setDefaultLogoPreview] = useState<string | null>(null);
  const [squareLogoPreview, setSquareLogoPreview] = useState<string | null>(null);
  const [wideLogoPreview, setWideLogoPreview] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [showError, setShowError] = useState(false);
  // Document number sequences (passthrough so Basic save does not clear Financial Settings)
  const [invoiceSequence, setInvoiceSequence] = useState<NumberSequence>(
    () => cloneDefaultSequences().invoice
  );
  const [purchaseOrderSequence, setPurchaseOrderSequence] =
    useState<NumberSequence>(() => cloneDefaultSequences().purchaseOrder);
  const [quoteSequence, setQuoteSequence] = useState<NumberSequence>(
    () => cloneDefaultSequences().quote
  );
  const [statementSequence, setStatementSequence] = useState<NumberSequence>(
    () => cloneDefaultSequences().statement
  );
  const [statementOfAccountSequence, setStatementOfAccountSequence] =
    useState<NumberSequence>(() => cloneDefaultSequences().statementOfAccount);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [apiError, setApiError] = useState<string>('');
  const [defaultLogoRemoved, setDefaultLogoRemoved] = useState(false);
  const [squareLogoRemoved, setSquareLogoRemoved] = useState(false);
  const [wideLogoRemoved, setWideLogoRemoved] = useState(false);
  const logoPreviewBlobUrls = useRef<Partial<Record<LogoField, string>>>({});

  const setLogoPreview = (
    field: LogoField,
    preview: string | null,
    options?: { revokePrevious?: boolean }
  ) => {
    if (options?.revokePrevious !== false) {
      revokeBlobUrl(logoPreviewBlobUrls.current[field]);
    }

    if (preview?.startsWith("blob:")) {
      logoPreviewBlobUrls.current[field] = preview;
    } else {
      delete logoPreviewBlobUrls.current[field];
    }

    switch (field) {
      case "defaultLogo":
        setDefaultLogoPreview(preview);
        break;
      case "squareLogo":
        setSquareLogoPreview(preview);
        break;
      case "wideLogo":
        setWideLogoPreview(preview);
        break;
    }
  };

  const applyLogoPreviews = async (
    business: Partial<Record<LogoField, string | null | undefined>>
  ) => {
    LOGO_FIELDS.forEach((field) => setLogoPreview(field, null));
    const previews = await loadBusinessLogoPreviews(id, business);
    (Object.entries(previews) as [LogoField, string][]).forEach(([field, preview]) => {
      setLogoPreview(field, preview, { revokePrevious: false });
    });
  };

  useEffect(() => {
    return () => {
      Object.values(logoPreviewBlobUrls.current).forEach((url) => revokeBlobUrl(url));
    };
  }, []);

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

  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    email: "",
    companyRegistrationId: "",
    street: "",
    country: "",
    suburb: "",
    state: "",
    postcode: "",
    abn: "",
    acn: "",
    workspaceId: id,
    bankAccountName: "",
    bankName: "",
    bsb: "",
    accountNumber: "",
    paymentReference: "",
    accountsReceivableTerms: "",
    accountsPayableTerms: "",
    headOfficeTimezone: "Australia/Sydney",
  });

  useEffect(() => {
    const abortController = new AbortController();

    const fetchBusinessProfile = async () => {
      try {
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
          {
            params: { workspaceId: id },
            signal: abortController.signal,
          }
        );

        if (!abortController.signal.aborted) {
          const data = response.data;
          setFormData(mapBusinessProfileToFormData(data, id));

          const sequences = extractDocumentNumberingSequences(data);
          setInvoiceSequence(sequences.invoice);
          setPurchaseOrderSequence(sequences.purchaseOrder);
          setQuoteSequence(sequences.quote);
          setStatementSequence(sequences.statement);
          setStatementOfAccountSequence(sequences.statementOfAccount);

          // Load logo previews via authenticated API (no expiring presigned URLs in UI)
          await applyLogoPreviews({
            defaultLogo: data.defaultLogo,
            squareLogo: data.squareLogo,
            wideLogo: data.wideLogo,
          });
          showFetchSuccessToast("Business profile");
        }
      } catch (error: any) {
        if (error.name == "CanceledError" || error.name == "AbortError") {
          return;
        }
        // New workspaces have no profile yet — empty form is expected, not an error toast.
        if (error.response?.status === 404) {
          return;
        }
        console.error("Failed to fetch business profile:", error);
        showFetchErrorToast("business profile", error.response?.data?.message || "Failed to load business profile");
      }
    };

    fetchBusinessProfile();

    return () => {
      abortController.abort();
    };
  }, [id]);

  const handleLogoChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    field: LogoField,
    setFile: React.Dispatch<React.SetStateAction<File | null>>
  ) => {
    const file = e.target.files?.[0];
    if (file) {
      setFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setLogoPreview(field, reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { id, value } = e.target;
    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      const formDataToSend = new FormData();
      Object.keys(formData).forEach((key) => {
        formDataToSend.append(key, formData[key as keyof typeof formData]);
      });
      formDataToSend.append('documentNumbering', JSON.stringify({
        invoice: invoiceSequence,
        purchaseOrder: purchaseOrderSequence,
        quote: quoteSequence,
        statement: statementSequence,
        statementOfAccount: statementOfAccountSequence,
      }));

      if (logoFile) {
        formDataToSend.append("defaultLogo", logoFile);
      }
      if (squareLogoFile) {
        formDataToSend.append("squareLogo", squareLogoFile);
      }
      if (wideLogoFile) {
        formDataToSend.append("wideLogo", wideLogoFile);
      }
      if (defaultLogoRemoved) {
        formDataToSend.append("defaultLogoRemoved", "true");
      }
      if (squareLogoRemoved) {
        formDataToSend.append("squareLogoRemoved", "true");
      }
      if (wideLogoRemoved) {
        formDataToSend.append("wideLogoRemoved", "true");
      }

      const response = await axios.put(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
        formDataToSend,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          }
        }
      );

      if (response.status === 200) {
        setShowError(false);
        setShowSuccess(true);
        setLogoFile(null);
        setSquareLogoFile(null);
        setWideLogoFile(null);
        setDefaultLogoRemoved(false);
        setSquareLogoRemoved(false);
        setWideLogoRemoved(false);
        await applyLogoPreviews({
          defaultLogo: response.data.defaultLogo,
          squareLogo: response.data.squareLogo,
          wideLogo: response.data.wideLogo,
        });
        showSaveSuccessToast("Business profile");
        setTimeout(() => setShowSuccess(false), 2000);
      }

    } catch (error: any) {
      setShowSuccess(false);
      const errorMessage = error.response?.data?.message || 'An unexpected error occurred';
      showSaveErrorToast("business profile", errorMessage);
      
      if (error.response?.data?.errors) {
        setErrors(error.response.data.errors);
      } else if (error.response?.data?.message) {
        setApiError(error.response.data.message);
      } else {
        setApiError('An unexpected error occurred');
      }
      setTimeout(() => {
        setErrors([]);
        setApiError('');
      }, 5000);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveLogo = (type: 'default' | 'square' | 'wide') => {
    switch (type) {
      case 'default':
        setLogoPreview('defaultLogo', null);
        setDefaultLogoRemoved(true);
        setLogoFile(null);
        break;
      case 'square':
        setLogoPreview('squareLogo', null);
        setSquareLogoRemoved(true);
        setSquareLogoFile(null);
        break;
      case 'wide':
        setLogoPreview('wideLogo', null);
        setWideLogoRemoved(true);
        setWideLogoFile(null);
        break;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button variant="ghost" className="mb-6" onClick={() => router.replace(`/workspace/${id}`)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Workspace
        </Button>

        <Card className="max-w-2xl mx-auto p-6">
          <h1 className="text-2xl font-bold mb-2">Configure Your Business</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            Bank details and document numbering are managed under{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => router.push(`/workspace/${id}/finance-settings?tab=financial`)}
            >
              Finance Settings & Automation
            </button>
            {"."}
          </p>

          <div className="space-y-6">
                <div className="space-y-4 border rounded-lg p-5">
                  <h3 className="text-lg font-semibold">Company Logos</h3>
                  <p className="text-sm text-muted-foreground">
                    Upload different logo formats for various uses throughout the application
                  </p>

                  <div className="border rounded-lg p-4">
                    <Tabs defaultValue="default" className="space-y-4">
                      <TabsList className="grid w-full grid-cols-3 gap-1">
                        <TabsTrigger value="default">Default Logo</TabsTrigger>
                        <TabsTrigger value="square">Square Logo</TabsTrigger>
                        <TabsTrigger value="wide">Wide Logo</TabsTrigger>
                      </TabsList>

                      <TabsContent value="default" className="pt-4">
                        <div className="flex items-center gap-4">
                          <div
                            className="w-32 h-32 border-2 border-dashed rounded-lg flex items-center justify-center bg-muted relative"
                          >
                            {defaultLogoPreview ? (
                              <>
                                <img
                                  src={defaultLogoPreview}
                                  alt="Default Logo Preview"
                                  className="w-full h-full object-contain"
                                />
                                <button
                                  type="button"
                                  className="absolute top-[0px] right-[0px] bg-white rounded-full p-1 shadow hover:bg-red-100 z-10"
                                  onClick={() => handleRemoveLogo('default')}
                                  aria-label="Remove Default Logo"
                                >
                                  <X className="w-4 h-4 text-destructive" />
                                </button>
                              </>
                            ) : (
                              <Upload className="h-8 w-8 text-muted-foreground" />
                            )}
                          </div>
                          <div>
                            <h4 className="text-sm font-medium mb-2">Default Logo</h4>
                            <Input
                              type="file"
                              accept="image/*"
                              onChange={(e) => handleLogoChange(e, 'defaultLogo', setLogoFile)}
                              className="max-w-xs"
                            />
                            <p className="text-sm text-muted-foreground mt-2">
                              Maximum file size: 5MB
                            </p>
                            <p className="text-sm text-muted-foreground mt-1">
                              Used for general application areas, profile displays, and generated PDF documents
                            </p>
                          </div>
                        </div>
                      </TabsContent>

                      <TabsContent value="square" className="pt-4">
                        <div className="flex items-center gap-4">
                          <div
                            className="w-32 h-32 border-2 border-dashed rounded-lg flex items-center justify-center bg-muted relative"
                          >
                            {squareLogoPreview ? (
                              <>
                                <img
                                  src={squareLogoPreview}
                                  alt="Square Logo Preview"
                                  className="w-full h-full object-contain"
                                />
                                <button
                                  type="button"
                                  className="absolute top-[0px] right-[0px] bg-white rounded-full p-1 shadow hover:bg-red-100 z-10"
                                  onClick={() => handleRemoveLogo('square')}
                                  aria-label="Remove Square Logo"
                                >
                                  <X className="w-4 h-4 text-destructive" />
                                </button>
                              </>
                            ) : (
                              <Upload className="h-8 w-8 text-muted-foreground" />
                            )}
                          </div>
                          <div>
                            <h4 className="text-sm font-medium mb-2">Square Logo</h4>
                            <Input
                              type="file"
                              accept="image/*"
                              onChange={(e) => handleLogoChange(e, 'squareLogo', setSquareLogoFile)}
                              className="max-w-xs"
                            />
                            <p className="text-sm text-muted-foreground mt-2">
                              Recommended size: 512x512px
                            </p>
                            <p className="text-sm text-muted-foreground mt-1">
                              Used for online forms
                            </p>
                          </div>
                        </div>
                      </TabsContent>

                      <TabsContent value="wide" className="pt-4">
                        <div className="flex items-center gap-4">
                          <div
                            className="w-48 h-24 border-2 border-dashed rounded-lg flex items-center justify-center bg-muted relative"
                          >
                            {wideLogoPreview ? (
                              <>
                                <img
                                  src={wideLogoPreview}
                                  alt="Wide Logo Preview"
                                  className="w-full h-full object-contain"
                                />
                                <button
                                  type="button"
                                  className="absolute top-[0px] right-[0px] bg-white rounded-full p-1 shadow hover:bg-red-100 z-10"
                                  onClick={() => handleRemoveLogo('wide')}
                                  aria-label="Remove Wide Logo"
                                >
                                  <X className="w-4 h-4 text-destructive" />
                                </button>
                              </>
                            ) : (
                              <Upload className="h-8 w-8 text-muted-foreground" />
                            )}
                          </div>
                          <div>
                            <h4 className="text-sm font-medium mb-2">Wide Logo</h4>
                            <Input
                              type="file"
                              accept="image/*"
                              onChange={(e) => handleLogoChange(e, 'wideLogo', setWideLogoFile)}
                              className="max-w-xs"
                            />
                            <p className="text-sm text-muted-foreground mt-2">
                              Recommended size: 820 x 312 pixels, with your logo centred within the middle third of the document area
                            </p>
                            <p className="text-sm text-muted-foreground mt-1">
                              Used for online documents
                            </p>
                          </div>
                        </div>
                      </TabsContent>
                    </Tabs>
                  </div>
                </div>

                <div className="space-y-4 border rounded-lg p-5">
                  <h3 className="text-lg font-semibold">Business Details</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Company Name</Label>
                      <Input
                        id="name"
                        placeholder="Enter company name"
                        value={formData.name}
                        onChange={handleInputChange}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="companyRegistrationId">Company Registration ID</Label>
                      <Input
                        id="companyRegistrationId"
                        placeholder="NDIS of Aged Care Provider ID"
                        value={formData.companyRegistrationId}
                        onChange={handleInputChange}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="phone">Phone Number</Label>
                      <Input
                        id="phone"
                        placeholder="Enter phone number"
                        value={formData.phone}
                        onChange={handleInputChange}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="email">Business Email</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="Enter business email"
                        value={formData.email}
                        onChange={handleInputChange}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="headOfficeTimezone">Head Office Timezone</Label>
                    <Select
                      value={formData.headOfficeTimezone}
                      onValueChange={(value) =>
                        setFormData((prevData) => ({
                          ...prevData,
                          headOfficeTimezone: value,
                        }))
                      }
                    >
                      <SelectTrigger id="headOfficeTimezone">
                        <SelectValue placeholder="Select timezone" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Australia/Sydney">Australia/Sydney (AEST/AEDT)</SelectItem>
                        <SelectItem value="Australia/Melbourne">Australia/Melbourne (AEST/AEDT)</SelectItem>
                        <SelectItem value="Australia/Brisbane">Australia/Brisbane (AEST)</SelectItem>
                        <SelectItem value="Australia/Adelaide">Australia/Adelaide (ACST/ACDT)</SelectItem>
                        <SelectItem value="Australia/Darwin">Australia/Darwin (ACST)</SelectItem>
                        <SelectItem value="Australia/Perth">Australia/Perth (AWST)</SelectItem>
                        <SelectItem value="Australia/Hobart">Australia/Hobart (AEST/AEDT)</SelectItem>
                        <SelectItem value="Pacific/Auckland">Pacific/Auckland (NZST/NZDT)</SelectItem>
                        <SelectItem value="UTC">UTC</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      Used to display invoice item dates and times in your local time
                    </p>
                  </div>
                </div>

                <div className="space-y-4  border rounded-lg p-5">
                  <h3 className="text-lg font-semibold">Business Address</h3>
                  <div className="space-y-2">
                    <Label htmlFor="country">Country</Label>
                    <Select
                      value={formData.country}
                      onValueChange={(value) =>
                        setFormData((prevData) => ({
                          ...prevData,
                          country: value,
                        }))
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
                    <Label htmlFor="street">Street Address</Label>
                    <Input
                      id="street"
                      placeholder="Enter street address"
                      value={formData.street}
                      onChange={handleInputChange}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="suburb">Suburb</Label>
                      <Input
                        id="suburb"
                        placeholder="Enter city"
                        value={formData.suburb}
                        onChange={handleInputChange}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="state">State</Label>
                      <Select
                        value={formData.state}
                        onValueChange={(value) =>
                          setFormData((prevData) => ({
                            ...prevData,
                            state: value,
                          }))
                        }
                      >
                        <SelectTrigger id="state">
                          <SelectValue placeholder="Select state" />
                        </SelectTrigger>
                        <SelectContent>
                          {countryStates[formData.country]?.map((state: string) => (
                            <SelectItem key={state} value={state}>
                              {state}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="postcode">Postcode</Label>
                    <Input
                      id="postcode"
                      placeholder="Enter postcode"
                      maxLength={8}
                      value={formData.postcode}
                      onChange={handleInputChange}
                    />
                  </div>
                </div>

                <div className="space-y-4  border rounded-lg p-5">
                  <h3 className="text-lg font-semibold">Business Numbers</h3>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="abn">Australian Business Number (ABN)</Label>
                      <Input
                        id="abn"
                        placeholder="Enter ABN"
                        maxLength={11}
                        value={formData.abn}
                        onChange={handleInputChange}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="acn">Australian Company Number (ACN)</Label>
                      <Input
                        id="acn"
                        placeholder="Enter ACN"
                        maxLength={9}
                        value={formData.acn}
                        onChange={handleInputChange}
                      />
                    </div>
                  </div>
                </div>
          </div>

          <div className="mt-6">
            {errors.length > 0 && (
              <div className="mb-4 p-4 bg-destructive/10 border border-destructive rounded-md">
                <h4 className="text-sm font-medium text-destructive mb-2">Please correct the following errors:</h4>
                <ul className="list-disc list-inside space-y-1">
                  {errors.map((error, index) => (
                    <li key={index} className="text-sm text-destructive">
                      {error}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {apiError && (
              <div className="mb-4 p-4 bg-destructive/10 border border-destructive rounded-md">
                <p className="text-sm text-destructive">{apiError}</p>
              </div>
            )}

            {showSuccess && (
              <div className="mb-4 p-4 bg-green-100 border border-green-500 rounded-md">
                <p className="text-sm text-green-700">Business profile saved successfully!</p>
              </div>
            )}

            <Button
              className="w-full"
              size="lg"
              onClick={handleSave}
              disabled={loading}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </span>
              ) : (
                'Save Business Configuration'
              )}
            </Button>
          </div>
        </Card>
      </div >

    </div >
  );
}
