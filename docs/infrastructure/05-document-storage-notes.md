# Generated Document Storage — Background Notes

**Status:** Background only. Not a work item, not in scope for the invoice and statement build.
**Audience:** the product owner, for a later review
**Raised:** 20 August 2026

---

## Why this is a separate document

This is deliberately kept out of [04-invoice-statement-generator.md](04-invoice-statement-generator.md) so the implementation scope there stays unambiguous. Nothing here is a task. No developer should act on it.

---

## Current state

Generated invoice PDFs are written to an S3 bucket that allows unauthenticated public reads. The `pdfLink` in each `invoicenumber` record points at it.

This is a deliberate design choice, not an oversight. For some invoice types the download link is distributed outside the application, so an unauthenticated URL is a functional requirement.

### Verified 20 August 2026

| Bucket | Purpose | Public read | Anonymous listing |
|---|---|---|---|
| `isoplus-portal-dev-public` | Dev output | Yes | No, 403 |
| `isoplus-portal-public` | Production output | Yes | No, 403 |
| All other `isoplus-*` buckets | Deploys, backups, private assets | No | No |

Both public buckets grant `s3:GetObject` to `Principal: "*"` with all four S3 public access blocks disabled. Confirmed by fetching a dev invoice with no credentials: HTTP 200.

Scale in the production bucket:

| Measure | Count |
|---|---|
| Invoice PDF objects | 173 |
| Distinct invoice numbers | 108 |
| Distinct participants | 15 |
| Tenant prefixes | 7 |

The gap between 173 objects and 108 invoice numbers is regeneration, consistent with records being updated after creation.

## What it means

Anonymous listing returns 403, so the bucket cannot be enumerated or scraped as a set.

Each URL is, however, a permanent unauthenticated key to that document. There is no expiry and no access check, so any URL that escapes stays usable. URLs escape through forwarded emails, browser history, referrer headers and screenshots in support tickets.

Production paths use a UUID per participant rather than a name. Dev paths include the participant name in the filename.

## Information class

The documents carry participant name, services received, service dates and financial position, for NDIS and aged care clients. That is health-adjacent personal information sitting under the Privacy Act and NDIS practice standards rather than ordinary commercial confidentiality.

## For a later review

- Whether statements should be delivered as email attachments rather than links, which closes the forwarding route for new documents without changing any bucket
- Whether public URLs are needed for statements at all, given they are account summaries rather than documents distributed to third parties
- Whether existing links should keep working if storage arrangements ever change
