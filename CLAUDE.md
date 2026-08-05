# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Monorepo with two independently-deployed apps. There is **no root-level build or lint tooling for application code** — run all app npm commands from inside `Backend/` or `Frontend/`. The root `package.json` exists only to expose the local-dev orchestration in `scripts/`; it has no dependencies and is never built, published or deployed.

- `Backend/` — Node.js + Express API (ESM, `"type": "module"`). MongoDB, Redis/BullMQ, integrates with ISO+, Xero, and AWS S3.
- `Frontend/` — Next.js 15 App Router (TypeScript, React 18, shadcn/ui + Tailwind).

The product ("ISO+ Portal") is a business dashboard that syncs data from the ISO+ platform (`isoplus.online`) into workspaces/boards, then generates NDIS / Age Care invoices, quotes, and monthly statements (PDFs) and pushes invoices to Xero.

## Commands

### Backend (`cd Backend`)
- `npm run dev` — run with nodemon (hot reload) against `src/index.js`.
- `npm start` — production start (`NODE_ENV=production`).
- `npm run debug` — start with `--inspect-brk`.
- No test script exists yet; CI runs `npm test --if-present`. There is no lint script — complexity is enforced by SonarQube (see below).

### Frontend (`cd Frontend`)
- `npm run dev` — Next dev server (default port 3000).
- `npm run build` / `npm start` — production build/serve.
- `npm run lint` — `next lint`. Note: `next.config.js` sets `eslint.ignoreDuringBuilds: true`, so lint is **not** enforced at build time — run it manually.

Both apps have committed `package-lock.json` and `yarn.lock`; CI uses `npm ci`. Prefer npm to stay consistent with CI.

### Local dev with Docker (repo root)

Full detail in **`docs/local-development.md`**; worktrees in **`docs/worktrees.md`**. Summary:

- `npm run dev:up` — start the stack, health-gated. `npm run dev:build` after a `package.json` change. `npm run dev:down` to stop. `npm run doctor` checks prerequisites.
- `npm run seed` — restore a Mongo dump from `seed/` (gitignored; see `seed/README.md`). Dumps come from a database named `isoplus` and are remapped on restore to `business-dashboard`, which is what the app expects.
- **The stack is split across two Compose projects.** `docker-compose.infra.yml` (`isoplus-infra`) owns Mongo and Redis and runs once per machine; `docker-compose.yml` owns backend and frontend and runs once per worktree, joining the `isoplus-net` network.
- **Neither app service sets `container_name:`, deliberately** — that is what allows two worktrees to run at once. Address containers via `docker compose ps` / `docker compose exec`, never `docker inspect isoplus-backend`.
- Default host ports: frontend **3100**, API **4001**, Mongo **27017**, Redis **6380**. 3000/3001/6379 are deliberately avoided (another local stack holds them); worktrees are assigned free pairs from 3110/4011 upward. Override via a root `.env` — see `.env.docker.example`.
- Inside the compose network the datastores are `mongo:27017` and `redis:6379`; `docker-compose.yml` sets `MONGODB_URI`/`REDIS_*`/`ALLOWED_ORIGINS`/`NEXT_PUBLIC_BACKEND_URL` itself, **overriding** `Backend/.env` and `Frontend/.env.local` for those keys. Everything else (secrets, ISO+/Xero/AWS creds) comes from those two files.
- Verify: `curl localhost:4001/api/healthcheck` → `{"status":"OK"}`; Bull Board at `localhost:4001/api/queues`.
- Tooling in `scripts/` is Node, not shell, so it runs unmodified on Linux, macOS and Windows (PowerShell included) with no Git Bash requirement. Keep it that way — no `.sh`, no platform-specific binaries like `ss` or `readlink -f`.
- On macOS/Windows, hot reload needs `WATCH_POLLING=true` in `.env`: Docker Desktop does not forward inotify events across bind mounts.

## Documentation layout

`docs/` is organized by how far a piece of work has progressed. Put a document in the directory matching its stage, and move it along rather than duplicating it.

