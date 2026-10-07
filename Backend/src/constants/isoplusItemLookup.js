/**
 * How many ISO+ item GETs the webhook item lookup may have in flight at once,
 * shared by every webhook request in this process. ISO+ answers 429 to bursts;
 * KAN-349 was dozens of concurrent board scans multiplying each other. Read-only
 * by convention.
 * Touchpoints: utils/isoplusWebhookItemHelpers.js.
 */
export const ISOPLUS_ITEM_LOOKUP_CONCURRENCY = 3;

/**
 * Retries on 429 or 503 for one item read during a board scan. Low on purpose:
 * ISO+ drops a webhook hook after three unanswered deliveries, so a scan must give
 * up in seconds, not minutes. Read-only by convention.
 * Touchpoints: utils/isoplusWebhookItemHelpers.js.
 */
export const ISOPLUS_ITEM_SCAN_MAX_RETRIES = 1;

/**
 * Board scans allowed to run at once. A scan is up to one ISO+ read per synced
 * board and the webhook endpoint is unauthenticated, so extra scans are skipped
 * rather than queued. Read-only by convention.
 * Touchpoints: utils/isoplusWebhookItemHelpers.js.
 */
export const ISOPLUS_ITEM_SCAN_MAX_CONCURRENT = 3;
