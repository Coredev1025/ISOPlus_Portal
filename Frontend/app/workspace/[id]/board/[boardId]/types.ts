export interface TimeEntry {
  id: string;
  taskName: string;
  startTime: string;
  endTime: string | null;
  duration: number; // in seconds
  location: {
    lat: number;
    lng: number;
    address: string;
  } | null;
  userId: string;
  userName: string;
  notes: string;
}

export interface TrackingTask {
  id: string;
  name: string;
  location?: {
    latitude: number;
    longitude: number;
    address: string;
  };
}

export interface ServiceRecord {
  id: string;
  status: 'invoiced' | 'pending';
  participant: string;
  scheduledStart: string;
  deliveryDate?: string;
  worker: string;
  unit: 'Hours' | 'Item';
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  govSubsidy: number;
  participantContribution: number;
  notes: string;
}

export interface InvoiceSummary {
  totalRecords: number;
  invoiced: number;
  pending: number;
  totalValue: number;
}