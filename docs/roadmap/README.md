# Roadmap

What we intend to build, before it has a design. Intent and sequencing, not
implementation.

One file per theme (`invoicing.md`, `sync.md`, `platform.md`) rather than one
per idea — a roadmap made of many small files stops being readable as a whole.
Within a file, order entries by when we expect to take them on, and say what
would have to be true to start.

An entry graduates out of here: it gets a design in `../superpowers/specs/`,
then a plan in `../plans/`. When that happens, leave a line pointing at the
design rather than deleting the entry, so the reasoning stays connected to the
outcome.

Keep entries honest about uncertainty. "We think this is next, and it depends on
the Xero rework landing" is more useful than a date nobody believes.

## What goes where

| Directory | Holds | Horizon |
|---|---|---|
| `./` (roadmap) | What we intend to do, not yet designed | Quarters |
| `../superpowers/specs/` | Approved designs — what and why | Per change |
| `../plans/` | Step-by-step execution of a design | Per change |
| `../ongoing/` | State of work in flight right now | Days |

## Conventions

Branching, tickets, commit format and the engineering rules are in
[`../../CLAUDE.md`](../../CLAUDE.md). This repo auto-deploys on merge, which is
why roadmap items become designs and plans before they become branches.
