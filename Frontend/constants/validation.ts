/**
 * Field-format patterns shared across features, in one place.
 *
 * Each entry records its touchpoints — the modules that read it — so changing
 * one here tells you what it reaches without a grep. Keep those lists current:
 * a stale touchpoint comment is worse than none, because it will be believed.
 *
 * These live here rather than in a `constants/<feature>.ts` precisely because
 * more than one feature validates the same field: an address the automation
 * panel accepts and the monthly statement refuses is a bug in one of them, and
 * two copies of a pattern is how that happens.
 *
 * This file imports nothing, deliberately.
 */

/**
 * Deliberately loose: a full RFC 5322 check rejects addresses that work. The
 * authoritative check is the send itself failing.
 *
 * The domain is spelled as dot-separated labels rather than `[^\s@]+\.[^\s@]+`
 * because the dot is a member of `[^\s@]` too: the two parts overlap, so a long
 * dotted string that ultimately fails makes the engine retry at every dot,
 * which is quadratic in the length of the input (SonarJS S5852). Excluding the
 * dot from the labels makes the split deterministic, and rejects the empty
 * labels — `a@b..com`, `a@.b.com`, `a@b.com.` — the ambiguous form accepted.
 *
 * Mirrored by `EMAIL_PATTERN` in `Backend/src/constants/validation.js`, which
 * validates the same fields on save. The two must agree, or a form accepts an
 * address the API then refuses.
 *
 * Touchpoints: lib/automation-email-block.tsx (per-keystroke field validation),
 * app/workspace/[id]/board/[boardId]/monthly-statement/page.tsx (business
 * details form).
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
