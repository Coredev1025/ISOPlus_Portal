# Setting up an AI agent on this project

Everything an AI agent (Claude Code, Cursor, Codex, opencode, a new Claude install) needs
that is **not in the code**: where the instructions live, what has to exist on the machine,
how Jira, GitHub and the local databases are reached, and what to back up before
reinstalling a tool. It lists **names and locations, never secret values**. Rules and
conventions are in [`CLAUDE.md`](../CLAUDE.md) (`AGENTS.md` is a symlink to it); state is in
[`claude-handoff.md`](claude-handoff.md) and the notes under [`ongoing/`](ongoing/).

Private notes that must not be in the repo (preferences about how time is logged, personal
paths and the like) are kept by the owner in a local file outside the repo,
`~/Documents/work/isoplus/ai-private-notes.md`. A new agent should ask the owner for it.

## 1. What an agent reads first

| What | Where | Notes |
|---|---|---|
| Conventions, commands, architecture rules | `CLAUDE.md` (`AGENTS.md` is a symlink) | Branching, PR format, complexity gate, test-first, no AI attribution |
| How to work (test first, change control, security) | `docs/full-stack-engineering.md` | Required reading before changing code |
| Orientation and current state | `docs/claude-handoff.md`, `docs/ongoing/` | The invoice ledger series has `ongoing/2026-10-04-invoice-ledger-handover.md` |
| Release procedure | `docs/release-runbook.md` | Read before any production release |
| Planned work | `docs/roadmap/`, `docs/superpowers/specs/`, `docs/plans/` | `roadmap/release-rehearsal.md` is the automated rehearsal plan |
| Cursor rules | `.cursor/rules/full-stack-engineering.mdc` (tracked; points at the files above) | Other per-developer tool config is gitignored; `npm run agents -- --check` verifies the wiring |
| Shared skills | `.agents/skills/` (canonical; other tool folders are symlinks) | `npm run agents` links them |

## 2. Machine prerequisites

Checked by `npm run doctor` at the repo root. Versions in use when this was written:

* Node 26 and npm 11 (the Frontend unit tests need a flag on Node 25 and later, see section 6), Git 2.50, Docker 29 with Compose, Python 3 (scripts only), the GitHub CLI `gh`.
* Google Chrome installed (Playwright runs with `E2E_BROWSER_CHANNEL=chrome`, so no browser download is needed).
* `caffeinate` (macOS) to keep the machine awake during long runs.

## 3. Local environment files (gitignored)

Created by copying the examples; the worktree tool copies them for you.

* `Backend/.env` from `Backend/.env.example`; `Frontend/.env.local` from `Frontend/.env.example`; an optional root `.env` for Docker ports (from `.env.docker.example`). `docs/local-development.md` explains each.
* Required to boot: `MONGODB_URI`, `JWT_SECRET`, `SESSION_SECRET`. The rest are integrations: ISO+ OAuth (`CLIENT_ID`, `CLIENT_SECRET`, `PERSONAL_ACCESS_TOKEN`, the endpoint and callback URLs), Xero (`XERO_*`), AWS (`AWS_*`, `AWS_BUCKET*`), Google (`GOOGLE_*`), `Admin_API_Key`, `SCHEDULER_API_KEY*`, Sentry, Redis.
* Settings that make a **local, offline** run work: `ISOPLUS_OFFLINE=1`, a non-empty placeholder `PERSONAL_ACCESS_TOKEN`, a **blank** `GOOGLE_TARGET_GROUP`, `REDIS_HOST`/`REDIS_PORT`, and `ALLOWED_ORIGINS` set to the frontend origin. Without them the one-time sign-in ticket (`npm run dev:login`) is refused.
* **Do not change `CLIENT_ID` / `CLIENT_SECRET`.** The owner manages the ISO+ OAuth client; ask if ISO+ login breaks.
* Never put a production connection string or any secret in chat, a commit, a PR or a Jira comment.

## 4. Docker

