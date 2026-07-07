"use client";

import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Card } from "@/components/ui/card";
import { Calendar, Download } from "lucide-react";
import { Header } from "@/components/ui/header";
import { ResyncDataButton } from "@/components/ui/resync-data-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Spinner from "@/components/ui/spin";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MonthlyStatementStatementPanel } from "@/lib/monthly-statement-page-components";

type ViewProps = Record<string, any>;

function MonthlyStatementToolbar({
  router,
  id,
  boardId,
  isPrintMode,
  loadingParticipants,
  uniqueParticipants,
  selectedParticipant,
  setSelectedParticipant,
  months,
  selectedMonth,
  setSelectedMonth,
  years,
  selectedYear,
  setSelectedYear,
  handleManualSync,
  isManualSyncing,
  syncStatuses,
  setShowHelpDialog,
  fetchStatementData,
  loading,
  exportingSection,
}: ViewProps) {
  if (isPrintMode) {
    return null;
  }

  return (
    <>
      <BackButton onClick={() => router.push(`/workspace/${id}/board/${boardId}`)}>
        Back to Board
      </BackButton>

      <div className="mb-8 animate-fade-in-up">
        <h1 className="mb-2 text-3xl font-bold tracking-tight text-foreground">Monthly Statement Generator</h1>
        <p className="text-muted-foreground">
          Manage participants&apos; budget and service records, and generate the Support at Home monthly statement.
        </p>
      </div>

      <Card className="card-hover mb-6 p-6 shadow-lg print:hidden">
        <div className="flex flex-nowrap items-end gap-4 overflow-x-auto pb-2">
          <div className="min-w-[200px] flex-shrink-0 space-y-2">
            <Label className="text-sm font-medium">Participant</Label>
            <Select value={selectedParticipant} onValueChange={setSelectedParticipant} disabled={loadingParticipants}>
              <SelectTrigger>
                <SelectValue placeholder={loadingParticipants ? "Loading participants..." : "Select participant"} />
              </SelectTrigger>
              <SelectContent>
                {loadingParticipants ? (
                  <SelectItem value="loading" disabled>Loading...</SelectItem>
                ) : uniqueParticipants.length > 0 ? (
                  uniqueParticipants.map((participant: string) => (
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

          <div className="min-w-[160px] flex-shrink-0 space-y-2">
            <Label className="text-sm font-medium">Month</Label>
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger>
                <SelectValue placeholder="Select month" />
              </SelectTrigger>
              <SelectContent>
                {months.map((month: { value: string; label: string }) => (
                  <SelectItem key={month.value} value={month.value}>
                    {month.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-[120px] flex-shrink-0 space-y-2">
            <Label className="text-sm font-medium">Year</Label>
            <Select value={selectedYear} onValueChange={setSelectedYear}>
              <SelectTrigger>
                <SelectValue placeholder="Select year" />
              </SelectTrigger>
              <SelectContent>
                {years.map((year: string) => (
                  <SelectItem key={year} value={year}>
                    {year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-shrink-0">
            <ResyncDataButton
              onSync={handleManualSync}
              onHelp={() => setShowHelpDialog(true)}
              isSyncing={isManualSyncing}
              disabled={syncStatuses.some((sync: { boardId: string; status: string }) => sync.boardId === boardId && (sync.status === 'started' || sync.status === 'in-progress'))}
            />
          </div>

          <div className="flex-shrink-0">
            <Button
              className="h-10 min-w-[148px]"
              onClick={fetchStatementData}
              disabled={loading || exportingSection === 'statement-pdf' || !selectedParticipant || !selectedMonth || !selectedYear}
            >
              <span className="inline-flex items-center justify-center gap-2">
                {loading && exportingSection !== 'statement-pdf' ? (
                  <Spinner className="h-4 w-4" />
                ) : null}
                <span>Load Statement</span>
              </span>
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

function MonthlyStatementEmptyState({ statementData, loading }: ViewProps) {
  if (statementData || loading) {
    return null;
  }

  return (
    <Card className="card-hover p-12 text-center shadow-lg">
      <div className="flex flex-col items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Calendar className="h-8 w-8 text-primary" />
        </div>
        <div>
          <h3 className="mb-2 text-xl font-semibold">No Statement Loaded</h3>
          <p className="text-muted-foreground">
            Select a participant, month, and year above to generate the monthly statement
          </p>
        </div>
      </div>
    </Card>
  );
}

function MonthlyStatementDialogs({
  showHelpDialog,
  setShowHelpDialog,
  showBusinessDialog,
  setShowBusinessDialog,
  businessDetailsErrors,
  businessDetails,
  setBusinessDetails,
  countryStates,
  handleSaveBusinessDetails,
}: ViewProps) {
  return (
    <>
      <Dialog open={showHelpDialog} onOpenChange={setShowHelpDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>Resync Data</span>
            </DialogTitle>
            <DialogDescription>Understanding how resync works</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <Download className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium">Resync Data</p>
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
                  {businessDetailsErrors.map((error: string, index: number) => (
                    <li key={index} className="text-sm text-destructive">{error}</li>
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
                placeholder="Enter registration ID"
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
              <Label htmlFor="country">Country</Label>
              <Select
                value={businessDetails.country}
                onValueChange={(value) => setBusinessDetails({ ...businessDetails, country: value, state: '' })}
              >
                <SelectTrigger id="country">
                  <SelectValue placeholder="Select country" />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(countryStates).map((country) => (
                    <SelectItem key={country} value={country}>{country}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="state">State / Province</Label>
              <Select
                value={businessDetails.state}
                onValueChange={(value) => setBusinessDetails({ ...businessDetails, state: value })}
                disabled={!businessDetails.country || countryStates[businessDetails.country]?.length === 0}
              >
                <SelectTrigger id="state">
                  <SelectValue
                    placeholder={
                      !businessDetails.country
                        ? 'Select country first'
                        : countryStates[businessDetails.country]?.length === 0
                          ? 'No states available'
                          : 'Select state'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {businessDetails.country && countryStates[businessDetails.country]?.map((state: string) => (
                    <SelectItem key={state} value={state}>{state}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            <Button variant="outline" onClick={() => setShowBusinessDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveBusinessDetails}>Save Details</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MonthlyStatementPrintStyles() {
  return (
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
  );
}

export function MonthlyStatementPageView(props: ViewProps) {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto animate-fade-in-up py-8">
        <div className="page-enter-stagger">
          <MonthlyStatementToolbar {...props} />
          <MonthlyStatementStatementPanel {...props} />
          <MonthlyStatementEmptyState {...props} />
        </div>
      </div>
      <MonthlyStatementDialogs {...props} />
      <MonthlyStatementPrintStyles />
    </div>
  );
}
