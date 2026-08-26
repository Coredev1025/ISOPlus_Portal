# Automatic board sync schedule

**Date:** 2026-08-19
**Status:** Implemented, with deviations — see "Changes since approval" below.
**Epic:** Finance Settings & Automation Epic 7 (Track A)
**Supersedes:** the per-board half-hourly sketch that briefly lived in
[`docs/plans/2026-08-19-automatic-board-sync-schedule-plan.md`](../../plans/2026-08-19-automatic-board-sync-schedule-plan.md)
before this design. Do not implement per-board `ScheduledJob` rows.

## Changes since approval

| Designed | Shipped | Why |
|---|---|---|
| JobId period key via `automationPeriodKey` of the claimed slot | `scheduledSyncPeriodKey` in `boardSyncSweepHelpers.js` (same `YYYYMMDD-HHmm` shape, `Intl`) | Board catch-up must not import invoice-automation helpers. The slot is still the claimed `scheduledFor` / `nextRunAt`, never `Date.now()`. |
| The `board_sync` handler "today" calls `triggerManualSync` for one `targetId` | `runBoardSyncSweep` fans out `scheduled_sync` for every `syncData: true` board | That was the pre-change state this design replaced; keeping the old sentence would describe code that no longer exists. |
| Clock: EventBridge → `POST /api/scheduler/tick` claims a portal `ScheduledJob` | In-process `setTimeout` + `cron-parser` (`startBoardSyncCron`) calls `runBoardSyncSweep` directly; `board_sync` is **not** registered on the tick | Epic 12 only — invoice/statement automation stay on EventBridge. Multi-instance duplicate fires are accepted; BullMQ `jobId`s collapse them. |
| Next run from portal `ScheduledJob.nextRunAt` | Next run from `computeNextRun(BOARD_SYNC_CRON, DEFAULT_TIMEZONE, now)` | No tick advances a board-sync row. Leftover portal `ScheduledJob` rows are disabled by migration so ticks cannot claim them. |
| Cron fire re-derives the slot from `Date.now()` via `computeCurrentCronSlot` | Slot is captured when the timer is armed (`computeNextRun`) and passed into the fire callback | `setTimeout` can run a millisecond early; re-deriving would resolve to the previous occurrence and silently skip a day. |
| Queued when a waiting BullMQ job exists | Sweep stamps `syncJobId` (and `scheduled_sync` when safe) on enqueue | Worker previously set those only when active, so Current stayed Idle while waiting. |
| Waiting `scheduled_sync` blocks manual Resync | Waiting/delayed `scheduled_sync` is removed (re-checked before remove; remove failure refuses Resync). Active catch-up still blocks. Sweep jobs use `priority: 10` (BullMQ: lower number first; yields to manual's `2`) | Operator Resync must not wait for a portal-wide wave to drain. |
| Failed nightly catch-up hidden after 60s | Indicator also surfaces sticky `Board.lastSyncError` until the next successful sync clears it | Operators opening the app in the morning still see the overnight failure. |
| No env kill switch / inter-board pacing | `BOARD_SYNC_ENABLED` (scheduled catch-up only) + `BOARD_SYNC_GAP_MS` (BullMQ `delay = index * gap` on fan-out) | Operators need an off switch without tearing down per-board Sync; gap reduces ISO+ 429 pressure without blocking manual Resync via worker sleep. Disable does not drain already-queued delayed jobs (restart + drain). Gap is start-spacing — size ≥ typical board duration for real rest. |

## What already exists (do not rebuild)

Enabling **Sync data from ISO+** on Board Configuration already:

1. Runs a one-time validation + backlog sync.
2. Registers an ISO+ webhook so create/update/delete calls the portal.
3. Leaves the board in `realtime_sync`.

Invoice Generator and Monthly Statement **Resync Data** already enqueue
`manual_triggered_sync` on the existing `board-sync` queue. That stays.

The clock already exists: `POST /api/scheduler/tick` (KAN-15). Before this
change the `board_sync` handler called `triggerManualSync` for a single
`targetId`, and nothing in production wrote a `ScheduledJob` for it. This
design changed that handler into a portal-wide fan-out, rather than creating
one schedule per board.

## Goal

Once a day (configurable cron, default daily), enqueue a catch-up sync for
**every board with sync enabled**, processed **one at a time**, and show
previous / current / next run on Board Configuration.

Webhooks remain the live path. The schedule is a missed-event catch-up, the
same class of work as Resync Data.

## Approach (chosen)

**Portal-wide sweep + fan-out + worker concurrency 1.**

```
setTimeout + cron-parser (BOARD_SYNC_CRON, DEFAULT_TIMEZONE)
      │  started on Mongo connect; skipped in NODE_ENV=test
      │  slot captured at arm-time (not re-derived on fire)
      ▼
runBoardSyncSweep({ slot, timezone })
      │  offline → skip without throw
      ▼
find boards where syncData === true
      ▼
board-sync queue addBulk (idempotent jobId per board + slot, priority 10)
      ▼
syncWorker concurrency 1  →  scheduled_sync catch-up
      ▼
board returns to realtime_sync (existing backlog completion path)
```

EventBridge / `POST /api/scheduler/tick` continues for invoice and statement
automation only. It must not claim `board_sync`.

Rejected:

- Per-board schedules (independent ticks, no global serialisation).
- Per-workspace crons (more UI than asked).
- A second queue or a Redis lock only for scheduled jobs (manual Resync is
  allowed to wait behind a sweep; that is the traffic-management choice).

## Config

| Key | Value |
|---|---|
| Clock | In-process `setTimeout` + `cron-parser` (not EventBridge) |
| Default cron | `0 2 * * *` (02:00 in the schedule timezone) |
| Override | `BOARD_SYNC_CRON` in `Backend/.env` (and `.env.example`) |
| Enable | `BOARD_SYNC_ENABLED` — unset = on; `false`/`0`/`off`/`no` stops the cron. The sweep itself is not gated: one check, at `startBoardSyncCron` |
| Inter-board gap | `BOARD_SYNC_GAP_MS` — default `0`; `delay = index * gap` on bulk jobs; capped at one hour. Warn when `(boards-1)*gap` exceeds a day (see `BOARD_SYNC_SPAN_WARN_MS`) |
| Timezone | `DEFAULT_TIMEZONE` (`Australia/Sydney`) |
| Who edits these | Operators via env. **Board Configuration does not edit them.** |

Invalid `BOARD_SYNC_CRON` must refuse to start the timer at boot (warn + skip),
not silently fall through to `* * * * *`.

Multi-instance: every EB instance runs the same cron. Duplicate fires in the
same minute share `sched:{boardId}:{periodKey}` and collapse in BullMQ.

## Fan-out

Eligible: `Board.syncData === true` and a non-empty `boardId` and
`workspaceId`. First-time enable (validation / backlog) is included: with
concurrency 1 the catch-up waits behind the in-flight job; `hasRunningSync`
still refuses a second concurrent run on the same board if a job is already
active.

Zero eligible boards is success (same as invoice automation fan-out).

Each job:

- `name` / `jobType`: `scheduled_sync`
- `data`: `{ jobType, authorization, workspaceId, boardId }`
- `opts.jobId`: `sched:{boardId}:{periodKey}` where `periodKey` is
  `automationPeriodKey` of the **claimed slot**, not `Date.now()`. A retry of
  the same slot must collapse to the same ids.

The handler **enqueues and returns**. It must not await ISO+.

Offline (`isOfflineMode()`): skip without throwing (already true of today's
`board_sync` handler). Under `AT_LEAST_ONCE` a throw would retry forever.

## Serialisation

`syncWorker` concurrency drops from **2 to 1**. Manual Resync, backlog, and
scheduled catch-up share that cap. That is intentional.

`startBoardSyncCron` is the board-sync clock only. Do not drive invoice/statement
automation from it. Do not add a second tick endpoint.

## Status on Board Configuration

When the sync checkbox is on, show three facts from an extended
`GET /api/sync/board/status/:boardId`:

| Label | Meaning |
|---|---|
| Previous | Last **completed** `SyncExecution` for this board (any catch-up type), else `lastSyncedAt` if present, else none yet |
| Current | Active execution or BullMQ job for this board; else **Queued** if a `scheduled_sync` job is waiting; else **Idle** |
| Next scheduled run | `computeNextRun` of `BOARD_SYNC_CRON` in `DEFAULT_TIMEZONE` (same for every board) |

No new route. Existing auth on `/api/sync/board/status/:boardId` stays.

This is user-visible → Playwright coverage on the configuration page.

## Failure

`runBoardSyncSweep` throws if enqueue fails (logged by the cron wrapper).
There is no `ScheduledJob` consecutive-failure counter for board sync.
Per-board work failures stay on BullMQ retries and `lastSyncError`. A board
that throws inside the worker does not fail the whole sweep; remaining jobs
stay in the queue.

## Out of scope

- Cadence picker in the UI
- Gating on `invoiceStatementAutomation`
- Removing Resync Data or webhooks
- System Health (Epic 6)
- Changing enable-time one-shot sync or hook registration

## Testing

- Unit: fan-out specs, cron resolve, status shaping, worker concurrency
- Integration: due tick with two enabled boards records two `scheduled_sync`
  bulk jobs with stable jobIds; disabled `syncData` boards omitted
- Frontend unit: configuration panel renders previous / current / next
- E2E: signed-in configuration page shows the three labels