| Directory | Holds | Horizon |
|---|---|---|
| `docs/roadmap/` | What we intend to do, before it has a design. One file per theme. | Quarters |
| `docs/superpowers/specs/` | Approved designs — what we are building and why. `YYYY-MM-DD-<topic>-design.md`. | Per change |
| `docs/plans/` | Step-by-step execution of a design, with verification per step. `YYYY-MM-DD-<topic>-plan.md`. Kept after merge as the record of how something was built. | Per change |
| `docs/ongoing/` | Handover notes for work in flight — what is done, what is blocked, what local state a successor needs. One file per ticket, **deleted on merge**. | Days |

Reference material sits outside that progression and stays current: `docs/local-development.md`, `docs/worktrees.md`, `docs/migrations.md`.

Each directory has a `README.md` stating its purpose and pointing back here. **This file remains the single source of truth for conventions** — branching, tickets, commit format, the complexity gate, the engineering rules. Documents under `docs/` should link to it rather than restating it, so there is one copy to keep correct. Stale duplication is a real failure mode here: the compose headers spent weeks telling people to run shell scripts that had been replaced by `scripts/dev.mjs`.

A design that has shipped is not deleted or silently rewritten. Mark its status, and record where the implementation departed from it and why — see the "Changes since approval" section in `docs/superpowers/specs/2026-08-05-agentic-workspace-in-repo-design.md`.

## Code quality gate (enforced, not optional)

- **Cognitive complexity must be < 15** for every file (SonarJS rule S3776; see `.eslintrc.complexity.cjs`). This is why the backend `utils/` folder is split into dozens of small `*Helpers.js` files — when a route/service grows complex, extract helpers rather than nesting logic. Follow this pattern.
- SonarQube scans both apps in CI (`sonar-project.properties` in each). Backend excludes `src/assets/**`.

## Branching, tickets and worktrees

**When starting any feature or fix, ask the user for the work type and the ticket number before creating a branch.** Do not invent a branch name. `npm run worktree -- new` prompts for exactly this and composes the name; use it rather than raw `git checkout -b`.

- **Branch naming**: `<type>/<TICKET>_<snake_case_description>` — e.g. `feature/ISO-412_time_tracking`, `bugfix/ISO-98_login_spinner`. Types are `feature/`, `bugfix/`, `hotfix/`. The ticket keeps its own hyphen; the description is snake_case, matching the 20-of-27 majority of existing branches.
- **Tickets are required** and validated as `PREFIX-NUMBER`. Note this is a *new* convention — no existing branch or commit carries a ticket, so do not expect to find them in history.
- **Base branches**: `feature/` and `bugfix/` branch from `origin/develop`; `hotfix/` from `origin/main`. PRs target `develop` except hotfixes.
- **Commit messages** follow the loose convention already in use: `feat:`, `fix:`, `refactor:`. Include the ticket in the PR title or body.

Be aware the repository's actual history diverges from this: of the last 40 merges into `main`, only 9 came from `develop` — 31 were topic branches merged straight to production. `main` and `develop` have drifted apart. Prefer the documented flow; flag it rather than copying the drift.

`npm run worktree -- new` also handles environment initialization: it allocates a port pair no other worktree has reserved, copies the gitignored `Backend/.env` / `Frontend/.env.local`, and **rewrites the copied `MONGODB_URI` to point at that worktree's own database**. Without that rewrite an `--isolated-db` worktree is only isolated inside Docker — anything run natively (`npm run migrate`, `npm run schema`, `npm run dev` in `Backend/`) reads the file directly and would silently hit the shared database.

## Code style: pure functions and lodash

