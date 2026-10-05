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
- `npm test` — **Vitest** (`vitest run`), added in PR #848. Also `test:watch`, `test:coverage`, and `test:api:live` (`RUN_REAL_API_TESTS=1`, a separate config that hits the real ISO+ API and is excluded from the default run).
- Tests live in `Backend/test/`: `unit/`, `integration/` (supertest against `createApp()`), `msw/` (ISO+ HTTP mocks), `real-api/`, plus `fixtures/` for committed sample data. `vitest.config.js` includes `test/**/*.test.js` only — a `.mjs` suffix will not be collected.
- `test/setup.js` starts `mongodb-memory-server` and mocks `ioredis`, so the suite needs neither a database nor Redis. It prefers a system mongod when `MONGOMS_SYSTEM_BINARY` or `/usr/bin/mongod` exists.
- There is no lint script — complexity is enforced by SonarQube (see below).

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
| `docs/open/` | Documentation for readers **outside this repo** — chiefly the ISO+ teams, who integrate via webhooks and have no source access. Describes interfaces from the outside; never file paths or internals. | Ongoing |

Reference material sits outside that progression and stays current: [`docs/agent-setup.md`](docs/agent-setup.md) (what an AI agent needs outside the code: tool access, local environment, databases, backups), [`docs/full-stack-engineering.md`](docs/full-stack-engineering.md), `docs/local-development.md`, `docs/worktrees.md`, `docs/migrations.md`, `docs/scheduling.md`, [`docs/release-runbook.md`](docs/release-runbook.md) (read before any production release, and add any new migration to its pending table).

## How to work here

**[`docs/full-stack-engineering.md`](docs/full-stack-engineering.md) is required reading before changing code.** This file says what the conventions are; that one says how to work — test-first, end-to-end coverage, change control, security, code quality. It links back here rather than restating, so there is one copy of each rule.

Three of its rules decide what you do on the first step, so they are repeated here and nowhere else:

- **Write the failing test first.** Write the test, run it, watch it fail for the expected reason, then implement. Bug fixes too — the failing test is the reproduction. Never weaken an assertion to get to green; decide whether the code or the expectation was wrong, and say which.
- **Characterize before you move.** Relocating existing behaviour needs a test that passes against the *unmodified* code first. "No behaviour change" with no test that ran beforehand is an assertion, not evidence.
- **A user-visible change needs an end-to-end test** (Playwright, `Frontend/e2e/`). A feature with perfect unit tests that nothing links to is not done.

Every assistant gets this by the same route: `AGENTS.md` is a symlink to this file, and `.cursor/rules/full-stack-engineering.mdc` points at both rather than keeping its own copy. Run `npm run agents -- --check` to verify that wiring.

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
- **Never push directly to `develop` or `main`.** Every change, including a docs-only or single-line fix, goes through a branch and a PR. There is no size or risk threshold that excuses a direct push — this repo deploys automatically on merge, and a direct push skips the one review step that catches a bad merge before it ships.

Be aware the repository's actual history diverges from this: of the last 40 merges into `main`, only 9 came from `develop` — 31 were topic branches merged straight to production. `main` and `develop` have drifted apart. Prefer the documented flow; flag it rather than copying the drift.

### Keeping a branch current: rebase, do not merge

**When `develop` moves ahead of your branch, rebase onto it.** Do not merge
`develop` into your branch. A merge commit buries the conflict resolution inside
a commit nobody reads, and leaves a diff against `develop` that no longer matches
the commits that produced it.

```bash
git fetch origin
git tag -f backup/pre-rebase-<TICKET> HEAD     # 1. always, before rewriting anything
git rebase origin/develop                      # 2.
# resolve, then: git rebase --continue
git diff backup/pre-rebase-<TICKET> HEAD       # 3. MUST be empty
npm test --prefix Backend                      # 4.
git push --force-with-lease                    # 5. never plain --force
```

**Step 3 is the one people skip, and it is the one that makes this safe.** A
rebase replays every commit, so a bad conflict resolution silently changes the
final content. If that diff is empty the history changed and the code did not,
which is exactly the claim a force-push is making. If it is not empty, you have
found a real mistake — investigate before pushing.

**`--force-with-lease`, never `--force`.** It refuses if anyone else pushed since
you last fetched, instead of overwriting their work.

**Turn on rerere once**, and git records each conflict resolution and replays it
automatically when the same conflict reappears — which it will, since a rebase
replays every commit that touched the file:

```bash
git config rerere.enabled true
git config rerere.autoUpdate true
```

#### Resolving the conflicts this repo actually produces