* Two Compose projects: `docker-compose.infra.yml` (Mongo and Redis, once per machine, network `isoplus-net`) and `docker-compose.yml` (backend and frontend, once per worktree). Start with `npm run dev:up`, stop with `npm run dev:down`, status with `npm run dev:status`.
* Default ports: frontend 3100, API 4001, Mongo 27017, Redis 6380. A worktree gets its own pair from 3110/4011 upward, and its own project name, via `npm run worktree -- new`. Details in `docs/local-development.md` and `docs/worktrees.md`.
* In a worktree, `Backend/node_modules` and `Frontend/node_modules` are not present. To run tests symlink the main checkout's `node_modules`, and **remove the symlink before `git add`**. (A worktree's own Docker stack creates `node_modules` as a mount point: run Playwright from the main checkout's binaries with `NODE_PATH` pointing at its `node_modules`.)
* The Backend suite needs no database or Redis: `test/setup.js` starts `mongodb-memory-server` and mocks `ioredis`.

## 5. Local databases and the production copy

Rules for any real-data copy are in `docs/release-runbook.md` ("Rehearsing on a copy of production") and the standing permission below.

* **Development database:** the `isoplus-mongo` container, database `business-dashboard`; `npm run seed` restores a dump from `seed/` (gitignored, see `seed/README.md`); `npm run dev:fixture` loads the committed fixtures; `npm run schema` reports the real shapes.
* **Production snapshot** (an Atlas download of 2026-10-03, MongoDB 8.0): `~/Documents/work/isoplus/prod-db-backup/` holds the `.tgz`, an `extracted/` copy and `copy-premigration.archive.gz` (the scrubbed copy before the migrations). It is outside the repo and must stay out. About 1.1 GB.
* **Containers for it:** `prod-snap` (mongo:8 on the extracted files, no network) and `prod-copy-db` (mongo:8 on `isoplus-net`). Databases in `prod-copy-db`: `isoplus-prod-copy` (scrubbed, before migrations) and `isoplus-rehearsal` (scrubbed, migrated, no backfill: the baseline for each rehearsal). Recreate from the snapshot with the runbook's steps if they are gone.
* **Running a Backend script against a copy** without the "not local" guard: a one-off container that shares the copy's network, so the URI is `localhost` (the exact `docker run` line is in the ledger handover, "Local state").
* **Standing permission from the owner:** restore a fresh copy into a NEW database whenever a test needs it, scrub **before** anything connects (Xero tokens, users, sessions, board hook secrets; verify with counts), run fully offline (`ISOPLUS_OFFLINE=1`, automation off, offline email), never copy, log or use credentials found in it, drop the copy afterwards. Do not delete the snapshot or the two containers until the owner signs off the rehearsal.

## 6. Test setup

* **Backend:** `cd Backend && npm test` (Vitest). About 5 minutes locally, about 12 in CI. Run the **whole** suite before every push. Date-sensitive tests: also run with `TZ=UTC`. A few tests fail now and then under load and pass alone; see the ledger handover for the list.
* **Frontend:** `cd Frontend && NODE_OPTIONS=--no-experimental-webstorage npm test` on Node 25 and later (the built-in `localStorage` otherwise breaks the whole suite); `npm run lint`; `npm run build`. `next.config.js` does not fail the build on lint errors, so run lint yourself.
* **End to end (Playwright):** `docs/testing-kan10-end-to-end.md` and `docs/testing-kan11-end-to-end.md` give the working recipe: a separate database, offline mode, `E2E_BROWSER_CHANNEL=chrome`, the one-time sign-in ticket. Specs that share workspace 55390 must run on one worker (`npm run e2e:automation`).
* **Complexity gate** (must be < 15 per function): `eslint-plugin-sonarjs` is not installed in the repo. Install `eslint@8` and `eslint-plugin-sonarjs@0.25` in a scratch directory and score the changed files with rule `sonarjs/cognitive-complexity` at 14.
* **Local sign-in:** `npm run dev:login` prints a one-time URL for a local `support_admin`. Do not add a dev login endpoint to the app.

## 7. Git and GitHub

