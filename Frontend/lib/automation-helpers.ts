import { format, isValid, parseISO } from "date-fns";
import { EMAIL_TEXT_FIELDS } from "@/constants/automation";
import { EMAIL_PATTERN } from "@/constants/validation";
import type {
  AutomationBlock,
  AutomationRecentDocument,
  AutomationSettings,
} from "@/lib/automation-settings";

/**
 * Pure logic behind the invoice/statement automation panel, kept out of the
 * component modules so it can be reasoned about and tested on its own.
 *
 * Consumers: lib/automation-schedule-block.tsx, lib/automation-status-panel.tsx,
 * lib/invoice-statement-automation-panel.tsx.
 */

/**
 * nextRun and lastRunAt are real instants, so they are shown in the reader's
 * local time. Shared by the schedule block's read-only Next Run field and the
 * status panel, which must not disagree about how a run is spelled.
 */
export function formatNextRun(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, "dd/MM/yyyy 'at' h:mm a") : "—";
}

const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * startDate is a Date on the server, so a GET returns a full ISO instant, and
 * <input type="date"> silently blanks anything that is not yyyy-mm-dd. The
 * date portion is sliced rather than parsed on purpose: the stored value is
 * midnight UTC, and parsing it into local time would roll the calendar day
 * back for every user west of Greenwich. Mirror of the `|| null` on the way
 * back out.
 */
export function toDateInputValue(startDate: string | null | undefined): string {
  if (!startDate) return "";
  const datePart = startDate.slice(0, 10);
  return DATE_INPUT_PATTERN.test(datePart) ? datePart : "";
}

/**
 * The PDF's file name is an S3 naming convention, not an interface: a backend
 * rename would silently degrade every label with nothing failing on either
 * side, and a UUID-keyed path would show the reader a hash. So it is the last
 * resort, behind whatever structured fields the API sends, and an
 * undecodable or absent basename falls through rather than naming a link ''.
 */
function basenameLabel(pdfUrl: string): string {
  const basename = pdfUrl.split("/").pop() ?? "";
  if (!basename) return "";
  try {
    return decodeURIComponent(basename).replace(/\.pdf$/i, "");
  } catch {
    return "";
  }
}

export function recentDocumentLabel(doc: AutomationRecentDocument): string {
  return doc.invoiceNumber || doc.participant || basenameLabel(doc.pdfUrl) || doc.type;
}

/**
 * Whether the last run of this block went wrong. The API reports that either
 * as the scheduler's error message or — for callers that do not surface the
 * message — as a coarse flag or failure count, and all three mean the same
 * thing to the badge. Reading only one of them is how a field rename turns the
 * warning off without anything failing.
 */
export function blockNeedsAttention(block: AutomationBlock): boolean {
  return (
    Boolean(block.lastRunError) ||
    block.lastRunFailed === true ||
    (block.consecutiveFailures ?? 0) > 0
  );
}

/** Derived from EMAIL_TEXT_FIELDS so a new address field is validated too. */
const EMAIL_FIELD_KEYS = EMAIL_TEXT_FIELDS.filter((field) => field.isEmail).map(
  (field) => field.key
);

function blockHasInvalidEmail(block: AutomationBlock): boolean {
  return EMAIL_FIELD_KEYS.some(
    (key) => block[key] !== "" && !EMAIL_PATTERN.test(block[key])
  );
}

/**
 * Only enabled blocks are checked: a disabled block renders none of its email
 * fields, so a malformed address stored in one could never be corrected and
 * would leave Save permanently dead.
 */
export function hasInvalidEmail(settings: AutomationSettings): boolean {
  return [settings.invoice, settings.statement].some(
    (block) => block.enabled && blockHasInvalidEmail(block)
  );
}
