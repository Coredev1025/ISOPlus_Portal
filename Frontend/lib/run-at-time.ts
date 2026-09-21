import type { AutomationSelectOption } from "@/lib/automation-schedule-block";

/**
 * The Run At field on a 12-hour clock (KAN-263).
 *
 * The picker shows hour / minute / AM-PM, but the value stored and sent is
 * unchanged: `HH:mm` on a 24-hour clock, which is what the backend's
 * RUN_AT_PATTERN validates and what the scheduler computes slots from. These
 * two functions are the entire conversion, kept pure and apart from the
 * component so the midnight and noon corners can be tested without a DOM.
 */
export type RunAtParts = {
  /** "1".."12", unpadded — the value of the hour select. */
  hour: string;
  /** "00".."59", padded. */
  minute: string;
  meridiem: "AM" | "PM";
};

/** The field's own fallback, matching DEFAULT_BLOCK.runAt. */
const FALLBACK: RunAtParts = { hour: "9", minute: "00", meridiem: "AM" };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * `HH:mm` split into what the three selects show.
 *
 * An unreadable value falls back rather than throwing or blanking the field:
 * a blank select would post an empty runAt on the next save and silently
 * retime the client's automation. 0 is 12 AM and 12 is 12 PM — the two corners
 * a naive `hour % 12` gets wrong in opposite directions.
 */
export function parseRunAt(value: string): RunAtParts {
  const match = HHMM.exec(String(value ?? ""));
  if (!match) return { ...FALLBACK };

  const hour24 = Number(match[1]);
  const meridiem = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return { hour: String(hour12), minute: match[2], meridiem };
}

/**
 * The three selects back into `HH:mm`.
 *
 * Padded on the way out because the backend pattern requires two digits in
 * both halves — "9:5" is not a time the scheduler will accept.
 */
export function toRunAt({ hour, minute, meridiem }: RunAtParts): string {
  const hour12 = Number(hour) % 12;
  const hour24 = meridiem === "PM" ? hour12 + 12 : hour12;
  return `${String(hour24).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
}

/** 12 first, the way a clock face reads. */
export const HOUR_OPTIONS: readonly AutomationSelectOption[] = Object.freeze(
  [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((hour) => ({
    value: String(hour),
    label: String(hour),
  })),
);

/**
 * Every minute, not five-minute steps.
 *
 * The native `<input type="time">` this replaces accepted any minute, so a
 * workspace already scheduled on 09:07 would find its own value missing from
 * the list — and be moved off it by the next save.
 */
export const MINUTE_OPTIONS: readonly AutomationSelectOption[] = Object.freeze(
  Array.from({ length: 60 }, (_, minute) => {
    const padded = String(minute).padStart(2, "0");
    return { value: padded, label: padded };
  }),
);

export const MERIDIEM_OPTIONS: readonly AutomationSelectOption[] = Object.freeze([
  { value: "AM", label: "AM" },
  { value: "PM", label: "PM" },
]);
