export interface TimeEntry {
  id: string;
  taskName: string;
  startTime: string;
  endTime: string | null;
  duration: number; // in minutes
  location: {
    lat: number;
    lng: number;
    address: string;
  } | null;
  notes: string;
}