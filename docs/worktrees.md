# Worktrees

A git worktree is a second checkout of the same repository, on a different
branch, in a different directory, sharing one `.git`. It lets you work on two
branches at once without stashing, and — with the setup below — run both
applications at once on different ports.

## Layout

Worktrees are created under `worktrees/` at the top of the main clone:

```
isoplus-portal/                          main clone, develop, :3100 / :4001
├── Backend/
├── Frontend/
└── worktrees/                           gitignored
    ├── feature-iso-412-time-tracking/   :3110 / :4011
    │   ├── Backend/                     its own checkout, at its own commit
    │   ├── Frontend/                    likewise
    │   └── .env                         COMPOSE_PROJECT_NAME + these ports
    └── bugfix-iso-98-login-spinner/     :3120 / :4021
        ├── Backend/
        └── Frontend/
```

Each worktree is a **complete checkout of the repository**, not a partial one:
it has its own `Backend/` and `Frontend/` at whatever commit its branch points
to, its own `node_modules` volumes, and its own compose project. That is exactly
what lets it run a second stack — and it is why `worktrees/` must stay
gitignored, since these are full working trees of the repository that contains
them.

`worktrees/` is gitignored, so these full checkouts are never added back to the
repository that contains them. The directory also sits above both Docker build
contexts (`./Backend` and `./Frontend`) and outside `next build`'s traversal,
so nothing in here reaches an image or a bundle.

What it *is* inside is the repository root, so anything that walks the tree from
there — ripgrep, editor search, a root-level glob added later — will descend
into every worktree and report each match several times over. Scope such
searches to `Backend/` and `Frontend/`, or exclude `worktrees/`. This is the
cost of keeping them in the clone; the benefit is that a worktree travels with
the repo instead of depending on a directory beside it.

## Creating one

```bash
npm run worktree -- new
```

With no arguments it asks what it needs:

```
What kind of work is this?
  > 1) feature  — new functionality
    2) bugfix   — a defect in develop, not yet in production
    3) hotfix   — urgent fix for production — branches from main
Choose 1-3 [1]: 1
Ticket number (e.g. ISO-412): ISO-412
Short description: time tracking
```

and produces the branch `feature/ISO-412_time_tracking`. Tickets are validated
as `PREFIX-NUMBER` and upper-cased, so `iso-412` is accepted.

Supply any answer as a flag to skip that question — required when there is no
terminal, such as in CI, where the tool fails with instructions rather than
hanging on input:

```bash
npm run worktree -- new --type feature --ticket ISO-412 --desc "time tracking"
npm run worktree -- new feature/ISO-412_time_tracking   # existing branch, as-is
```

### What it sets up

1. **The branch.** Reused if it already exists locally, checked out with
   tracking if it exists on `origin`, otherwise cut from `origin/develop` —
   or `origin/main` for a `hotfix`. Override with `--from <ref>`. Branching a
   non-hotfix off `main` prints a warning, because that bypasses integration.
2. **A port pair no one else is using.** Checked two ways: the OS is asked to
   bind them, *and* the ports already recorded in sibling worktrees' `.env`
   files are excluded. Binding alone is not enough — a stopped worktree's ports
   test as free, and two worktrees would then collide the moment both start.
3. **The worktree's `.env`**, with those ports, a distinct
   `COMPOSE_PROJECT_NAME`, and `TICKET` for later reuse.
4. **`Backend/.env` and `Frontend/.env.local`**, copied from the main clone.
   They are gitignored, so a fresh worktree would otherwise have neither, and
   the API calls `process.exit(1)` on boot without them. **This is the step
   that is easiest to forget when doing it by hand.**
5. **A rewritten `MONGODB_URI`** in that copied `Backend/.env`, pointing at this
   worktree's database. The previous value is kept as a comment. See below for
   why this matters.

Then:

```bash
cd ../worktrees/feature-iso-412-time-tracking
npm run dev:up
```

