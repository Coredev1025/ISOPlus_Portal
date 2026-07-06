export interface InvoiceGeneratorServiceRecord {
  id: string;
  sourceItemId?: string;
  status: 'invoiced' | 'pending';
  participant: string;
  scheduledServiceDate: string | null;
  serviceDeliveryDate?: string | null;
  jobStatus?: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  govSubsidy: number;
  participantContribution: number;
  notes: string;
  service: string;
  gst?: string;
  invoiceNumber?: string;
  transactionStatus?: string;
  paymentStatus?: string;
  fundingSource?: string;
  fileUrl?: string;
  itemFirstPayment?: string;
  careRecipientIdentifier?: string;
  serviceIdentifier?: string;
  deliveredByThirdParty?: string;
  itemOrWraparound?: string;
  itemDescriptionCode?: string;
  itemDescription?: string;
  wraparoundDescription?: string;
  wraparoundDescriptionCode?: string;
  prescribedItem?: string;
  itemPurchasedMethod?: string;
  loanedByOrganisationName?: string;
  loanedByInvoiceNumber?: string;
  healthProfessionalTypeCode?: string;
  healthProfessionalTypeOther?: string;
  values?: Array<{ attribute: { name: string }; data?: unknown }>;
}

export interface InvoiceGeneratorSummary {
  totalRecords: number;
  invoiced: number;
  pending: number;
  totalValue: number;
  totalGovSubsidy: number;
  totalParticipantContribution: number;
}
