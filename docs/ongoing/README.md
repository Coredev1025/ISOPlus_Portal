# Ongoing

Work in flight: what is half-done right now, what is blocked, and what the next
person — or the next session — needs to know to pick it up.

One file per stream of work, named after its ticket: `ISO-412.md`. Keep it
short and current. A file here is a handover note, not a journal; when the work
merges, delete the file. The durable record is the plan in `../plans/` and the
commit history.

Useful things to write down: what is done and verified, what is done but
unverified, what was tried and rejected and why, and any local state a
successor would not discover on their own (a seeded database, a running
worktree, an env var that has to be set by hand).

## What goes where

| Directory | Holds | Horizon |
|---|---|---|
| `../roadmap/` | What we intend to do, not yet designed | Quarters |
| `../superpowers/specs/` | Approved designs — what and why | Per change |
| `../plans/` | Step-by-step execution of a design | Per change |
| `./` (ongoing) | State of work in flight right now | Days |

## Conventions

Branching, tickets, commit format and the engineering rules are in
[`../../CLAUDE.md`](../../CLAUDE.md). Reference them rather than repeating them.

Nothing in here is a substitute for a commit. If a fact matters beyond this
week, it belongs in a plan, in `CLAUDE.md`, or in the code.