Nearly all of them are `package.json` and lockfiles, because both sides add
dependencies.

- **`package.json`** — a union, almost always. Both sides added entries; keep
  both. Read the two sides rather than taking one wholesale: `--ours` during a
  rebase means `develop`, not your branch, which is the reverse of what people
  expect and a fast way to silently drop your own work.
- **Lockfiles — regenerate, never hand-merge.** Take one side, then
  `npm install --package-lock-only` in that app so npm reconciles it against the
  merged `package.json`. A hand-edited lockfile can look plausible and fail
  `npm ci` with `Missing: <pkg> from lock file`.
- **`yarn.lock`** is committed but vestigial; CI uses `npm ci`. Nobody here has
  yarn installed, so it cannot be regenerated — restore it from the backup tag
  rather than leaving it disagreeing with `package.json`. That mismatch is real
  drift even though nothing currently reads it.

#### When a merge is right after all

Rebase rewrites history, so do not rebase a branch other people are committing
to. Merge that one, or agree the rewrite first. Everything else — a topic branch
with one author, which is nearly all of them here — rebases.

`npm run worktree -- new` also handles environment initialization: it allocates a port pair no other worktree has reserved, copies the gitignored `Backend/.env` / `Frontend/.env.local`, and **rewrites the copied `MONGODB_URI` to point at that worktree's own database**. Without that rewrite an `--isolated-db` worktree is only isolated inside Docker — anything run natively (`npm run migrate`, `npm run schema`, `npm run dev` in `Backend/`) reads the file directly and would silently hit the shared database.

### Before you push: build and test the whole app, not the file you touched

**Every push runs the full suite of each app you changed, and a real build of the
Frontend if you changed it.** Not the one test file, not `-t 'the name'`. A
scoped run answers "did my change work"; the full run answers "did my change
break someone else's", and merging deploys, so nobody else gets to answer it
for you.

```bash
npm test --prefix Backend                    # Backend/**  touched
cd Frontend && npm run lint && npm run build # Frontend/** touched
```

`next.config.js` sets `eslint.ignoreDuringBuilds: true`, so the build will not
fail on a lint error — run `lint` yourself or it is never run at all.

**Run it with your `.env` files in place, the way your machine really is.**
`Backend/src/utils/logger.js` calls `dotenv.config()` at import, and almost
everything imports the logger, so `Backend/.env` is loaded into the test process
— while CI has no `.env` and no AWS or ISO+ credentials at all. That gap runs
both ways and both are real:

- A test that passes in CI and fails locally is usually *the test* reading an
  environment CI does not have. It found a genuine hole in the assertion.
- A test that passes locally and fails in CI is usually the code depending on a
  credential the deployed environment will not have either.

Neither is "flaky" and neither is fixed by re-running. A test whose outcome
depends on the machine must save and restore every variable it depends on, so
it decides its own environment instead of inheriting one.

Paste the actual output into the PR's Verification section. If something is
genuinely unrunnable, say which part and why — that is a sentence, not a
reason to skip the rest.

## Pull requests

A PR description is written for the person who has to review it and for whoever reads it in a year wondering why the code looks like this. Because merging deploys, the reviewer's first question is always "what is the blast radius" — answer it before they ask.

Include, in this order, and omit any section that genuinely does not apply rather than writing "N/A":

1. **Summary** — what changed and why, in a few sentences. Lead with the problem, not the solution.
2. **Ticket** — `PREFIX-NUMBER`, in the title or the body.
3. **What's included** — grouped by area, not a commit list. The commit log is already in the PR; the description is the part it cannot generate.
4. **Blast radius** — which apps are touched, whether any existing route, response shape or stored data changes, and whether auth, sync, PDF generation or Xero is involved. If the answer is "none", say so explicitly; that is the most useful sentence in the description.
5. **New dependencies** — each one, and why it was worth adding. Reviewers of an auto-deploying repo care.
6. **Migrations** — whether any are included, and that they do not run automatically on deploy, so someone must run them deliberately.
7. **Verification** — the commands actually run and their actual output. Not "tested locally". If something is unverified, say which part and why.
8. **Follow-ups** — known gaps deliberately left out of scope.

Two rules about the content:

- **Claims need evidence.** "All containers healthy" is worth nothing without the output that shows it. Paste the real thing.
- **No AI attribution anywhere.** No `Co-Authored-By` trailer on commits, no "Generated with" line in the PR body.

PRs target `develop` except hotfixes, which target `main`.

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

## Constants

**A feature's fixed values live in one file: `Backend/src/constants/<feature>.js`,** or `Frontend/constants/<feature>.ts` (imported as `@/constants/<feature>`) for frontend ones. Not inline in a route, a service or a JSX attribute, and not re-declared per module. See `Backend/src/constants/scheduler.js` for the shape.

