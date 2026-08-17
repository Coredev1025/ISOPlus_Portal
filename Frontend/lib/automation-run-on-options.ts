export type AutomationUnit = "day" | "week" | "month" | "quarter" | "year";

export type RunOnKind = "none" | "weekday" | "day-of-month" | "month-day";

export type RunOnOption = { value: string | number; label: string };

const WEEKDAYS: RunOnOption[] = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" },
];

// 1-31, per the spec's picker. Days 29-31 do not skip short months: the
// scheduler clamps to the month's last day (Backend automationScheduleHelpers
// addMonthsClamped), so "the 31st" fires on 30 Apr and 28/29 Feb.
const DAYS_OF_MONTH: RunOnOption[] = Array.from({ length: 31 }, (_, i) => ({
  value: i + 1,
  label: String(i + 1),
}));

const MONTHS: RunOnOption[] = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
].map((label, i) => ({ value: i + 1, label }));

export function runOnOptionsForUnit(unit: AutomationUnit): {
  kind: RunOnKind;
  options: RunOnOption[];
  months?: RunOnOption[];
} {
  if (unit === "day") return { kind: "none", options: [] };
  if (unit === "week") return { kind: "weekday", options: WEEKDAYS };
  if (unit === "month") return { kind: "day-of-month", options: DAYS_OF_MONTH };
  return { kind: "month-day", options: DAYS_OF_MONTH, months: MONTHS };
}

export function defaultRunOnForUnit(unit: AutomationUnit) {
  if (unit === "day") return null;
  if (unit === "week") return "monday";
  if (unit === "month") return 1;
  return { month: 1, day: 1 };
}
