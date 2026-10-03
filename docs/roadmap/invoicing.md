# Invoicing

Follow-ups to the scheduled invoice automation, in the order we expect to take
them. Each came out of the independent review of KAN-293 (PR #952), which fixed
the grouping and chose not to widen into these.

## 1. Deliver what was generated when one participant fails

**Today.** `generateGroupsIsolated` (`Backend/src/utils/automationInvoiceProfiles.js`)
generates every participant even if one fails, but then throws, and it throws
before any email or Xero push. When the failure is one a retry cannot fix (for
example "Participant Profile information is required but was not found"), all
three BullMQ attempts fail, and every invoice that did generate has a number and
marked items but is never delivered. The documents exist in the ledger, so a
later successful run would deliver them, but nothing tells anyone to run it.

**Wanted.** Return the successes plus a list of failures, deliver the successes,
and record the failed participants as a partial outcome on the `AutomationRun`
instead of retrying the whole job. System Health shows which participants failed
and why.

**Needs first.** A decision on the outcome vocabulary (`OUTCOME_*` in
`workers/automationWorker.js`), how System Health shows a partial run, and which
failures are worth a retry at all (a missing profile is not).

## 2. Cap invoice-number gaps during a systemic outage

**Today.** Both generators claim the invoice number before the PDF upload
(`ndisInvoiceGeneratorPdf.js`, `webhookParticipantTaxPdfHelpers.js`). Before
KAN-293 an S3 or network outage threw on the first group, about one gap per
attempt. Now every group takes a number and fails, so N groups times 3 attempts
leaves up to 3N gaps. Gaps are accepted as cosmetic (a duplicate is the real
bug), but the scale is new.

**Wanted.** A circuit breaker in `generateGroupsIsolated`: stop after K
consecutive failures, or after the first failure when nothing has succeeded yet.
Claiming the number after the upload instead would remove the gaps, but it is a
larger change to a deliberate ordering; see `claimDocumentNumber`.

## 3. Make left-out items visible

**Today.** Billable items with no `Participant Profile` are skipped and logged at
warn with their item ids (capped at 50). They are never claimed and fall outside
the next window, so nothing picks them up. For Age Care boards this is a
behaviour change: the Age Care generator used to bill such items under a generic
name.

**Wanted.** Show the count on the run outcome and in System Health, and decide
deliberately whether Age Care should keep billing profile-less items.

## 4. Store the profile on the ledger row

**Today.** A retry reads its earlier documents back from the `PDFLink` ledger,
which does not record the profile a document was made for. `attachProfileIds`
(`Backend/src/utils/automationInvoiceProfiles.js`) therefore takes the profile
from the item as it is now. If an invoice was made for profile A, its email was
refused, and an operator then corrects the item's Participant Profile to B and
re-runs the slot, the invoice printed for A goes to B's billing address. The old
name-based lookup would have found A. Narrow and unlikely, but it is the
"fix the data, then re-run" recovery path.

**Wanted.** Add `profileId` to the `PDFLink` schema and write it in
`recordPdfLinks` (`generateDocuments.js`). New rows then carry the profile they
were made for; `attachProfileIds` is used only for older rows that lack it. No
migration is needed for new rows.

## 5. Make same-name clients traceable

When two clients share a name, the logs and System Health cannot say which one
failed: `resolveRecipient` logs `profile_not_found` with the name only, the
refusal log in `deliverGroup` leaves the profile id out, and `EmailSend` stores
only `recipientKey` (the name). Add `profileId` to those log details and,
optionally, to `EmailSend`. The document status stamp is already correct because
it goes by document URL.

## 6. Missing tests

- No test runs two same-name profiles through the SES backend with the real
  `resolveRecipient`; the worker test mocks `deliverEmail` and the backend test
  mocks `resolveRecipient`.
- No committed test covers the retry path: a second `generateInvoicesForBoard`
  on the same slot should return ledger rows that carry `profileId`.
- A ledger row whose item has since been deleted or lost its profile falls back
  to name matching, and a client can then receive two emails (one per group
  key). This is the old behaviour, not a new risk.

## Smaller items from the same review

- Offline (local preview) outbox files are named by the participant's name, so
  two clients who share a name overwrite each other's preview file. Real sends
  are addressed by profile id and are not affected.
- `loadProfileIds` accepts any string from `extractRefId`, including
  `"[object Object]"` for a reference with no id. Filter with `isUuidLike`, as
  the NDIS generator does.
- The aggregated error from `generateGroupsIsolated` puts participant names into
  the BullMQ failure reason, the run error and Sentry. List the names in a
  structured log and keep the thrown message to a count and the first error.
- `automationInvoiceProfiles.js` declares `'Participant Profile'` inline; use
  `ATTRIBUTE_NAMES.PARTICIPANT_PROFILE`.
- The provisional claim token is built from the participant label, so two
  profiles with one label share a token. Their items never overlap, but a
  stale-claim report cannot tell them apart.
