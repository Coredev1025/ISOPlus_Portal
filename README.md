# ISO+ Portal

A business dashboard that syncs data from the [ISO+ platform](https://isoplus.online)
into workspaces and boards, then generates NDIS and Aged Care invoices, quotes and
monthly statements as PDFs, and pushes invoices to Xero.

Monorepo with two independently-deployed apps:

| Directory   | Stack                                                               |
| ----------- | ------------------------------------------------------------------- |
| `Backend/`  | Node.js + Express (ESM), MongoDB via Mongoose, Redis + BullMQ        |
| `Frontend/` | Next.js App Router, React, TypeScript, shadcn/ui + Tailwind          |

Run app npm commands from inside `Backend/` or `Frontend/` — the root
`package.json` has no dependencies and exists only to expose the local-dev
orchestration in `scripts/`.

## Quick start

Requires **Docker** (with Compose v2) and **Node 20+** on the host. Nothing else.

```bash
npm run doctor     # check prerequisites
npm run dev:up     # build + start the whole stack, health-gated
npm run seed       # restore the sample database
npm run dev:login  # print a one-time sign-in URL
```

Then open the URL `dev:login` prints — it signs you in once as a local support
admin. Password login no longer exists; see
[docs/local-development.md](docs/local-development.md#logging-in-locally) for the
two `Backend/.env` settings that make the session last.
The API is on **4001** — `curl localhost:4001/api/healthcheck` returns
`{"status":"OK"}`, and Bull Board is at `/api/queues`.

The seed archive (`seed/isoplus-dump.archive.gz`) and the two env files
(`Backend/.env`, `Frontend/.env.local`) are gitignored — get them from a
teammate. Copy `.env.example` in each app as a starting point.

If something doesn't come up, or you need to change ports, run several branches
at once, or work on macOS/Windows, see
[`docs/local-development.md`](docs/local-development.md) — it covers the setup
and its failure modes in full.

## Commands

All run from the repo root.

| Command              | Does                                                        |
| -------------------- | ----------------------------------------------------------- |
| `npm run dev:up`     | Start the stack, waiting for health checks                   |
| `npm run dev:build`  | Same, rebuilding images — use after a `package.json` change  |
| `npm run dev:down`   | Stop the app containers (`-- --all` also stops Mongo/Redis)  |
| `npm run dev:status` | Show container status for both stacks                        |
| `npm run dev:logs`   | Tail all logs                                                |
| `npm run seed`       | Restore the Mongo dump from `seed/`                          |
| `npm run dev:login`  | Print a one-time URL that signs you in as a local admin      |
| `npm run schema`     | Report live collection shapes and model drift                |
| `npm run migrate`    | Create and run database migrations                           |
| `npm run worktree`   | Create a git worktree with its own ports and env             |
| `npm run doctor`     | Check prerequisites and config drift                         |

## Architecture

**Backend** — `src/index.js` wires Sentry, CORS, MongoDB-backed sessions and
audit middleware, then mounts routers under `/api/*`. Routes in `src/routes/`
hold controller logic inline and delegate transformation to `src/utils/*Helpers.js`
and `src/services/*`; there is no separate controllers layer. Login is an ISO+
OAuth flow with the JWT in the session rather than a bearer header. Board sync
runs on a BullMQ queue over Redis, with the worker started on boot. PDFs are
`@pdfme/*` against JSON templates in `src/assets/`.

**Frontend** — App Router under `Frontend/app/`, routed along the ISO+ domain
hierarchy (`app/workspace/[id]/board/[boardId]/...`). Global state lives in
`app/context/index.tsx`; API calls go through the shared axios instance in
`app/utils/axiosConfig.ts`. Large features are split in `lib/` into
`-page-view.tsx`, `-helpers.ts` and `use-*.ts` hooks.

One caveat when working locally: being logged in is not the same as having data.
Several endpoints proxy to the live ISO+ API rather than reading Mongo, and
return `401` with `{"error_type":"oauth"}` without a real access token. Anything
backed by seeded Mongo data works offline; anything needing live ISO+ data does not.

## Conventions

**Read [`CLAUDE.md`](CLAUDE.md) before making changes.** It is the single source
of truth for how work is done here — branching and tickets, the enforced
cognitive-complexity gate, code style, migrations, and the engineering rules that
apply because this repo deploys automatically on merge. It's written for coding
assistants, but it's the same set of rules for everyone, and it's deliberately not
duplicated into this file. `AGENTS.md` is a symlink to it, so every assistant
reads one file.

## Further reading

- [`docs/local-development.md`](docs/local-development.md) — local setup, ports, troubleshooting
- [`docs/worktrees.md`](docs/worktrees.md) — running several branches at once
- [`docs/migrations.md`](docs/migrations.md) — writing and running migrations
- [`.github/workflows/cicd.yml`](.github/workflows/cicd.yml) — CI and deployment
