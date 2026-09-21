import {
  DEFAULT_EMAIL_MESSAGE,
  DEFAULT_EMAIL_SUBJECT,
  type AutomationKind,
} from "@/constants/automation";
import type { AutomationBlock } from "@/lib/automation-settings";

/**
 * Whether a template field is empty as far as a reader is concerned.
 *
 * `<p></p>` matters as much as `""`: TipTap writes an empty paragraph the
 * moment the editor is focused and left, so a block whose message was never
 * typed into comes back from the API as markup rather than an empty string.
 * Treating that as content would mean a client who clicked into the editor
 * once never got the default copy, and never understood why.
 */
function isBlankTemplate(value: string | null | undefined): boolean {
  const text = String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
  return text === "";
}

/**
 * The block with its email copy pre-filled, per KAN-265.
 *
 * Only ever fills a field that is blank. This runs over what the API returned,
 * so overwriting a stored value would be the product silently rewriting the
 * wording a client sends to their own customers — the one thing a default must
 * never do. Each field is judged on its own, so a client who wrote a subject
 * and left the body alone keeps the subject and gains the body.
 *
 * Pure, and returns a new object: the caller holds this in React state.
 */
export function withEmailDefaults(
  block: AutomationBlock,
  kind: AutomationKind,
): AutomationBlock {
  return {
    ...block,
    emailSubject: isBlankTemplate(block.emailSubject)
      ? DEFAULT_EMAIL_SUBJECT[kind]
      : block.emailSubject,
    emailMessage: isBlankTemplate(block.emailMessage)
      ? DEFAULT_EMAIL_MESSAGE[kind]
      : block.emailMessage,
  };
}
