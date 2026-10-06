/**
 * The Run At field on a 12-hour clock (KAN-263).
 *
 * The spinner shows hour / minute / AM-PM, but the value stored and sent is
 * unchanged: `HH:mm` on a 24-hour clock, which is what the backend's
 * RUN_AT_PATTERN validates and what the scheduler computes slots from. These
 * two functions are the entire conversion, kept pure and apart from the
 * component so the midnight and noon corners can be tested without a DOM.
 */
export type RunAtParts = {
  /** "1".."12", unpadded — what the hour column shows. */
  hour: string;
  /** "00".."59", padded. */
  minute: string;
  meridiem: "AM" | "PM";
};

/** The field's own fallback, matching DEFAULT_BLOCK.runAt. */
const FALLBACK: RunAtParts = { hour: "9", minute: "00", meridiem: "AM" };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * `HH:mm` split into what the three spinner columns show.
 *
 * An unreadable value falls back rather than throwing or blanking the field:
 * a blank field would post an empty runAt on the next save and silently
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
 * The three spinner columns back into `HH:mm`.
 *
 * Padded on the way out because the backend pattern requires two digits in
 * both halves — "9:5" is not a time the scheduler will accept.
 */
export function toRunAt({ hour, minute, meridiem }: RunAtParts): string {
  const hour12 = Number(hour) % 12;
  const hour24 = meridiem === "PM" ? hour12 + 12 : hour12;
  return `${String(hour24).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
}

/** One column of the spinner. */
export type RunAtField = keyof RunAtParts;

const wrap = (value: number, size: number) => ((value % size) + size) % size;

/**
 * One click of a spinner arrow: the given column moves by `direction`, and
 * wraps rather than stopping at an end.
 *
 * Each column spins on its own — 59 → 00 leaves the hour alone — which is how
 * the ISO+ "Scheduled Shift Start" picker this copies behaves, and it means a
 * minute arrow can never move the time by an hour as a side effect.
 */
export function stepRunAt(parts: RunAtParts, field: RunAtField, direction: 1 | -1): RunAtParts {
  if (field === "meridiem") {
    return { ...parts, meridiem: parts.meridiem === "AM" ? "PM" : "AM" };
  }
  if (field === "minute") {
    return { ...parts, minute: String(wrap(Number(parts.minute) + direction, 60)).padStart(2, "0") };
  }
  // 1..12 on the face, so step in 0..11 and add the 1 back.
  return { ...parts, hour: String(wrap(Number(parts.hour) - 1 + direction, 12) + 1) };
}