- **Prefer pure functions.** A function that takes its inputs as arguments and returns a value — no hidden reads of module state, no mutation of its arguments, no I/O — is why the cognitive-complexity gate is satisfiable at all, and it is the reason `Backend/src/utils/` is 73 small `*Helpers.js` files. Continue that pattern: keep I/O and Express/React concerns at the edges, and push logic into helpers that can be reasoned about and tested in isolation.
- **Do not mutate inputs.** Return new objects and arrays. This matters especially in the Frontend, where mutating state defeats React's change detection.
- **`lodash-es` is available in both apps** (ESM, tree-shakeable — import named functions, never the default namespace):

  ```js
  import { groupBy, isEqual, cloneDeep } from 'lodash-es'
  ```

  Reach for it where it genuinely beats hand-rolled code: `cloneDeep`, `isEqual`, `get`/`set` for uncertain paths, `groupBy`/`keyBy`/`partition`, `debounce`/`throttle`, `chunk`, `uniqBy`, `omit`/`pick`. These replace exactly the nested loops and guard pyramids that drive cognitive complexity over the limit.

  **Prefer native where native is already clear** — `map`/`filter`/`reduce`, `Object.entries`, spread, optional chaining and `??`. Wrapping a one-line native expression in a lodash call adds a dependency hop without reducing complexity. The goal is simpler code, not maximal lodash.

- **`scripts/` is deliberately dependency-free** and must stay that way — no lodash there. It runs on a fresh clone before any `npm install`, and there is no root `node_modules`. Pure functions still apply: see `scripts/lib/branch.mjs`, which is entirely pure and therefore trivially checkable.

## Logging in locally

The login screen's primary **Sign in with ISO+™** button starts an OAuth flow against the live `app.isoplus.online`, which cannot complete locally — the ISO+ credentials are blank in a local `Backend/.env`. Do not try to make that path work offline; use the credentials path the app already ships:

- `npm run dev:user` sets a known password (`local-dev-only`) on the seeded `support_admin` account and prints it. Then click **administrator credentials** at the bottom of the login screen and sign in.
- `npm run seed` replaces the `users` collection and clears that password. Re-run `dev:user` afterwards; `seed` prints a reminder.
- The script writes one row in a local database using an already-shipping route. It adds **no** auth code to the application, and refuses any non-local `MONGODB_URI` with no override flag. Do not add a dev-login endpoint or a `NODE_ENV` branch to the auth routes — that would put a real auth bypass in a repo that auto-deploys.

**Being logged in is not the same as having data.** Several endpoints proxy to the live ISO+ API rather than reading Mongo — `GET /api/workspaces` is one — and return `401` with `{"error_type":"oauth"}` without a real `PERSONAL_ACCESS_TOKEN`. That is also why the seeded `workspaces` collection is empty while `boards` is not. Anything backed by seeded Mongo data works locally; anything needing live ISO+ data does not. When a local 401 appears, check the response body before assuming the session broke: `{"message":"Authentication required"}` is the auth middleware, `{"error_type":"oauth"}` is the upstream ISO+ call.

## Database schema and migrations

Schema changes go through **migrations**, never a manual edit to the database. Full detail in `docs/migrations.md`.

**Before writing a migration — or any feature that changes the shape of stored data — run `npm run schema`** (optionally `npm run schema -- <collection>`, or `--json` when you want to parse it). Do not infer the current shape from `Backend/src/models/*.js` alone: the models say what the code expects, and the data frequently disagrees. The report prints, per collection, the declared Mongoose paths beside what a live sample actually contains, the real indexes, and an explicit **drift** section:

- *declared but absent from the sample* — the model gained a field existing documents never got. A schema `default` applies to new documents only; it does **not** backfill stored ones. If code will read the field, the migration must write it.
- *in the data but not in the model* — removed from the schema but never cleaned up. Only drop it once you have confirmed nothing reads it.
- *required but not universally present* — a migration assuming the field exists will throw partway and leave the collection half-migrated. Guard the query.

Then:

- `npm run migrate -- create <name>` scaffolds into `Backend/migrations/` as **`.js`** (ESM, matching the rest of the Backend). Migrations are committed.
- Both `up` and `down` receive the live Mongoose connection. **Always write a real `down`** — a migration that cannot be rolled back cannot be safely deployed. Prefer raw `connection.collection(...)` access over importing models, which drift over time.
- `up`/`down` take the bare name (`add-archived-flag`), not the filename.
- Never edit a migration that has already run anywhere but your own machine — write a new one.
- Migrations do **not** run automatically on boot or deploy; that is deliberate (containers would race, and a bad migration would become an outage with no decision point). The wrapper refuses non-local database URIs unless given `--allow-remote`.