## Why MONGODB_URI is rewritten

`Backend/.env` is copied verbatim, so without this step every worktree would
inherit the main clone's connection string.

Inside Docker that is harmless — `docker-compose.yml` overrides `MONGODB_URI`
itself. But anything run **natively** reads the file directly: `npm run
migrate`, `npm run schema`, or `npm run dev` from inside `Backend/`. On an
`--isolated-db` worktree that would mean a migration silently applied to the
shared database — precisely the failure isolation exists to prevent.

If you ever re-copy the env files, `npm run worktree -- sync-env` reapplies the
rewrite.

The first `dev:up` in a new worktree builds its own images. This is faster than
it sounds — the expensive `npm ci` layer is shared through Docker's build cache
whenever the lockfile is unchanged.

## Ticket conventions

Branches are `<type>/<TICKET>_<snake_case_description>`. The ticket is stored as
`TICKET` in the worktree's `.env` and shown by `worktree list`, so it can be
reused in commit messages and PR bodies without re-parsing the branch name.

This is a **new** convention: no branch currently on `origin` carries a ticket.
Passing an existing branch name directly bypasses the prompts, which is how you
check out pre-convention branches.

## What is shared, what is not

| | Shared across worktrees | Per worktree |
|---|---|---|
| Mongo, Redis containers | yes | |
| Database contents | yes, unless `--isolated-db` | |
| Docker network (`isoplus-net`) | yes | |
| `backend` / `frontend` containers | | yes |
| Host ports | | yes |
| `node_modules` volumes | | yes |
| `Backend/.env`, `Frontend/.env.local` | copied at creation, then independent | |

One Mongo and one Redis serve every worktree. That keeps memory use flat and
means a single `npm run seed` populates all of them.

## When to isolate the database

The shared database is the right default, but branches that change data shape —
migrations, destructive backfills, schema experiments — will corrupt what other
worktrees see. For those:

```bash
npm run worktree -- new --type feature --ticket ISO-412 --desc "schema change" --isolated-db
```

That worktree gets its own `MONGO_DB`: still
the same Mongo container, but a separate database inside it, so there is no
extra memory cost. Seed it separately:

```bash
cd ../worktrees/feature-iso-412-schema-change
npm run seed
```

Removing the worktree drops that database automatically.

## Listing and removing

```bash
npm run worktree -- list
```

```
==> 2 worktree(s)
    develop                       —        :3100/:4001  db=business-dashboard  .../isoplus-portal  <- you are here
    feature/ISO-412_time_tracking ISO-412  :3110/:4011  db=business-dashboard  .../isoplus-portal/worktrees/feature-iso-412-time-tracking
```

```bash
npm run worktree -- remove feature-iso-412-time-tracking
```

Removal stops that worktree's containers and volumes first — otherwise they are
orphaned, holding ports and disk with no directory left to manage them — drops
its isolated database if it had one, then removes the tree. Add `--force` to
discard uncommitted changes.

Removing the worktree does **not** delete the branch. `git branch -d <branch>`
separately.

## If the env files drift

Rotated a secret in the main clone and want it everywhere:

```bash
cd worktrees/whichever
npm run worktree -- sync-env
```

## Ports moved out from under you

The `.env` records ports that were free *at creation time*. If another process
later claims one, edit `FRONTEND_PORT` / `BACKEND_PORT` in that worktree's
`.env` and re-run `npm run dev:up`. Nothing else needs to change.

## Caveats

- **Branches predating this tooling have no `scripts/`.** A worktree cut from an
  older commit will not have `scripts/dev.mjs`. Rebase onto a branch that has
  it, or run the commands from the main clone.
- **One infra stack per machine.** `MONGO_PORT` and `REDIS_PORT` are read from
  whichever worktree starts infra first. Set them in the main clone.
- **`dev:down -- --all -v` is global.** It wipes the data every worktree shares,
  not just yours.
