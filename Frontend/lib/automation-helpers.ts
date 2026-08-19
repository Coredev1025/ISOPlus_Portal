import { format, isValid, parseISO } from "date-fns";
import {
  DEFAULT_DELIVERY_STATE,
  DELIVERY_STATE_BADGES,
  EMAIL_TEXT_FIELDS,
} from "@/constants/automation";
import { EMAIL_PATTERN } from "@/constants/validation";
import type {
  AutomationBlock,
  AutomationRecentDocument,
  AutomationSettings,
} from "@/lib/automation-settings";

/**
 * Shared by the schedule block's read-only Next Run field and the status panel,
 * which must not disagree about how a run is spelled.
 */
export function formatNextRun(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, "dd/MM/yyyy 'at' h:mm a") : "—";
}

const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A GET returns startDate as a full ISO instant, and <input type="date">
 * silently blanks anything that is not yyyy-mm-dd. Sliced rather than parsed:
 * the stored value is midnight UTC, so parsing it into local time would roll
 * the calendar day back for every user west of Greenwich.
 */
export function toDateInputValue(startDate: string | null | undefined): string {
  if (!startDate) return "";
  const datePart = startDate.slice(0, 10);
  return DATE_INPUT_PATTERN.test(datePart) ? datePart : "";
}

/**
 * Last resort, behind the structured fields: the PDF's file name is an S3
 * naming convention, not an interface, so a backend rename would silently
 * degrade every label with nothing failing on either side.
 *
 * Only a URL that actually names a `.pdf` supplies one. `pdfUrl` is a link to
 * the backend's re-signing route now, and its last segment is a Mongo id —
 * labelling a document '6a84f789c9d48680d19276c1' is worse than labelling it
 * by its type.
 */
function basenameLabel(pdfUrl: string): string {
  const basename = pdfUrl.split("/").pop() ?? "";
  if (!basename || !/\.pdf$/i.test(basename)) return "";
  try {
    return decodeURIComponent(basename).replace(/\.pdf$/i, "");
  } catch {
    return "";
  }
}

/**
 * Where a recent document's link points.
 *
 * The backend hands back a PATH (`/api/pdf-links/download/<id>`) rather than
 * the presigned S3 URL captured when the document was generated: AWS SigV4
 * will not sign for longer than seven days, so a stored link stopped working a
 * week after the run that produced it. The API does not reliably know its own
 * public origin, so the prefix is applied here — the same NEXT_PUBLIC_BACKEND_URL
 * every other call uses.
 *
 * An absolute URL is passed through, so rows written before this change still
 * open.
 */
export function documentHref(pdfUrl: string): string {
  if (!pdfUrl || !pdfUrl.startsWith("/")) return pdfUrl;
  return `${process.env.NEXT_PUBLIC_BACKEND_URL ?? ""}${pdfUrl}`;
}

export function recentDocumentLabel(doc: AutomationRecentDocument): string {
  return doc.invoiceNumber || doc.participant || basenameLabel(doc.pdfUrl) || doc.type;
}

export type DeliveryStatus = {
  label: string;
  tone: (typeof DELIVERY_STATE_BADGES)[keyof typeof DELIVERY_STATE_BADGES]["tone"];
  /** The sentence to render beside the badge, or null when there is nothing to act on. */
  detail: string | null;
};

/**
 * How one recent document's send reads on the panel.
 *
 * Two rules the table alone would not give:
 *   - An unknown state — a backend ahead of this build — falls back to
 *     "Generated" rather than rendering a word nobody has designed for. A
 *     document existing is never itself a failure.
 *   - The detail is only carried for states that are actually a problem, so a
 *     `deliveryDetail` left over from an earlier bounce cannot appear beside
 *     "Delivered" and read as a live one.
 */
export function deliveryStatus(doc: AutomationRecentDocument): DeliveryStatus {
  const badge =
    DELIVERY_STATE_BADGES[doc.deliveryState as keyof typeof DELIVERY_STATE_BADGES] ??
    DELIVERY_STATE_BADGES[DEFAULT_DELIVERY_STATE];

  return {
    label: badge.label,
    tone: badge.tone,
    detail: badge.showsDetail ? (doc.deliveryDetail ?? null) : null,
  };
}

/**
 * All three fields mean the same thing to the badge — the API reports a failed
 * run as a message, a coarse flag or a count depending on the response shape.
 * Reading only one is how a field rename turns the warning off silently.
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
