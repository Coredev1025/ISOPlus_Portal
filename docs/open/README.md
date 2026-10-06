# Open documentation

Documentation written for people **outside this repository** — primarily the ISO+ platform teams, who integrate with the Portal but have no access to this source code.

Everything else under `docs/` assumes the reader can open the code. Nothing here may.

## Why this directory is separate

Webhooks are the entire contract between ISO+ and the Portal. The teams configuring board automations upstream cannot read a route file to find out what an endpoint expects, what it returns, or which attribute change fires it. If that contract is only expressed in source, it is invisible to exactly the people who depend on it.

Keeping these documents in their own directory means the set can be shared outward — exported, published, or handed over — without dragging internal notes, plans and findings along with it.

## What belongs here

A document here describes an interface, from the outside:

- The URL shape, and which part is workspace, board or document type
- What triggers it — which attribute change, which button, which platform event
- The request body, including required fields and what happens when they are missing
- The response body, and **what a failure looks like**
- What the Portal writes back, and into which attribute

## What does not belong here

- Internal architecture, file paths, function names, line references
- Anything that leaks a secret, a customer name, or real item data
- Plans, findings, handover notes — those are `../plans/`, `../superpowers/specs/`, `../ongoing/`
- Anything untrue-but-convenient. A reader here cannot check it against the code.

## Two rules

**State failures honestly.** Portal webhook endpoints return HTTP 200 even when they fail; the real signal is the message written back to the item. A document that omits that teaches the reader to trust a status code that means nothing.

**Derive it from tests, not from memory.** These documents are only worth having if they are true. Where a claim can be pinned to a test, pin it — that is what stops this directory drifting into fiction the moment the code moves. See [`../plans/2026-08-05-webhooks-and-automation-plan.md`](../plans/2026-08-05-webhooks-and-automation-plan.md).

## Conventions

Repository conventions — branching, tickets, commit format, the engineering rules — are in [`../../CLAUDE.md`](../../CLAUDE.md), as everywhere else under `docs/`.