### Engineering rules (binding)

The codebase is production and **deploys automatically on merge**, so:

- **No unrequested refactors.** Change what was asked for and nothing else.
- **No breaking changes** to existing behavior, routes, or data shapes.
- **Minimal, surgical edits.** Prefer the smallest diff that solves the problem.
- **Explain a change before applying it**, especially anything touching auth, sync, PDF generation or Xero.

### Agent and editor configuration

Per-developer agent/editor config — `.claude/`, `.agents/`, `.agent-native/`, `.cursor/`, `.vscode/`, `.opencode/`, `.mcp.json`, `opencode.json`, `agent-native.json` — is **intentionally gitignored**. The shared, reviewable project setup is `docker-compose*.yml`, `scripts/`, `docs/`, `.gitattributes`, `AGENTS.md` and this file. Do not commit personal tooling config; do not assume a teammate has the same tools.

**`AGENTS.md` is a tracked symlink to this file.** Every assistant — Claude Code, Codex, opencode, Cursor — reads the same instructions. Edit `CLAUDE.md`; never edit `AGENTS.md` directly or replace it with a copy, and never let the two diverge.

**Skills are shared across all assistants, not per-tool.** `.agents/skills/` is canonical; `.claude/skills/` and `.opencode/skill/` are symlinks to it. A skill installed by any tool is therefore immediately visible to all of them. Do not copy a skill from one tool's directory into another — that is what caused the drift this replaced, where `isoplus-local-env` existed only for Claude Code. To adopt a new assistant, add a row to `TOOL_SKILL_DIRS` in `scripts/lib/agentsync.mjs` and run `npm run agents`, which adopts anything unique to that tool before linking.

`npm run agents` unifies both; `npm run agents -- --check` and `npm run doctor` report drift without changing anything.

## Backend architecture

Entry point `src/index.js` wires everything: Sentry (`instrument.js`, imported first), CORS (allow-list from `ALLOWED_ORIGINS`), `express-session` backed by MongoDB (`connect-mongo`), `express-mongo-sanitize`, request-context + audit middleware, then mounts routers under `/api/*`.

- **Routing pattern**: `src/routes/*.js` are Express routers mounted in `index.js`. Routes contain controller logic inline but delegate heavy transformation to `src/utils/*Helpers.js` and `src/services/*`. There is no separate controllers layer.
- **Models**: `src/models/*.js` are Mongoose schemas (User, Workspace, Board, Item, Business, SyncExecution, AuditTrail, OAuthTicket, PDFLink, Subscription, etc.).
- **Auth** (`src/middleware/auth.js` + `authHelpers.js`):
  - `authenticateToken` reads a JWT from `req.session.token` (JWT lives in the session, not a bearer header), verifies it, and applies role scoping. Roles are `isoplus_user | support_admin | owner` (see `User.js`). `isoplus_user` is authorized per-workspace/board via `authorizeIsoplusUser`.
  - `validateApiKey` guards admin/webhook routes with the `Admin_API_Key` env var (compared against the raw `Authorization` header).
  - Login is an **ISO+ OAuth flow** (`routes/auth.js` → `services/isoplus.js`), using signed OAuth state and short-lived `OAuthTicket` records for the frontend handoff.
