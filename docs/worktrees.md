# Worktrees

A git worktree is a second checkout of the same repository, on a different
branch, in a different directory, sharing one `.git`. It lets you work on two
branches at once without stashing, and — with the setup below — run both
applications at once on different ports.

## Layout

Worktrees are created as **siblings** of the main clone, never inside it:

```
hillsgrade/
├── isoplus-portal/                 main clone, develop, :3100 / :4001
└── worktrees/
    ├── feature-invoice-export/     :3110 / :4011
    └── bugfix-login-spinner/       :3120 / :4021
```

Placing them outside the repository keeps them out of Docker build contexts,
out of `next build` traversal, and out of every glob in the repo.

## Creating one

```bash
npm run worktree -- new feature/invoice-export
```

This does five things:

1. Creates the worktree at `../worktrees/feature-invoice-export`. If the branch
   exists locally it is reused; if it exists on `origin` it is checked out with
   tracking; otherwise it is cut from `origin/develop` (override with
   `--from <ref>`).
2. Picks a **frontend/backend port pair that is genuinely free**, by asking the
   OS to bind them rather than parsing `netstat`.
3. Writes the worktree's `.env` with those ports and a distinct
   `COMPOSE_PROJECT_NAME`.
4. Copies `Backend/.env` and `Frontend/.env.local` from the main clone. These
   are gitignored, so a fresh worktree would otherwise have neither, and the
   API calls `process.exit(1)` on boot without them. **This is the step that is
   easiest to forget when doing it by hand.**
5. Prints the URLs.

Then:

```bash
cd ../worktrees/feature-invoice-export
npm run dev:up
```

The first `dev:up` in a new worktree builds its own images. This is faster than
it sounds — the expensive `npm ci` layer is shared through Docker's build cache
whenever the lockfile is unchanged.

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
npm run worktree -- new feature/schema-change --isolated-db
```

That worktree gets `MONGO_DB=business-dashboard-feature-schema-change`: still
the same Mongo container, but a separate database inside it, so there is no
extra memory cost. Seed it separately:

```bash
cd ../worktrees/feature-schema-change
npm run seed
```

Removing the worktree drops that database automatically.

## Listing and removing

```bash
npm run worktree -- list
```

```
==> 2 worktree(s)
    develop                 :3100/:4001  db=business-dashboard  /home/you/hillsgrade/isoplus-portal  <- you are here
    feature/invoice-export  :3110/:4011  db=business-dashboard  /home/you/hillsgrade/worktrees/feature-invoice-export
```

```bash
npm run worktree -- remove feature-invoice-export
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
cd ../worktrees/whichever
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
