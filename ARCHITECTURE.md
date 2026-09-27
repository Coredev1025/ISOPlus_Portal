# Architecture

This is a pointer, not a second copy. The detailed, kept-current architecture
lives in two places:

- [`README.md`](README.md#architecture) — a short summary: what each app is,
  how they're wired together, the local-dev caveat about live vs. seeded data.
- [`CLAUDE.md`](CLAUDE.md#backend-architecture) — the full picture: routing
  pattern, auth, board sync, PDF generation, Xero, logging, plus the matching
  [Frontend architecture](CLAUDE.md#frontend-architecture) section.

Restating either here would just be a third copy to keep in sync — this repo
has already been burned by that once (see the "Stale duplication" note in
`CLAUDE.md`). If you're about to write architecture documentation, add it to
one of those two files instead of here.

Related, narrower references: [`docs/scheduling.md`](docs/scheduling.md)
(automation scheduling), [`docs/migrations.md`](docs/migrations.md) (schema
changes), [`docs/local-development.md`](docs/local-development.md) (Docker
stack).
