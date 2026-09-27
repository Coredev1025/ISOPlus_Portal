/**
 * Field-format patterns shared across features, in one place.
 *
 * Each entry records its touchpoints — the modules that read it — so changing
 * one here tells you what it reaches without a grep. Keep those lists current:
 * a stale touchpoint comment is worse than none, because it will be believed.
 *
 * These live here rather than in a `constants/<feature>.js` precisely because
 * more than one feature validates the same field: an address the automation
 * settings accept and the business profile refuses is a bug in one of them, and
 * two copies of a pattern is how that happens.
 *
 * This file imports nothing, deliberately.
 */

/**
 * Deliberately loose: a full RFC 5322 check rejects addresses that work. The
 * authoritative check is SES rejecting it at send time.
 *
 * The domain is spelled as dot-separated labels rather than `[^\s@]+\.[^\s@]+`
 * because the dot is a member of `[^\s@]` too: the two parts overlap, so a long
 * dotted string that ultimately fails makes the engine retry at every dot,
 * which is quadratic in the length of the field (SonarJS S5852) and is CPU a
 * request body gets to spend for us. Excluding the dot from the labels makes
 * the split deterministic, and rejects the empty labels — `a@b..com`,
 * `a@.b.com`, `a@b.com.` — the ambiguous form accepted.
 *
 * Mirrored by `EMAIL_PATTERN` in `Frontend/constants/validation.ts`, which
 * flags the same fields as you type. The two must agree, or a form accepts an
 * address the API then refuses.
 *
 * Touchpoints: utils/automationSettingsHelpers.js (validateEmails, over
 * sendCopyTo/replyTo), validators/businessProfile.js
 * (validateIdentityFields).
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
