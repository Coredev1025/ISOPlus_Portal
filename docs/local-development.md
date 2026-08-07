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
| `npm run dev:user` | Set a known password on the local support-admin account so you can sign in. See below. |
| `npm run schema` | Declared vs actual database schema, and the drift between them. See [migrations.md](./migrations.md). |
| `npm run migrate` | Create and run database migrations. See [migrations.md](./migrations.md). |
| `npm run worktree` | Manage worktrees. See [worktrees.md](./worktrees.md). |
| `npm run agents` | Unify AGENTS.md and skills across every assistant. `-- --check` reports without changing. |
| `npm run doctor` | Check prerequisites and report what is missing. |

Passing flags through npm needs `--`: `npm run dev:down -- --all`. Calling the
CLI directly avoids that: `node scripts/dev.mjs down --all`.

## Logging in locally

The login screen's primary button, **Sign in with ISO+™**, starts an OAuth flow
against `https://app.isoplus.online`. That cannot complete locally: `CLIENT_ID`,
`CLIENT_SECRET` and `PERSONAL_ACCESS_TOKEN` are blank in a local `Backend/.env`,
and real ones come from the ISO+ team. Clicking it sends you to a live system
that will refuse you.

Use the **second** login path instead, which the application already ships and
which works entirely offline:

```bash
npm run dev:user
```

That sets a known password on the seeded `support_admin` account and prints it:

```
  database  business-dashboard
  email     arnold@hillsgrade.com.au
  password  local-dev-only
```

Then at `http://localhost:3100`, click **administrator credentials** at the
bottom of the login screen — this swaps the ISO+ button for an email/password
form — and sign in with those.

| Flag | Effect |
|---|---|
| `--list` | Show local users, roles and disabled state; change nothing |
| `--email <address>` | Target a specific user |
| `--password <value>` | Use a password other than the default |
| `--create` | Create the user when none exists |

**Re-seeding clears it.** `npm run seed` restores with `--drop`, replacing the
`users` collection, so the password stops working. `seed` prints a reminder;
just run `npm run dev:user` again.

**This adds no authentication code to the application.** It writes one row in
your local database, using a login route that already ships to production. The
script refuses to run against any non-local `MONGODB_URI` and has **no override
flag**, because setting a known password on a real database would be an
immediate account compromise.

## Tests

Vitest, in `Backend/`:

```bash
cd Backend
npm test                 # vitest run
npm run test:watch
npm run test:coverage
npm run test:api:live    # RUN_REAL_API_TESTS=1 — hits the real ISO+ API
```

The suite needs **neither Mongo nor Redis**: `test/setup.js` starts
`mongodb-memory-server` and mocks `ioredis`. So it does not care whether the
Docker stack is up, and it never touches your seeded database.

That last part depends on one easily-missed line: `test/setup.js` sets
`NODE_ENV=test` at **module scope**, not inside `beforeAll`. Integration tests
call `createApp()` at module top level, which Vitest runs before `beforeAll`
hooks — so with the assignment in the hook, `app.js` saw `NODE_ENV=development`,
built a `MongoStore` session store against the real `business-dashboard`, and
put sessions outside the in-memory database that `afterEach` truncates. That
produced intermittent `401`s in authenticated tests and left session documents
in the developer's own database. Do not move it back into the hook.

To run it the way CI does, in the container:

```bash
docker compose run --rm --no-deps backend npm test
```

`Backend/Dockerfile` installs `libcurl4` for this. The mongod binary that
`mongodb-memory-server` downloads links against `libcurl.so.4`, which
`node:22-bookworm-slim` does not ship — without it every test file fails at
startup with *"a library is missing or cannot be opened"*, while CI passes
because `ubuntu-latest` has it.

Layout, all under `Backend/test/`:

| Directory | Holds |
|---|---|
| `unit/` | pure functions, models, middleware |
| `integration/` | `supertest` against `createApp()` from `src/app.js` |
| `msw/` | ISO+ HTTP mocks — shape an upstream response per test |
| `real-api/` | hits the real ISO+ API; excluded from `npm test` |
| `helpers/` | `auth.js` for a logged-in session |
| `fixtures/` | committed sample data — see [its README](../Backend/test/fixtures/README.md) |

`vitest.config.js` collects `test/**/*.test.js` **only**. A file named
`.test.mjs` is not an error — it is silently never run.

### End-to-end (Playwright)

Against the running stack, so `npm run dev:up` first:

```bash
cd Frontend
npm run e2e:install   # once — downloads Chromium into the container cache
npm run e2e
npm run e2e:ui        # watch it drive the browser
npm run e2e:report
```

Or in the container, which is how it was verified:

```bash
docker compose exec -e PLAYWRIGHT_BASE_URL=http://localhost:3000 frontend npx playwright test
```

Note the port difference: **3100 from the host, 3000 inside the container.**
`playwright.config.ts` reads `FRONTEND_PORT` and falls back to 3100, because
this repo avoids 3000/3001 — the config previously hardcoded 3000 and could
never have connected from a host run.

`Frontend/Dockerfile` installs Chromium's shared libraries in the `dev` stage.
Without them the browser exits 127 with *"libglib-2.0.so.0: cannot open shared
object file"* and every test fails at launch, which is why this suite had never
actually run. The browser binary itself is not baked in — `e2e:install` fetches
it on first use.

