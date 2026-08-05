# Repo-native agentic workspace, Docker and worktrees

**Date:** 2026-08-05
**Status:** Approved design, pending implementation

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
scripts/dev-up.sh             new
scripts/dev-down.sh           new
scripts/worktree.sh           new
scripts/db-restore.sh         new
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

Worktrees are siblings of the main clone, outside it, so they never fall inside
a Docker build context:

```
/home/allanaire/hillsgrade/
├── .claude/settings.local.json     personal, unchanged
├── (proposals, estimates, PDFs)    personal, unchanged
├── isoplus-portal/                 main clone, develop, ports 3100/4001
└── worktrees/
    ├── feature-x/                  ports 3110/4011
    └── bugfix-y/                   ports 3120/4021
```

### Port allocation

Ports are assigned by scanning for genuinely free ports rather than by hashing
names, which avoids both silent collisions and clashes with the unrelated
`agenticflo` stack that holds 3000, 3001 and 6379 on this machine.

`scripts/worktree.sh new <branch>` probes upward from 3110 (frontend) and 4011
(backend) in steps of 10, testing each candidate with `ss -ltn`, and writes the
first free pair into the worktree's `.env` alongside `COMPOSE_PROJECT_NAME`.

### Environment files

`Backend/.env` and `Frontend/.env.local` are gitignored, so a fresh worktree has
neither, and the API `process.exit(1)`s on boot without `MONGODB_URI`,
`JWT_SECRET` and `SESSION_SECRET`. `worktree.sh new` therefore copies both files
from the main clone into the new worktree. This is the most easily missed step
in the whole design and is called out in `docs/worktrees.md`.

### Scripts

Each is a small POSIX shell script, `set -euo pipefail`, runnable from any
worktree, resolving the repo root via `git rev-parse --show-toplevel`.

- **`dev-up.sh`** — start shared infra if not already healthy, then this
  worktree's `backend`/`frontend`; gate on health rather than on `up` exiting 0;
  verify every service shows a `->` port mapping; print a table of URLs.
- **`dev-down.sh`** — stop this worktree's apps. `--all` also stops shared infra;
  `-v` wipes the shared volumes.
- **`worktree.sh`** — `new <branch> [--isolated-db]`, `list`, `remove <name>`.
  `new` creates the worktree, allocates ports, writes `.env`, copies the two env
  files. `--isolated-db` adds `MONGO_DB=business-dashboard-<name>`.
  `remove` stops that worktree's stack before removing the tree, and drops its
  isolated database if it had one.
- **`db-restore.sh`** — restore `seed/*.archive.gz` into the shared mongo:

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
4. **Seeding works.** Run `db-restore.sh`, then count documents in a known
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
| Port scan races another process between probe and bind | `dev-up.sh` verifies real `->` mappings after start (step 3) rather than trusting the probe. |
| Team pushback on committing local-dev Docker to a shared repo | Change is additive and touches no application code, no CI and no deploy config; delivered as a PR against `develop` for review, not pushed directly. |

## Out of scope for this change

Committing the agent tool configs themselves, should the team later adopt the
same toolchain, is a separate decision and a separate PR.
