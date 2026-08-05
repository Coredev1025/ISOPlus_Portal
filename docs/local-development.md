# Local development

The whole stack runs in Docker and works the same on Linux, macOS and Windows.
Nothing needs to be installed on the host except Docker and Node.

## Prerequisites

| | |
|---|---|
| **Docker** | Docker Desktop on macOS/Windows, Docker Engine on Linux. Compose **v2** — the `docker compose` subcommand, not the legacy `docker-compose` binary. |
| **Node 20+** | Only to run `scripts/dev.mjs`. The apps themselves run inside containers, so you never need host `node_modules`. |
| **Git** | 2.20+ for worktree support. |

Check everything at once:

```bash
npm run doctor
```

## Quick start

```bash
git clone git@github.com:ISO-Consulting-Services/isoplus-portal.git
cd isoplus-portal

cp Backend/.env.example  Backend/.env
cp Frontend/.env.example Frontend/.env.local
# fill in MONGODB_URI, JWT_SECRET, SESSION_SECRET — the API exits without them

npm run dev:up          # first run builds the images; allow a few minutes
npm run seed            # optional: load a database dump, see seed/README.md
```

Every command works identically in PowerShell, cmd, bash and zsh. The scripts
are Node, not shell, precisely so there is no Git Bash requirement on Windows.

## Commands

| Command | Does |
|---|---|
| `npm run dev:up` | Start shared infra if needed, then this worktree's apps. Waits for health and verifies the ports really published. |
| `npm run dev:build` | Same, forcing an image rebuild. Needed after any `package.json` change. |
| `npm run dev:down` | Stop this worktree's apps. `-- --all` also stops shared infra; `-- -v` wipes data. |
| `npm run dev:status` | What is running, on which ports, against which database. |
| `npm run dev:logs` | Tail everything. `npm run dev:logs -- backend` for one service. |
| `npm run seed` | Restore a dump into Mongo. See [seed/README.md](../seed/README.md). |
| `npm run schema` | Declared vs actual database schema, and the drift between them. See [migrations.md](./migrations.md). |
| `npm run migrate` | Create and run database migrations. See [migrations.md](./migrations.md). |
| `npm run worktree` | Manage worktrees. See [worktrees.md](./worktrees.md). |
| `npm run doctor` | Check prerequisites and report what is missing. |

Passing flags through npm needs `--`: `npm run dev:down -- --all`. Calling the
CLI directly avoids that: `node scripts/dev.mjs down --all`.

## The two stacks

The stack is deliberately split across two Compose projects.

**`docker-compose.infra.yml`** (project `isoplus-infra`) owns `mongo` and
`redis`. It is started **once per machine** and shared by the main clone and
every worktree.

**`docker-compose.yml`** (project `isoplus-portal` by default) owns `backend`
and `frontend`. It is started **once per worktree**, and joins the
`isoplus-net` network the infra stack creates.

This split is what lets two branches run side by side. Two properties in
`docker-compose.yml` make it work and must not be "tidied" away:

1. **Neither app service sets `container_name:`.** Compose derives
   `<project>-backend-1` instead, so worktrees do not collide. Consequently,
   never address a container by a fixed name — `docker inspect isoplus-backend`
   no longer resolves. Use `docker compose ps` and `docker compose exec`.
2. **The project name is a default.** `COMPOSE_PROJECT_NAME` in a worktree's
   `.env` takes precedence over the `name:` key in the file.

## Ports

| Service | Host (main clone) | Container |
|---|---|---|
| Frontend | **3100** | 3000 |
| API | **4001** | 3001 |
| Mongo | 27017 | 27017 |
| Redis | **6380** | 6379 |

3000, 3001 and 6379 are avoided on purpose: on the original developer machine
they are held by an unrelated `agenticflo` stack, whose `agenticflo-calls-api`
container republishes 3000 every few seconds while crash-looping. Worktrees get
3110/4011, 3120/4021 and so on, assigned by probing for genuinely free ports.

Override any of them in a root `.env` — see [.env.docker.example](../.env.docker.example).

## Environment variables

`docker-compose.yml` **overrides** these keys regardless of what
`Backend/.env` says, because inside the Compose network the datastores are
reachable by service name rather than on localhost:

`MONGODB_URI`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_CLUSTER`, `REDIS_TLS`,
`ALLOWED_ORIGINS`, `FRONTEND_URL`, `NEXT_PUBLIC_BACKEND_URL`, `PORT`, `NODE_ENV`.

Everything else — secrets, ISO+/Xero/AWS credentials — comes from
`Backend/.env` and `Frontend/.env.local`. Both are gitignored and neither is
created for you.

## Platform notes

**macOS and Windows: hot reload needs polling.** Docker Desktop does not forward
inotify events across a bind mount, so nodemon and Next dev never see your
edits and hot reload appears broken. Add to your `.env`:

```
WATCH_POLLING=true
```

This costs noticeable CPU, which is why it is off by default. Linux uses native
file events and does not need it.

**Windows: use a native path.** Keep the repo on the Windows filesystem
(`C:\...`) with Docker Desktop's WSL 2 backend, or entirely inside WSL. A repo
on `/mnt/c` accessed from inside WSL is extremely slow for bind mounts.

**Windows: line endings.** `.gitattributes` forces LF for everything the
containers read. If you cloned before that file existed, renormalize once:

```bash
git rm --cached -r . && git reset --hard
```

**Apple Silicon.** All four images (`mongo:7`, `redis:7-alpine`,
`node:22-bookworm-slim`) publish native arm64 builds. No emulation, no
`platform:` overrides.

## When something is wrong

| Symptom | Cause and fix |
|---|---|
| `dev:up` reports a service publishing no host port | The bind silently lost a race with another publisher. The container is healthy but unreachable. `docker compose up -d --force-recreate <service>` — a plain restart will not fix it. |
| `Bind for 0.0.0.0:3100 failed: port is already allocated` | Something else holds the port. Change `FRONTEND_PORT` in `.env`, or find the holder: `docker ps --format '{{.Names}} {{.Ports}}'`. |
| API container exits immediately | Missing `MONGODB_URI`, `JWT_SECRET` or `SESSION_SECRET`. The app calls `process.exit(1)` on boot. `docker compose logs backend`. |
| `network isoplus-net declared as external, but could not be found` | Shared infra is not running. `npm run dev:up` starts it, or `docker compose -f docker-compose.infra.yml up -d`. |
| Login fails, everything else works | Expected. `CLIENT_ID`, `CLIENT_SECRET` and `PERSONAL_ACCESS_TOKEN` for ISO+ OAuth are blank placeholders in the example env. Real credentials come from the ISO+ team. |
| Edits do not trigger a reload | On macOS/Windows, set `WATCH_POLLING=true` (above). |
| Dependency changes ignored | `npm ci` runs inside the image, and `node_modules` is a named volume that Docker fills **only when it is empty** — so rebuilding the image alone never reaches an existing volume. `npm run dev:build` handles this by discarding the project's `node_modules`/`.next` volumes first. Plain `docker compose up --build` does not, and will silently leave the new dependency missing. |
| Everything is confusing | `npm run dev:down -- --all -v` wipes containers and data, then `npm run dev:build` and `npm run seed`. |

## Teardown

```bash
npm run dev:down                # this worktree's apps
npm run dev:down -- --all       # also the shared mongo/redis
npm run dev:down -- --all -v    # also wipe all data (every worktree's)
```

`-v` with `--all` destroys the database shared by every worktree. It is not
scoped to the one you are standing in.
