/**
 * Field-format patterns shared by more than one feature. Each entry records its
 * touchpoints — the modules that read it — so changing one tells you what it
 * reaches without a grep. A stale touchpoint comment is worse than none.
 */

/**
 * Deliberately loose: a full RFC 5322 check rejects addresses that work.
 *
 * The domain is dot-separated labels rather than `[^\s@]+\.[^\s@]+` because the
 * dot is a member of `[^\s@]` too — the two parts overlap, so a long dotted
 * string that ultimately fails makes the engine retry at every dot, quadratic
 * in the length of the input (SonarJS S5852). Excluding the dot also rejects
 * the empty labels `a@b..com`, `a@.b.com`, `a@b.com.` that the loose form took.
 *
 * Must stay identical to `EMAIL_PATTERN` in `Backend/src/constants/validation.js`,
 * or a form accepts an address the API then refuses.
 *
 * Touchpoints: lib/automation-email-block.tsx (per-keystroke field validation),
 * lib/automation-helpers.ts (the Save gate),
 * app/workspace/[id]/board/[boardId]/monthly-statement/page.tsx (business
 * details form).
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
