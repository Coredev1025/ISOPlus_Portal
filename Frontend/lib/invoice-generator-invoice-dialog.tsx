'use client';

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import Spinner from "@/components/ui/spin";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Calendar, Receipt, DollarSign, CheckCircle, FileText } from "lucide-react";
import type { InvoiceGeneratorServiceRecord } from "@/lib/invoice-generator-types";


export function InvoiceGeneratorInvoiceDialog(props: {
  showInvoiceModal: boolean;
  setShowInvoiceModal: (open: boolean) => void;
  setSelectedItems: (items: Set<string>) => void;
  setEligibleRecords: (records: InvoiceGeneratorServiceRecord[]) => void;
  isLowCatBoard: boolean;
  invoiceDate: string;
  setInvoiceDate: (value: string) => void;
  dueDate: string;
  setDueDate: (value: string) => void;
  eligibleRecords: InvoiceGeneratorServiceRecord[];
  selectedItems: Set<string>;
  handleSelectAll: () => void;
  formatCurrency: (value: number) => string;
  getInvoiceAmount: (record: InvoiceGeneratorServiceRecord) => number;
  loadingEligible: boolean;
  handleToggleItem: (id: string) => void;
  formatDate: (value?: string | null) => string;
  isNdisBoard: boolean;
  handleGeneratePDFInvoice: () => void | Promise<void>;
  generatingPDF: boolean;
  generatingXero: boolean;
  handleGenerateXeroInvoice: () => void | Promise<void>;
}) {
  const {
    showInvoiceModal, setShowInvoiceModal, setSelectedItems, setEligibleRecords,
    isLowCatBoard, invoiceDate, setInvoiceDate, dueDate, setDueDate,
    eligibleRecords, selectedItems, handleSelectAll, formatCurrency, getInvoiceAmount,
    loadingEligible, handleToggleItem, formatDate, isNdisBoard,
    handleGeneratePDFInvoice, generatingPDF, generatingXero,
    handleGenerateXeroInvoice,
  } = props;

  return (
        <Dialog open={showInvoiceModal} onOpenChange={(open) => {
          setShowInvoiceModal(open);
          if (!open) {
            // Reset selections when modal closes
            setSelectedItems(new Set());
            setEligibleRecords([]);
          }
        }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Receipt className="h-5 w-5" />
                Generate Invoice
              </DialogTitle>
              <DialogDescription>
                {isLowCatBoard 
                  ? 'Select items and enter invoice details to generate a tax invoice'
                  : 'Select items and enter invoice details to generate a participant tax invoice'}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-row gap-6 py-4 items-end">
              {/* Invoice Date */}
              <div className="flex-1 min-w-[200px]">
                <Label htmlFor="invoiceDate" className="flex items-center gap-2 mb-1">
                  <Calendar className="h-4 w-4" /> Invoice Date
                </Label>
                <Input
                  id="invoiceDate"
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className="w-full"
                />
              </div>
              {/* Due Date */}
              <div className="flex-1 min-w-[200px]">
                <Label htmlFor="dueDate" className="flex items-center gap-2 mb-1">
                  <Calendar className="h-4 w-4" /> Due Date
                </Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full"
                />
              </div>
            </div>

            {/* Eligible Records Section */}
            {showInvoiceModal && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-semibold">Eligible Records</h3>
                    {eligibleRecords.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleSelectAll}
                        className="h-8 text-xs"
                      >
                        {selectedItems.size === eligibleRecords.length ? 'Deselect All' : 'Select All'}
                      </Button>
                    )}
                  </div>
                  <Badge variant="secondary" className="text-lg px-3 py-1">
                    <DollarSign className="h-4 w-4 mr-1" />
                    Total: {formatCurrency(eligibleRecords
                      .filter((r: InvoiceGeneratorServiceRecord) => selectedItems.has(r.id))
                      .reduce((sum: number, record: InvoiceGeneratorServiceRecord) => sum + getInvoiceAmount(record), 0))}
                    {' '}
                    ({selectedItems.size} selected)
                  </Badge>
                </div>

                {loadingEligible ? (
                  <div className="flex items-center justify-center py-8">
                    <Spinner />
                    <span className="ml-2">Loading eligible records...</span>
                  </div>
                ) : eligibleRecords.length > 0 ? (
                  <div className="border rounded-lg p-4 max-h-60 overflow-y-auto bg-muted/30">
                    <div className="space-y-2">
                      {eligibleRecords.map((record) => (
                        <div
                          key={record.id}
                          className={`flex items-start gap-3 py-2 border-b last:border-0 hover:bg-muted/50 rounded px-2 cursor-pointer ${record?.invoiceNumber && record?.invoiceNumber !== '' && record?.invoiceNumber !== undefined ? 'bg-green-50/50 border-l-4 border-l-green-500' : ''
                            }`}
                          onClick={() => handleToggleItem(record.id)}
                        >
                          <Checkbox
                            checked={selectedItems.has(record.id)}
                            onCheckedChange={() => handleToggleItem(record.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1"
                          />
                          <div className="flex-1 flex justify-between items-center">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <p className="font-medium">{record?.service || record?.notes || 'Service'}</p>
                                {record?.invoiceNumber && record?.invoiceNumber !== '' && record?.invoiceNumber !== undefined && (
                                  <Badge variant="outline" className="bg-green-100 text-green-800 border-green-300 text-xs">
                                    <CheckCircle className="h-3 w-3 mr-1" />
                                    Invoiced
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {record.scheduledServiceDate ? formatDate(record.scheduledServiceDate) : 'N/A'} • {record.quantity} {record.unit}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="font-semibold">{formatCurrency(getInvoiceAmount(record))}</p>
                              <p className="text-xs text-muted-foreground">
                                {(isLowCatBoard || isNdisBoard) ? 'Total' : 'Contribution'}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
                    <p>No eligible records found matching your filters.</p>
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowInvoiceModal(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleGeneratePDFInvoice}
                disabled={!selectedItems.size || generatingPDF || generatingXero}
                className="gap-2"
              >
                {generatingPDF ? (
                  <>
                    <Spinner />
                    Generating...
                  </>
                ) : (
                  <>
                    <Receipt className="h-4 w-4" />
                    Generate PDF Invoice
                  </>
                )}
              </Button>
              <Button
                onClick={handleGenerateXeroInvoice}
                disabled={!selectedItems.size || generatingPDF || generatingXero}
                variant="secondary"
                className="gap-2"
              >
                {generatingXero ? (
                  <>
                    <Spinner />
                    Generating...
                  </>
                ) : (
                  <>
                    <FileText className="h-4 w-4" />
                    Generate Xero Invoice
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
  );
}
