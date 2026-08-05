# ISO+ Portal

A business dashboard that syncs data from the [ISO+ platform](https://isoplus.online)
into workspaces and boards, then generates NDIS and Aged Care invoices, quotes and
monthly statements as PDFs, and pushes invoices to Xero.

Monorepo with two independently-deployed apps:

| Directory   | Stack                                                        |
| ----------- | ------------------------------------------------------------ |
| `Backend/`  | Node.js 22 + Express 4 (ESM), MongoDB via Mongoose 8, Redis + BullMQ |
| `Frontend/` | Next.js 15 App Router, React 18, TypeScript, shadcn/ui + Tailwind |

There is **no root-level build or lint tooling for application code** — run app
npm commands from inside `Backend/` or `Frontend/`. The root `package.json` has no
dependencies and exists only to expose the local-dev orchestration in `scripts/`.

## Quick start

Requires **Docker** (with Compose v2) and **Node 20+** on the host. Nothing else.

```bash
npm run doctor     # check prerequisites
npm run dev:up     # build + start the whole stack, health-gated
npm run seed       # restore the sample database
npm run dev:user   # set a local password on the seeded admin account
```

Then open **http://localhost:3100**, click **administrator credentials** at the
bottom of the login screen, and sign in with the account `dev:user` prints.

Verify the API directly:

```bash
curl localhost:4001/api/healthcheck   # -> {"status":"OK"}
```

The seed archive (`seed/isoplus-dump.archive.gz`) and the two env files
(`Backend/.env`, `Frontend/.env.local`) are gitignored — get them from a
teammate. Copy `.env.example` in each app as a starting point; the backend exits
on boot without `MONGODB_URI`, `JWT_SECRET` and `SESSION_SECRET`.

### Default ports

| Service  | Host port |
| -------- | --------- |
| Frontend | 3100      |
| API      | 4001      |
| MongoDB  | 27017     |
| Redis    | 6380      |

3000, 3001 and 6379 are deliberately avoided so the stack can coexist with other
local projects. Override any of them via a root `.env` — see `.env.docker.example`.

## Commands

All run from the repo root.

| Command             | Does                                                      |
| ------------------- | --------------------------------------------------------- |
| `npm run dev:up`    | Start the stack, waiting for health checks                 |
| `npm run dev:build` | Same, rebuilding images — use after a `package.json` change |
| `npm run dev:down`  | Stop the app containers (`-- --all` also stops Mongo/Redis) |
| `npm run dev:status`| Show container status for both stacks                      |
| `npm run dev:logs`  | Tail all logs                                              |
| `npm run seed`      | Restore the Mongo dump from `seed/`                        |
| `npm run dev:user`  | Set a known password on the seeded `support_admin`         |
| `npm run schema`    | Report live collection shapes and model drift              |
| `npm run migrate`   | Create and run database migrations                         |
| `npm run worktree`  | Create a git worktree with its own ports and env           |
| `npm run doctor`    | Check prerequisites and config drift                       |

Tooling in `scripts/` is Node rather than shell so it behaves identically on
Linux, macOS and Windows including PowerShell. Keep it that way.

On macOS and Windows, hot reload needs `WATCH_POLLING=true` in a root `.env` —
Docker Desktop does not forward inotify events across bind mounts.

## How the Docker setup is split

The stack spans **two Compose projects**, deliberately:

- **`docker-compose.infra.yml`** (project `isoplus-infra`) owns MongoDB and Redis
  and runs **once per machine**. It creates the `isoplus-net` network.
- **`docker-compose.yml`** (project `isoplus-portal`) owns the backend and
  frontend and runs **once per worktree**, joining `isoplus-net` as an external
  network.

That split is what lets several git worktrees run their own backend and frontend
concurrently against one set of datastores. Two consequences worth knowing:

- Neither app service sets `container_name:`. Address containers through
  `docker compose ps` / `docker compose exec`, never `docker inspect isoplus-backend`.
- Inside the network the datastores are `mongo:27017` and `redis:6379`.
  `docker-compose.yml` sets `MONGODB_URI`, `REDIS_*`, `ALLOWED_ORIGINS` and
  `NEXT_PUBLIC_BACKEND_URL` itself, **overriding** whatever is in the app env
  files. Everything else — secrets, ISO+/Xero/AWS credentials — comes from those.

See [`docs/local-development.md`](docs/local-development.md) and
[`docs/worktrees.md`](docs/worktrees.md).

## Architecture

### Backend

`src/index.js` wires Sentry, CORS, `express-session` backed by MongoDB,
`express-mongo-sanitize`, request-context and audit middleware, then mounts
routers under `/api/*`.

- **Routes** — `src/routes/*.js` are Express routers with controller logic inline,
  delegating heavy transformation to `src/utils/*Helpers.js` and `src/services/*`.
  There is no separate controllers layer.
- **Auth** — login is an ISO+ OAuth flow. The JWT lives in the session, not a
  bearer header. Roles are `isoplus_user | support_admin | owner`; admin and
  webhook routes are guarded by an API key instead.
- **Board sync** — a BullMQ `board-sync` queue on Redis, with the worker started
  on boot. Cluster mode (AWS ElastiCache, TLS) is supported via `REDIS_CLUSTER`.
  Monitor it at `localhost:4001/api/queues`.
- **PDFs** — `@pdfme/*` against JSON templates in `src/assets/`.
- **Logging** — use `src/utils/logger.js` (Winston, with sanitization), not
  `console.log`. Pass `req` as the last argument to attach request context.

### Frontend

Next.js App Router under `Frontend/app/`, with `@/*` aliased to the Frontend root.
Routing mirrors the ISO+ domain hierarchy:
`app/workspace/[id]/board/[boardId]/{invoice-generator,monthly-statement,qr-generator,export,configuration}`.

- Global state lives in `app/context/index.tsx`, hydrated from `localStorage`.
- API calls go through the shared axios instance in `app/utils/axiosConfig.ts`,
  which sets `withCredentials` so the session cookie is sent.
- Large features are decomposed in `lib/` into `-page-view.tsx` (view),
  `-helpers.ts` (logic) and `use-*.ts` hooks. Mirror that split when adding features.
- UI is shadcn/ui in `components/ui/`, lucide-react icons, Tailwind. Don't add
  other UI or icon libraries.

### A caveat on local data

Being logged in is not the same as having data. Several endpoints proxy to the
live ISO+ API rather than reading Mongo — `GET /api/workspaces` among them — and
return `401` with `{"error_type":"oauth"}` without a real access token. Anything
backed by seeded Mongo data works offline; anything needing live ISO+ data does
not. When a local 401 appears, read the body before assuming the session broke.

## Contributing

This codebase is production and **deploys automatically on merge**, so:

- No unrequested refactors, and no breaking changes to routes or data shapes.
- Prefer the smallest diff that solves the problem.
- Explain a change before applying it, especially around auth, sync, PDF
  generation or Xero.

**Branching** — `<type>/<TICKET>_<snake_case_description>`, e.g.
`feature/ISO-412_time_tracking`. Types are `feature/`, `bugfix/`, `hotfix/`.
`feature/` and `bugfix/` branch from `develop`; `hotfix/` from `main`. PRs target
`develop` except hotfixes. Use `npm run worktree -- new`, which prompts for the
work type and ticket and composes the name, rather than raw `git checkout -b`.

**Code quality gate** — cognitive complexity must be **under 15** per file
(SonarJS S3776, see `.eslintrc.complexity.cjs`), enforced by SonarQube in CI.
This is why `Backend/src/utils/` is dozens of small `*Helpers.js` files: when a
route grows complex, extract helpers rather than nesting logic.

**Style** — prefer pure functions and keep I/O at the edges; never mutate inputs.
`lodash-es` is available in both apps (named imports only) where it genuinely
beats hand-rolled code, but prefer native where native is already clear.
`scripts/` is deliberately dependency-free and must stay so — it runs on a fresh
clone before any `npm install`.

**Schema changes go through migrations**, never a manual edit to the database.
Run `npm run schema` first to see how the live data actually differs from the
models, and always write a real `down`. See [`docs/migrations.md`](docs/migrations.md).

## Deployment

`.github/workflows/cicd.yml` runs on push and PR to `main` and `develop`,
path-filtered per app. It runs a SonarQube scan for whichever app changed, then
deploys **the backend only** to AWS Elastic Beanstalk via S3 (`ap-southeast-2`):
`develop` → `isoplus-be-dev-blue`, `main` → `isoplus-be-prod-blue`. The frontend
is not deployed by this workflow.

## Further reading

- [`docs/local-development.md`](docs/local-development.md) — full local setup and troubleshooting
- [`docs/worktrees.md`](docs/worktrees.md) — running several branches at once
- [`docs/migrations.md`](docs/migrations.md) — writing and running migrations
- [`CLAUDE.md`](CLAUDE.md) — conventions, in the form coding assistants read
  (`AGENTS.md` is a symlink to it, so every assistant reads the same file)
