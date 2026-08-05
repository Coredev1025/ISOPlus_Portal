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

## Code quality gate (enforced, not optional)

- **Cognitive complexity must be < 15** for every file (SonarJS rule S3776; see `.eslintrc.complexity.cjs`). This is why the backend `utils/` folder is split into dozens of small `*Helpers.js` files — when a route/service grows complex, extract helpers rather than nesting logic. Follow this pattern.
- SonarQube scans both apps in CI (`sonar-project.properties` in each). Backend excludes `src/assets/**`.

### Engineering rules (binding)

The codebase is production and **deploys automatically on merge**, so:

- **No unrequested refactors.** Change what was asked for and nothing else.
- **No breaking changes** to existing behavior, routes, or data shapes.
- **Minimal, surgical edits.** Prefer the smallest diff that solves the problem.
- **Explain a change before applying it**, especially anything touching auth, sync, PDF generation or Xero.

### Agent and editor configuration

Per-developer agent/editor config — `.claude/`, `.agents/`, `.agent-native/`, `.cursor/`, `.vscode/`, `.mcp.json`, `opencode.json`, `agent-native.json` — is **intentionally gitignored**. The shared, reviewable project setup is `docker-compose*.yml`, `scripts/`, `docs/`, `.gitattributes` and this file. Do not commit personal tooling config; do not assume a teammate has the same tools.

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
