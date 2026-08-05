# Plans

Implementation plans: the step-by-step route from an approved design to merged
code. One file per plan, named `YYYY-MM-DD-<topic>-plan.md`.

A plan comes **after** a design in `../superpowers/specs/` and **before** any
code. The design says what we are building and why; the plan says in what order,
in what commits, and how each step is verified. If you cannot say how a step
will be checked, the step is not ready to be in a plan.

Keep plans here once they are done rather than deleting them — a merged plan is
the record of how something was actually built, and the next person changing
that area starts by reading it.

## What goes where

| Directory | Holds | Horizon |
|---|---|---|
| `../roadmap/` | What we intend to do, not yet designed | Quarters |
| `../superpowers/specs/` | Approved designs — what and why | Per change |
| `./` (plans) | Step-by-step execution of a design | Per change |
| `../ongoing/` | State of work in flight right now | Days |

## Conventions

Branching, tickets, commit format and the engineering rules that apply to
anything a plan produces are in [`../../CLAUDE.md`](../../CLAUDE.md). Do not
restate them here — a plan should reference them, so there is one copy to keep
correct.