Five rules make that file worth having rather than just another hop:

- **Record each constant's touchpoints in a comment** — the modules that read it — so changing a value tells you what it reaches without a grep. Keep the list current when you add a consumer. A stale touchpoint comment is worse than none, because it will be believed.
- **The constants file imports nothing.** That is what lets a model and a service both read it without a cycle: models already import from services here (`models/ScheduledJob.js` → `services/scheduler/nextRun.js`), so a constants file with its own imports can close the loop.
- **One import path, so do not re-export.** When you move a constant out of a module, delete the original and repoint every consumer — including tests. Leaving a re-export behind means two valid ways to import the same value, which is the inconsistency the file exists to remove.
- **Derived structures stay with their logic.** A `Set`/`Map` built *from* constants — `registry.js`'s `POLICIES` — is not itself a constant. Keeping it derived is what stops a new policy being added without the validator learning about it.
- **Object constants are a shared mutable.** Nothing freezes them, and freezing one that a library may normalise (a Mongoose options object) is a behaviour change, not a refactor. Say in the comment that it is read-only by convention.

**Do not add a 28th hardcoded `'Australia/Sydney'`.** It appears 27 times across 17 backend files, with four files each declaring their own private `SYDNEY_TIME_ZONE`/`DEFAULT_XERO_TIMEZONE` copy, and `'en-AU'` is inline 15 more times. These reach invoice dates, statement dates and Xero due dates, so a wrong default is a billing-correctness bug rather than a cosmetic one. Consolidating them is real work with real blast radius and wants its own ticket — but new code reads the constant, it does not add to the pile.

## Logging in locally

Password login was removed in KAN-27. The login screen's primary **Sign in with ISO+™** button starts an OAuth flow against the live `app.isoplus.online`, which cannot complete locally unless you hold real ISO+ app credentials. Do not try to make that path work offline; use the path the app already ships:

- `npm run dev:login` prints a one-time URL (`http://localhost:3100/?ticket=…`) that signs you in as a local `support_admin`. It inserts a one-time OAuth ticket in this worktree's database and the app's own `oauth-exchange` route redeems it.
- It needs two `Backend/.env` settings or the session is refused: a non-empty `PERSONAL_ACCESS_TOKEN` (e.g. `local-offline-placeholder`) with `ISOPLUS_OFFLINE=1`, and a **blank** `GOOGLE_TARGET_GROUP`. The command warns when either is wrong. Details in [`docs/local-development.md`](docs/local-development.md#logging-in-locally).
- It adds **no** auth code to the application and refuses any non-local `MONGODB_URI`. Do not add a dev-login endpoint or a `NODE_ENV` branch to the auth routes — that would put a real auth bypass in a repo that auto-deploys.
- `npm run seed` replaces the `users` collection; run `dev:login` again afterwards.

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
  - `validateApiKey` guards admin/webhook routes with the `Admin_API_Key` env var (compared against the raw `Authorization` header). `validateSchedulerApiKey` is the same check against `SCHEDULER_API_KEY` (plus the optional per-kind `SCHEDULER_API_KEY_INVOICE` / `SCHEDULER_API_KEY_STATEMENT`, where the presented key *is* the scope) and guards only `POST /api/scheduler/tick` — a separate credential because it lives in an AWS EventBridge rule and rotates on its own schedule. **Both come from one `apiKeyValidator` factory; add a gate by calling it, not by copying it.** Its signature and the per-kind scoping rules are in [`docs/scheduling.md`](docs/scheduling.md).
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

Copy `.env.example` in each app. Backend **requires** `MONGODB_URI`, `JWT_SECRET`, `SESSION_SECRET` (process exits on boot if missing). Other important backend vars: ISO+ OAuth (`CLIENT_ID`/`CLIENT_SECRET`/`PERSONAL_ACCESS_TOKEN`/`*_ENDPOINT`/`CALLBACK_URL`), Xero (`XERO_*`), AWS (`AWS_*`, `AWS_BUCKET*`), `Admin_API_Key`, `SCHEDULER_API_KEY`, `ALLOWED_ORIGINS`, and Redis (`REDIS_HOST`/`REDIS_PORT`/`REDIS_CLUSTER`/`REDIS_TLS`/`REDIS_PASSWORD`). Frontend needs `NEXT_PUBLIC_BACKEND_URL` (and optional `NEXT_PUBLIC_TRUSTED_ORIGINS`, `NEXT_PUBLIC_SENTRY_DSN`).
