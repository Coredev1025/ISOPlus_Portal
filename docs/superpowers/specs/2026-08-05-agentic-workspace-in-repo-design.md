# Repo-native agentic workspace, Docker and worktrees

**Date:** 2026-08-05
**Status:** Implemented, with deviations — see "Changes since approval" below.

> This document has been updated to describe what shipped. Where the
> implementation departed from the approved design, the departure and its reason
> are recorded in [Changes since approval](#changes-since-approval) rather than
> quietly rewritten. Conventions that outlived this document live in
> [`CLAUDE.md`](../../../CLAUDE.md); operational detail lives in
> [`docs/local-development.md`](../../local-development.md) and
> [`docs/worktrees.md`](../../worktrees.md), which supersede this spec as the
> source of truth.

## Changes since approval

| Designed | Shipped | Why |
|---|---|---|
| Four POSIX shell scripts (`dev-up.sh`, `dev-down.sh`, `worktree.sh`, `db-restore.sh`) | One Node CLI, `scripts/dev.mjs` plus pure helpers in `scripts/lib/*.mjs`, exposed as npm scripts | Shell required Git Bash on Windows, and the port probe used `ss -ltn`, which is Linux-only. Node runs unmodified on Linux, macOS and Windows including PowerShell. `scripts/` stays dependency-free so it works on a fresh clone before any `npm install`. |
| Worktrees as siblings of the main clone, outside it | `worktrees/` at the top of the main clone, gitignored | A worktree no longer depends on a directory outside the repository. The build-context and `next build` reasons still hold at the new location; the repo-root glob reason does not, and is documented in `docs/worktrees.md`. |
| `db-restore.sh` | `npm run seed` | Folded into the Node CLI with the same `--nsFrom`/`--nsTo` remap and confirmation prompt. |

Also shipped, beyond the scope of this design:

- **Migrations** — `npm run migrate` and the `npm run schema` drift inspector.
  See [`docs/migrations.md`](../../migrations.md).
- **Local login** — `npm run dev:user`, so local work does not depend on the
  live ISO+ OAuth flow. See
  [`2026-08-05-local-auth-design.md`](2026-08-05-local-auth-design.md).
- **Skill unification** — `npm run agents`, making `.agents/skills/` canonical
  and linking each assistant's directory to it.
- **`npm run doctor`** — prerequisite and drift checks.

Added later on the same branch, 2026-08-06:

- **Offline mode** — the stack is usable with no ISO+ credentials at all.
  `npm run dev:user` got a developer *logged in*; it did not get them a
  workspace, because `GET /api/workspaces` proxies ISO+ rather than reading
  Mongo. See
  [`2026-08-05-local-auth-design.md`](2026-08-05-local-auth-design.md#changes-since-approval).
- **`npm run dev:fixture`** — a committed, invented NDIS quote scenario
  (`Backend/test/fixtures/`), loaded into local Mongo. The counterpart to
  `npm run seed`: that restores a real, gitignored, destructive dump; this is
  small, reviewable and additive.
- **Engineering standards as shared instructions** —
  [`docs/full-stack-engineering.md`](../../full-stack-engineering.md), linked
  from `CLAUDE.md`, with `.cursor/rules/` reduced to a pointer. It previously
  held its own copy of the standards, which no other assistant could read and
  which said nothing about tests. This completes the goal of one set of
  instructions for every assistant: `AGENTS.md` → `CLAUDE.md` →
  `docs/full-stack-engineering.md`, with each rule written once.
- **A runnable test suite in the dev containers.** `develop` gained Vitest,
  `mongodb-memory-server`, `msw`, `supertest` and Playwright via PR #848, but
  neither suite could run here: the backend image lacked `libcurl4`, which the
  downloaded mongod needs, and the frontend image lacked Chromium's shared
  libraries. Both Dockerfiles now install them. 140 unit/integration tests and
  8 end-to-end tests pass in-container.

### A boundary this design drew, and one place it leaked

The ignore block for `.claude/`, `.agents/`, `.agent-native/`, `.vscode/`,
`.mcp.json`, `opencode.json` and `skills-lock.json` is deliberate and stays:
that is per-developer tooling, not imposed on the team. What is shared is
`CLAUDE.md`, the tracked `AGENTS.md` symlink, `docs/`, `scripts/` and the
compose files. Auditing this is worthwhile precisely because the list *looks*
like an accident and is not.

`.cursor` was the leak. It was blanket-ignored alongside the rest, while
`.cursor/rules/full-stack-engineering.mdc` was tracked — an undocumented
exception that worked only because ignore rules do not apply to already-tracked
files. Any **new** rule file was silently unaddable without `git add -f`, which
is the "invisible to git" defect this design exists to fix, still live for one
assistant.

Resolved 2026-08-06 by narrowing the pattern to `.cursor/*` with `.cursor/rules/*.mdc`
re-included. It is spelled out rather than written as `.cursor/` plus a negation
because **git cannot re-include a file whose parent directory is excluded** — the
obvious one-line fix would have appeared to work and done nothing.

The rules are the right thing to share: they carry project standards and point
at `AGENTS.md` and [`docs/full-stack-engineering.md`](../../full-stack-engineering.md),
so a Cursor user who does not get them does not get the conventions either.
`.cursor/mcp.json` stays ignored — that is per-developer server configuration.

## Problem

The agentic development workspace for ISO+ Portal exists only as untracked files
inside the working clone. `docker-compose.yml`, both `Dockerfile`s, `CLAUDE.md`,
the agent tool configs (`.claude/`, `.agents/`, `.agent-native/`, `.cursor/`,
`.vscode/`, `.mcp.json`, `opencode.json`) and the local-dev knowledge captured in
the `isoplus-local-env` skill are all invisible to `git`. Nothing survives a
fresh clone, and none of it is reviewable by the team.

Three concrete defects follow from this:

1. **The local-dev stack cannot run twice.** `docker-compose.yml` hardcodes
   `container_name:` for all four services and fixes host ports, so a second
   checkout cannot bring up its own stack. Worktrees are therefore unusable for
   anything that needs the app running.
2. **Local-dev knowledge is trapped in a personal skill file.** The operational
   detail (ports, health-gating, the empty-`PORTS`-column failure mode) lives in
   an untracked `SKILL.md` that no teammate can read.
3. **There is no seeding path.** A MongoDB dump exists at
   `~/Downloads/my_database_backup.gz`, but nothing documents or automates
   restoring it, and its database name does not match what the app expects.

## Goals

- Commit the project-level workspace — Docker, docs, `CLAUDE.md`, scripts — to
  the repo so a fresh clone is enough to get running.
- Keep per-developer agent tooling out of the shared repo while keeping it
  working on this machine.
- Make git worktrees genuinely usable: two branches running their stacks side by
  side.
- Give the seed dump a documented, repeatable restore path that never risks
  committing customer data.
- Leave `/home/allanaire/hillsgrade/` as personal space, unchanged.

## Non-goals

- Changing production deployment, CI, or `.github/workflows/cicd.yml`.
- Any application code change in `Backend/` or `Frontend/`.
- Refactoring the existing Dockerfiles; they work and stay as they are.
- Anonymizing the dump. It stays local and gitignored instead.

## Decisions

Four decisions were taken before design, and they constrain everything below.

| Decision | Choice | Rationale |
|---|---|---|
| Git tracking scope | Docker, docs and `CLAUDE.md` only | The repo is shared, production, and auto-deploys. Agent tool config is per-developer and would surprise teammates using other tools. |
| Worktree isolation | Shared infra, per-worktree apps | One `mongo`/`redis` for all worktrees; each worktree runs only `backend` + `frontend`. Low RAM, seed restored once. Isolated DB available as an opt-in escape hatch. |
| Seed data | Gitignored `seed/` plus a committed restore script | Teammates get the tooling; the customer data never leaves this machine. |
| Database name | Remap on restore to `business-dashboard` | Confirmed authoritative by `Backend/.env.example`. Local then matches deployed config; the dump's `isoplus` namespace is remapped at restore time. |

## Architecture

### The personal / project boundary

`/home/allanaire/hillsgrade/` remains personal and is not modified:
`.claude/settings.local.json` (permission allowlist) and the proposal, estimate
and PDF files already present. No project artifacts are added to it.

Within `isoplus-portal/`, files fall into three tiers.

**Tier 1 — committed.**

```
docker-compose.yml            backend + frontend only, no container_name
docker-compose.infra.yml      shared mongo + redis
.env.docker.example           documented port and DB overrides
Backend/Dockerfile            unchanged
Backend/.dockerignore         unchanged
Frontend/Dockerfile           unchanged
Frontend/.dockerignore        unchanged
CLAUDE.md                     plus a worktrees/local-stack section
docs/local-development.md     new
docs/worktrees.md             new
scripts/dev.mjs               new — the whole CLI
scripts/lib/*.mjs             new — pure helpers it composes
package.json                  new — npm script surface, no dependencies
.gitignore                    extended
```

**Tier 2 — present locally, added to the tracked `.gitignore`.**

`.claude/`, `.agents/`, `.agent-native/`, `.cursor/`, `.vscode/`, `.mcp.json`,
`opencode.json`, `seed/`, and per-worktree `.env`.

These are ignored via the *tracked* `.gitignore` rather than
`.git/info/exclude`, so teammates are likewise protected from committing their
own agent config.

**Tier 3 — the one migration.**

`.cursor/rules/full-stack-engineering.mdc` is cited by `CLAUDE.md` as binding
project policy (no unrequested refactors, no breaking changes, minimal surgical
edits, explain before applying). It is project policy, not personal tooling, so
its substance moves into `CLAUDE.md`. The `.cursor/` directory itself stays
ignored.

### Compose split

`docker-compose.infra.yml` — project name `isoplus-infra`, owning the two
stateful services:

- `mongo` (image `mongo:7`, volume `mongo-data`, publishes `${MONGO_PORT:-27017}`)
- `redis` (image `redis:7-alpine`, volume `redis-data`, publishes `${REDIS_PORT:-6380}`)
- Both keep their existing healthchecks.
- Declares a network that app stacks join as `external: true`.

`docker-compose.yml` — `backend` and `frontend` only:

- **`container_name:` is removed from both services.** This is the single change
  that makes concurrent stacks possible; Compose then derives
  `<project>-backend-1`. Every operational command and healthcheck that
  previously used `docker inspect isoplus-backend` must move to
  `docker compose ps` / `docker compose exec`.
- Project name resolves from `COMPOSE_PROJECT_NAME` (set per worktree in its
  `.env`), which takes precedence over the file's top-level `name:` key. The
  `name: isoplus-portal` default is retained for the main clone.
- Joins the shared infra network as external.
- `MONGODB_URI` becomes `mongodb://mongo:27017/${MONGO_DB:-business-dashboard}`
  so a worktree can select its own database without its own `mongo` container.
  Every other infra override in the `environment:` block is preserved, including
  the existing behavior that these keys override `Backend/.env`.
- Ports stay `${FRONTEND_PORT:-3100}` / `${BACKEND_PORT:-4001}`, so the main
  clone's addresses are unchanged.

### Worktree layout

Worktrees live under `worktrees/` at the top of the main clone, gitignored, and
above both Docker build contexts so they never fall inside one:

```
isoplus-portal/                     main clone, develop, ports 3100/4001
├── Backend/                        build context
├── Frontend/                       build context
└── worktrees/                      gitignored
    ├── feature-x/                  ports 3110/4011
    │   ├── Backend/                its own checkout, at its own commit
    │   ├── Frontend/               likewise
    │   └── .env                    COMPOSE_PROJECT_NAME + this pair of ports
    └── bugfix-y/                   ports 3120/4021
        ├── Backend/
        └── Frontend/
```

Each worktree is a **complete checkout** — it has its own `Backend/` and
`Frontend/`, at whatever commit its branch points to, with its own
`node_modules` volumes and its own compose project. That is what makes a second
stack possible, and it is also why `worktrees/` must stay gitignored: these are
full working trees of the very repository that contains them.

The approved design placed these outside the clone; see
[Changes since approval](#changes-since-approval).

### Port allocation

Ports are assigned by scanning for genuinely free ports rather than by hashing
names, which avoids both silent collisions and clashes with the unrelated
`agenticflo` stack that holds 3000, 3001 and 6379 on this machine.

`npm run worktree -- new` probes upward from 3110 (frontend) and 4011 (backend)
in steps of 10 and writes the first free pair into the worktree's `.env`
alongside `COMPOSE_PROJECT_NAME`. A candidate must be both bindable *and*
unclaimed by any existing worktree's `.env` — the design's `ss -ltn` check was
replaced with a Node bind probe, which is portable and also catches the case
where a reserved port is merely not listening yet.

### Environment files

`Backend/.env` and `Frontend/.env.local` are gitignored, so a fresh worktree has
neither, and the API `process.exit(1)`s on boot without `MONGODB_URI`,
`JWT_SECRET` and `SESSION_SECRET`. `worktree -- new` therefore copies both files
from the main clone into the new worktree. This is the most easily missed step
in the whole design and is called out in `docs/worktrees.md`.

### Scripts

One Node CLI, `scripts/dev.mjs`, runnable from any worktree and resolving the
repo root via `git rev-parse --show-toplevel`. Logic lives in pure helpers under
`scripts/lib/`; the CLI keeps the I/O. No dependencies, so it runs on a fresh
clone before any `npm install`.

- **`npm run dev:up`** — start shared infra if not already healthy, then this
  worktree's `backend`/`frontend`; gate on health rather than on `up` exiting 0;
  verify every service shows a `->` port mapping; print a table of URLs.
  `npm run dev:build` is the same with `--build`.
- **`npm run dev:down`** — stop this worktree's apps. `-- --all` also stops
  shared infra; `-v` wipes the shared volumes.
- **`npm run worktree`** — `new [--isolated-db]`, `list`, `remove <name>`,
  `sync-env`. `new` prompts for work type and ticket, composes the branch name,
  creates the worktree, allocates ports, writes `.env`, and copies the two env
  files — rewriting `MONGODB_URI` in the copy so a native `npm run migrate` in
  that worktree cannot reach the shared database. `--isolated-db` adds
  `MONGO_DB=business-dashboard-<name>`. `remove` stops that worktree's stack
  before removing the tree, and drops its isolated database if it had one.
- **`npm run seed`** — restore `seed/*.archive.gz` into the shared mongo:

  ```
  mongorestore --archive --gzip --drop \
    --nsInclude='isoplus.*' --nsFrom='isoplus.*' --nsTo="${MONGO_DB}.*"
  ```

  Honors `MONGO_DB` so it can target a worktree's isolated database. Because
  `--drop` is destructive, it prompts for confirmation unless `--yes` is passed,
  and names the target database in the prompt.

### Seed data

`seed/` is created in the repo and gitignored except for a committed
`seed/README.md` explaining what to put there and where the dump came from.
`~/Downloads/my_database_backup.gz` is **copied** (not moved — the original
stays until the restore is verified) to `seed/isoplus-dump.archive.gz`.

The archive is `mongodump --archive --gzip` output, verified by its BSON archive
magic (`6d e2 99 81`), containing database `isoplus` with collections including
`invoicenumbers`, `logs` and `boards`.

### Documentation

- **`docs/local-development.md`** — the tracked successor to the untracked
  `isoplus-local-env` skill: the port table, health-gating, the empty-`PORTS`-
  column failure mode and its `--force-recreate` fix, the env-var override table,
  and the common-mistakes table.
- **`docs/worktrees.md`** — creating and removing worktrees, how ports are
  allocated, what shared infra means for data, when to use `--isolated-db`, and
  the env-file copy requirement.
- **`CLAUDE.md`** — a "Worktrees and the local stack" section pointing at both,
  plus the engineering policy absorbed from the Cursor rule, plus a note that
  agent tool configs are intentionally gitignored.

The untracked `.claude/skills/isoplus-local-env/SKILL.md` is updated in place to
match the new command surface (no more `docker inspect isoplus-backend`) and to
defer to `docs/local-development.md` as the source of truth.

## Verification

Claims of success require evidence, not assertion. The implementation is
complete only when the following have been run and their output confirmed:

1. **Concurrent stacks.** With the main clone's stack up, create a throwaway
   worktree, bring up its stack, and confirm all containers are healthy in both.
2. **Distinct, working endpoints.** `curl` both backends' `/api/healthcheck` for
   `{"status":"OK"}` and both frontends for HTTP 200, on their four distinct
   ports.
3. **Port mappings are real.** `docker compose ps` for both projects shows a
   `->` mapping on every row — a healthy container with an empty `PORTS` column
   is the known silent failure.
4. **Seeding works.** Run `npm run seed`, then count documents in a known
   collection in `business-dashboard` and confirm it is non-zero.
5. **Isolated DB works.** A worktree created with `--isolated-db` reads a
   different database, confirmed by differing collection counts.
6. **Clean teardown.** Remove the throwaway worktree, then confirm the main
   stack is still healthy and still serving on 3100/4001.
7. **Nothing secret staged.** `git status` before commit shows no `.env`, no
   `seed/` content, and no agent tool directories.

## Risks

| Risk | Mitigation |
|---|---|
| Committing customer data | `seed/` gitignored; verification step 7 checks `git status` before any commit. |
| Committing secrets | `Backend/.env` / `Frontend/.env.local` already gitignored; step 7 re-checks. |
| Removing `container_name:` breaks existing muscle memory and the personal skill | The skill file and all docs are updated in the same change to use `docker compose ps`. |
| Shared database lets a destructive migration on one branch corrupt another | `--isolated-db` opt-in, documented in `docs/worktrees.md`. |
| Port scan races another process between probe and bind | `npm run dev:up` verifies real `->` mappings after start (step 3) rather than trusting the probe. |
| Team pushback on committing local-dev Docker to a shared repo | Change is additive and touches no application code, no CI and no deploy config; delivered as a PR against `develop` for review, not pushed directly. |

## Out of scope for this change

Committing the agent tool configs themselves, should the team later adopt the
same toolchain, is a separate decision and a separate PR.
