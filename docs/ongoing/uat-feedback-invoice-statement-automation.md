# UAT feedback (items 12-15): invoice/statement automation — handover

## Status: done

All tickets from this UAT pass are implemented, merged into `develop`, deployed to
`isoplus-be-dev-blue`, and live-verified in the ISO+ dev sandbox (workspace
`55369`). Jira tickets are closed with comments/screenshots as evidence. There is
no blocked or in-progress work from this batch — this doc exists as a record and
to carry forward one unticketed process finding (see below).

Originated from a UAT feedback document on isoplus.online, items 12-15. Those
four items plus codebase investigation grew into ten Jira tickets (KAN-269
through KAN-278), all under project KAN.

## Tickets, PRs, type

| Ticket | PR | Type | Summary |
|---|---|---|---|
| [KAN-269](https://isoconsultingservices.atlassian.net/browse/KAN-269) | [#927](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/927) | CR | Remove Email From field from automation settings UI |
| [KAN-270](https://isoconsultingservices.atlassian.net/browse/KAN-270) | [#928](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/928) | CR | Make Email From an application-level config constant, not per-workspace |
| [KAN-271](https://isoconsultingservices.atlassian.net/browse/KAN-271) | [#935](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/935) | Bug | Gate SaH/SaH (Low-cat) invoicing on Timesheet Approval (NDIS already had this gate; SaH didn't) |
| [KAN-272](https://isoconsultingservices.atlassian.net/browse/KAN-272) | [#929](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/929) | CR | Derive invoice/statement recipient from Billing Email presence, not a manual dropdown |
| [KAN-273](https://isoconsultingservices.atlassian.net/browse/KAN-273) | [#931](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/931) | CR | Rework statement of account PDF to Xero-style layout (due date column, payment advice tear-off) |
| [KAN-274](https://isoconsultingservices.atlassian.net/browse/KAN-274) | [#930](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/930) | Bug | Statement showed only the current period's invoices instead of every outstanding invoice |
| [KAN-275](https://isoconsultingservices.atlassian.net/browse/KAN-275) | [#933](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/933) | Bug | Payment items weren't matched to participants via the `Participant Profile` reference chain |
| [KAN-276](https://isoconsultingservices.atlassian.net/browse/KAN-276) | [#934](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/934) | CR | Remove ageing-summary band, opening/closing balance strip, disclaimer paragraph from statement |
| [KAN-277](https://isoconsultingservices.atlassian.net/browse/KAN-277) | [#932](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/932) | Bug | Payment date compared in implicit UTC, excluding same-day (Australia/Melbourne) payments |
| KAN-276 CI fix (untracked) | [#936](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/936) | Bug | Post-merge test breakage from KAN-275/KAN-276 branching off before each other merged |
| [KAN-278](https://isoconsultingservices.atlassian.net/browse/KAN-278) | [#937](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/937) | Bug | Statement logo overlapped the provider address block; stacked + right-aligned instead |

All PRs merged 2026-09-27. Final live check (2026-10-01 session) regenerated a
statement (`SOA-180`, board `mXmS4j4fvQj`, participant "E2E Handover") and
confirmed KAN-273/274/276/277/278 all render correctly together: logo top-right
clear of the (3-line) address block below it, address block right-aligned flush
with the table, no ageing/summary/disclaimer content, payments on their own
dated lines, and every outstanding invoice listed regardless of period.

## Process finding (not ticketed)

**CI/CD deploys can complete out of order and silently revert a newer commit.**
GitHub Actions runs for PR #935 (newer commit) and PR #936 (older commit, merged
right after) finished their "Deploy Backend" jobs out of order — #936's deploy
to `isoplus-be-dev-blue` completed ~2 minutes after #935's, overwriting the dev
environment with the older artifact and silently dropping KAN-271. Caught by
comparing exact `startedAt`/`completedAt` job timestamps via
`gh run view --json jobs`, fixed with `gh run rerun <run-id>` on the newer
commit's pipeline.

This can recur with any two merges that land close together, since EB deploy
just pushes whatever artifact that specific workflow run built, with no
"deploy the latest commit" guard. Worth its own ticket (e.g. serialize deploys,
or have the deploy step check it's deploying `HEAD` of the target branch before
pushing) — raised here rather than filed, since it's a pipeline/process change
outside this UAT batch's scope.

## Where to look for evidence

- Jira tickets above have close-out comments with dev-environment test results
  and screenshots.
- Sample generated PDFs from live verification: ask for a fresh regeneration
  via the Finance Settings → Invoice & Statement Automation tab in portal-dev
  (workspace `55369`) if you need another sample — the ones downloaded during
  this session were saved to a scratchpad temp dir that doesn't persist across
  sessions.
- `docs/superpowers/specs/2026-08-20-invoice-item-selection-and-statements-design.md`
  has a "Changes since approval" section updated by KAN-274 and KAN-276 —
  read it before touching statement logic again, since the live behavior has
  departed from that design in documented ways.

## Local environment note

This repo's `Backend/` checkout may be on an unrelated working branch (it was
sitting 8+ commits behind `origin/develop` on `chore/revert_direct_docs_push`
during this session). If picking this back up, `git fetch && git log
origin/develop` first rather than trusting the local checkout's state.