- **Board sync (BullMQ + Redis)**: `services/sync/queue.js` defines the `board-sync` queue; `workers/syncWorker.js` is the worker (started on boot from `index.js`). Both build their own ioredis connection and support cluster mode via `REDIS_CLUSTER=true` (AWS ElastiCache Serverless, TLS, hash-tagged queue name `{board-sync}`). Failed jobs are retried on startup. Queue is monitored via Bull Board at `/api/queues`.
- **PDF generation**: uses `@pdfme/*` with JSON templates in `src/assets/` (`NDISinvoice.json`, `quote.json`, `monthlyStatement.json`, etc.). Webhook-driven PDF generation lives in `utils/webhook*Helpers.js` and is exposed under `/api/pdf` and `/api/webhooks`.
- **Xero**: `services/xero.js` + `routes/xero.js` (`xero-node` SDK), OAuth callback at `/api/xero/callback`.
- **Logging**: use `src/utils/logger.js` (`info`/`warn`/`error`), which is Winston with MongoDB + daily-rotate transports and log sanitization (`loggerSanitizeHelpers.js`, `sanitizeLog.js`). Pass the `req` as the last arg to attach request context. Do not use `console.log`.
- **Errors**: centralized `middleware/errorHandler.js` is mounted last, after the Sentry error handler.

## Frontend architecture

Next.js App Router under `Frontend/app/`. Path alias `@/*` maps to the Frontend root (`tsconfig.json`).

- **Routing** is driven by the ISO+ domain hierarchy: `app/workspace/[id]/board/[boardId]/{invoice-generator,monthly-statement,qr-generator,export,configuration}`. Workspace- and board-scoped pages live under these dynamic segments.
- **Global state**: `app/context/index.tsx` (`ContextProvider`) holds `user`, `workspaces`, `syncStatuses`, `currentWorkspaceId`, hydrated from `localStorage`. Wrapped around the app in `app/layout.tsx` alongside `next-themes` `ThemeProvider` (default light).
- **API calls**: import the shared axios instance from `app/utils/axiosConfig.ts` (sets `withCredentials = true` so the session cookie is sent). Backend base URL comes from `NEXT_PUBLIC_BACKEND_URL`. There is request de-duplication in `app/utils/requestDedupe.ts`.
- **Feature code convention**: each large feature is decomposed in `lib/` into `-page-view.tsx` (view), `-helpers.ts` (logic), and `use-*.ts` hooks — e.g. `invoice-generator-*`, `monthly-statement-*`, `qr-generator-*`. This split keeps files under the complexity gate; mirror it when adding features.
- **UI**: shadcn/ui components live in `components/ui/` (configured via `components.json`, base color neutral, CSS variables). Use lucide-react for icons and Tailwind for styling; don't add other UI/icon libraries (per `.bolt/prompt`).
- Both frontend and backend report to Sentry (`instrumentation-client.ts` / `NEXT_PUBLIC_SENTRY_DSN`).

## Deployment (CI/CD)

`.github/workflows/cicd.yml` runs on push/PR to `main` and `develop`, path-filtered to `Backend/**` / `Frontend/**`:
- SonarQube scan for whichever app changed.
- **Backend only** is packaged and deployed to AWS Elastic Beanstalk (via S3): `develop` → `isoplus-be-dev-blue`, `main` → `isoplus-be-prod-blue` (region `ap-southeast-2`). The frontend is not deployed by this workflow.
- `develop` is the default working branch; open PRs against `develop`.
- EB nginx/ALB timeouts are tuned in `Backend/.platform/` and `Backend/.ebextensions/` (long-running sync/PDF requests).

## Environment

Copy `.env.example` in each app. Backend **requires** `MONGODB_URI`, `JWT_SECRET`, `SESSION_SECRET` (process exits on boot if missing). Other important backend vars: ISO+ OAuth (`CLIENT_ID`/`CLIENT_SECRET`/`PERSONAL_ACCESS_TOKEN`/`*_ENDPOINT`/`CALLBACK_URL`), Xero (`XERO_*`), AWS (`AWS_*`, `AWS_BUCKET*`), `Admin_API_Key`, `ALLOWED_ORIGINS`, and Redis (`REDIS_HOST`/`REDIS_PORT`/`REDIS_CLUSTER`/`REDIS_TLS`/`REDIS_PASSWORD`). Frontend needs `NEXT_PUBLIC_BACKEND_URL` (and optional `NEXT_PUBLIC_TRUSTED_ORIGINS`, `NEXT_PUBLIC_SENTRY_DSN`).