* The owner works under several identities. Git picks the right `user.email` by remote through `includeIf "hasconfig:remote.*.url:..."` blocks in `~/.gitconfig` (one `~/.gitconfig-<account>` file each); there is deliberately **no default identity**. For this repo the remote is `https://github.com/ISO-Consulting-Services/...` and resolves to the isoconsulting identity. After any change, check `git config user.email` inside the repo. SSH keys are `~/.ssh/id_ed25519_<account>` with host aliases in `~/.ssh/config`.
* The `gh` CLI is logged in as the GitHub account that belongs to the ISO-Consulting-Services organisation, with scopes `repo`, `workflow`, `read:org`, `gist`. Do not widen the token's scopes; if a step needs more, do it in the web UI and tell the owner.
* Never push to `develop` or `main`; one branch and one PR per change, `<type>/<TICKET>_<snake_case>`, PRs target `develop`; merge one at a time after review and green CI. No AI attribution anywhere (commit messages, PR bodies, Jira), and write commits as a person would.

## 8. Jira

* Site `isoconsultingservices.atlassian.net`, cloud id `9f7993fc-f8eb-4920-9d1f-d315115a4737`, project key `KAN`. Reached through the Atlassian connector in the AI tool (read, create, comment, transition). Another tool needs the same access: the Atlassian MCP server, or REST calls with an API token created by the owner. Whoever connects acts as that Jira user.
* Issue types: Task 10008, Bug 10010, Test case 10011. Statuses and the transitions that move to them (global): To Do 11, In Progress 21, In Review 31, Done 41, Test failed 42.
* Meaning of the statuses here: merged to `develop` and waiting for the client or tester to verify is **In Review**; **Done** after verification, or for internal work with no client-visible change that is merged and tested; **Test failed** when a tester's check failed.
* One ticket per pull request; the ticket key is in the branch name and the PR title; comment on the ticket when the work is merged (what was done, PR number, a warranty note). The owner's preferences for how time is written in those comments are in the private notes.
* A bulk edit of old comments or statuses can be refused by the tool's permission checks; stop and tell the owner rather than finding another way.

## 9. Claude Code specifics

* **Memory** (what the assistant has learned about the owner and the project): `~/.claude/projects/<project folder name>/memory/` (`MEMORY.md` is the index; each note is one file). For this repo the folder is `-Users-masoudkeynejad-Documents-work-isoplus-repos-isoplus-portal`. It is **not** in the repo and is lost on a reinstall unless copied.
* **Settings and approvals:** `~/.claude/settings.json` (and project-level `.claude/`, gitignored). Tool permissions are granted per action in the app; connectors (Atlassian, Chrome) are signed in again after a reinstall.
* **Long runs:** `caffeinate` keeps the Mac awake; a session-only cron prompt re-checks every 30 minutes (it ends with the session). Scratch files go in the session's scratchpad directory, not in the repo.
* **Progress notes outside the repo** written by earlier sessions: `~/Documents/work/isoplus/ledger-build-progress.md` (the assistant's checklist), `overnight-progress.md`, `afternoon-progress.md`, and screenshots under `~/Documents/work/isoplus/proof/`. The repo copies of what matters are in `docs/ongoing/`.

## 10. Before reinstalling a tool or moving machines

Copy these somewhere safe, none of them are in the repo:

1. `~/.claude/projects/<project folder>/memory/` (the assistant's memory) and `~/Documents/work/isoplus/ai-private-notes.md`.
2. `~/.gitconfig` and `~/.gitconfig-*`, and `~/.ssh/` (keys and `config`). Keep keys off shared drives.
3. `Backend/.env`, `Frontend/.env.local` and the root `.env` of every checkout and worktree you still use.
4. `~/Documents/work/isoplus/prod-db-backup/` (the snapshot) and the progress notes listed above.
5. Docker volumes are rebuildable from the snapshot and the fixtures; they do not need a backup.

## 11. Checks that a new agent is ready

Run these and fix whatever fails:

```bash
npm run doctor                  # prerequisites
npm run agents -- --check       # instruction and skill wiring
gh auth status                  # logged in, right account
git config user.email           # inside the repo: the right identity
docker ps                       # infra containers up (npm run dev:up if not)
curl localhost:4001/api/healthcheck
```

Then read `CLAUDE.md`, `docs/full-stack-engineering.md`, `docs/claude-handoff.md` and the newest note in `docs/ongoing/`, and confirm Jira access by reading one `KAN` ticket.