Tests live in `Frontend/e2e/`. They assert on roles and text rather than CSS, so
a restyle does not break them, and they need no ISO+ credentials.

## Running without ISO+ credentials

The portal is a front end over the ISO+ platform, and several endpoints **proxy
the live ISO+ API** rather than reading Mongo. `GET /api/workspaces` is the one
that bites first: it fetches workspaces from ISO+, not from the seeded database,
so no amount of seeding puts a workspace on screen. That is also why the seeded
`workspaces` collection is empty while `boards` is not.

**Offline mode covers this.** When `PERSONAL_ACCESS_TOKEN` is blank, the backend
serves workspaces and boards from Mongo instead, and the app is usable with no
credentials and no network:

```bash
npm run dev:up
npm run dev:user -- --create   # local login; sign in via "administrator credentials"
npm run seed                   # or: npm run dev:fixture
```

Verify it without a browser:

```bash
curl -s -c /tmp/jar -X POST localhost:4001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"local-dev-only"}'
curl -s -b /tmp/jar localhost:4001/api/workspaces
# {"workspace":[{"id":"55369","name":"Test","user_role":"admin"}],...}
```

The backend logs `Offline-Mode: Serving ISO+ workspaces and boards from MongoDB`
once per process, with the reason, so the mode is never a silent surprise.

| `ISOPLUS_OFFLINE` | Behaviour |
|---|---|
| unset | on when `PERSONAL_ACCESS_TOKEN` is blank **and** `NODE_ENV` is not `production` |
| `1` | forced on, even with a token |
| `0` | forced off — reproduces the real "credentials missing" failure |

It never applies in production: there, a blank token is a misconfiguration that
must fail loudly rather than quietly serve stub data.

### What offline mode is not

It serves two collection endpoints from Mongo. It is **not** a mock of ISO+, and
it does not make the app fully offline:

- The ISO+ button on the login screen still needs `CLIENT_ID`/`CLIENT_SECRET`.
  Without them the authorize URL carries an empty `client_id` and ISO+ answers
  `unsupported_grant_type`. Use the **administrator credentials** link instead.
- **Board attributes** are served from
  [the committed fixture](../Backend/test/fixtures/ndis-quote-board.json), which
  holds 13 of the board's 511. Enough for Board Configuration, whose dropdowns
  want `longtext` and get Integration Message and Generated PDF Link. Not enough
  to reason about pricing: `boardAttributesUseLegacyNdisPricing()` will read the
  partial list and conclude whatever the fixture says. Attributes for any board
  other than `eNiJpH14PN3` come back empty rather than wrong.
- Items, references and values still read live ISO+.
- Board scoping is approximate. In the seed dump 33 of 34 boards have
  `workspaceId: null`, so offline mode includes unassigned boards in whichever
  workspace you ask for, and logs how many. Correct for one workspace, wrong for
  several — which is why it lives in `services/offlineIsoplus.js` and not in
  `services/isoplus.js`.

For anything asserting real ISO+ behaviour, use real credentials. Background in
[the local auth design](./superpowers/specs/2026-08-05-local-auth-design.md).

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

## Agent tooling consistency

Different assistants read different files. Keeping them in step is handled by
one rule: **one source of truth, everything else a link to it.**

```bash
npm run agents            # unify
npm run agents -- --check # report only; non-zero exit if out of step
```

`npm run doctor` reports both of the checks below as well.

### Instructions

`CLAUDE.md` is the real file. `AGENTS.md` — the cross-tool convention read by
Codex, opencode, Cursor and others — is a **tracked symlink** to it, so every
assistant gets the same instructions and there is nothing to keep in sync.

This is the one symlink that travels through git, which matters on Windows.
Without Developer Mode, Git checks the link out as a *regular file containing
the text* `CLAUDE.md` — nine bytes where the instructions should be, and every
assistant silently reads nothing. `npm run agents` detects that and repairs it,
falling back to a real copy if symlinks are unavailable. It also detects the
worse case: a copy that has since **diverged** from `CLAUDE.md`.

### Skills

Assistants each read their own directory. Copying skills between them lets them
drift — this repo already had `isoplus-local-env` in `.claude/skills` and
nowhere else, so Cursor and opencode never saw it.

Instead, `.agents/skills/` is canonical and every other tool directory is a
symlink to it:

```
.agents/skills/      <- canonical, the real directory
.claude/skills/      -> .agents/skills
.opencode/skill/     -> .agents/skills
```

**A skill installed by any assistant is therefore immediately available to all
of them**, with no sync step to remember — the install writes straight through
the link into the canonical directory.

These directories are gitignored, so unlike `AGENTS.md` these symlinks never
travel through a checkout. On Windows they are created as junctions, which need
no Developer Mode.

Adopting a new assistant means adding one row to `TOOL_SKILL_DIRS` in
`scripts/lib/agentsync.mjs`. Running `npm run agents` then adopts anything
unique to that tool into the canonical set *before* linking, so nothing is lost.

Cursor is deliberately not in that list: `.cursor/rules/*.mdc` is a different
format, not a skills directory, and linking it would produce files Cursor cannot
read. Its engineering rules live in `CLAUDE.md` instead — and therefore in
`AGENTS.md` too.
