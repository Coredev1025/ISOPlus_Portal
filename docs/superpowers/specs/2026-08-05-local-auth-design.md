# Logging in locally without the live ISO+ OAuth

**Date:** 2026-08-05
**Status:** Implemented, and since extended — see [Changes since approval](#changes-since-approval).

> `npm run dev:user` shipped as designed. What the design did not anticipate is
> that logging in was not sufficient to *use* the application locally, which is
> recorded below rather than quietly rewritten. Operational detail lives in
> [`docs/local-development.md`](../../local-development.md), which supersedes
> this spec as the source of truth.

## Changes since approval

**Shipped as designed.** `npm run dev:user`, the local-only guard with no
`--allow-remote` escape hatch, no new authentication code, and no change to the
login UI. All goals in this document were met on their own terms.

**The gap this design missed.** Its first goal was "get a developer logged in
locally, offline, with no ISO+ connectivity". That was achieved — and a
developer who did it still saw an empty application. Signing in is not the
boundary that matters; `GET /api/workspaces` does not read MongoDB, it proxies
`app.isoplus.online/api/v2/workspaces` using the bearer that
`applyPrivilegedSessionAuth` builds from `PERSONAL_ACCESS_TOKEN`
(`middleware/authHelpers.js:37` → `services/isoplus.js:261`). With that variable
blank — which is how `.env.example` ships — the workspace list came back empty
and every page below it was unreachable. No amount of seeding fixed it, because
the list never came from the database.

So the design solved *authentication* and left *authorization-to-data* untouched,
having treated "logged in" as the finish line. Worth remembering as a general
shape: in a front end over someone else's platform, being signed in and having
data are separate problems.

**What closed it: offline mode**, `Backend/src/services/offlineIsoplus.js`.
Workspaces and boards are served from Mongo when `PERSONAL_ACCESS_TOKEN` is
blank and `NODE_ENV` is not production; `ISOPLUS_OFFLINE=1`/`0` forces it either
way. Board attributes come from a committed fixture. `routes/workspace.js`
already injected the ISO+ collection functions as dependencies, so this swaps
the provider rather than branching inside the request handler.

**This does not contradict the OAuth non-goal below.** Offline mode is not a
mock OAuth provider and touches no authentication code. The ISO+ button still
cannot work locally without `CLIENT_ID` — it builds an authorize URL with an
empty `client_id` and ISO+ answers `unsupported_grant_type`. That remains
deferred, and the administrator-credentials path from this design remains the
way in.

**Its limits**, in [`docs/local-development.md`](../../local-development.md#what-offline-mode-is-not):
items, references and values still read live ISO+; the attribute fixture holds
13 of the board's 511, enough for Board Configuration but not for reasoning
about pricing rules; and board scoping is approximate because 33 of 34 seeded
boards have a null `workspaceId`.

## Problem

Opening `http://localhost:3100` and clicking the primary **Sign in with ISO+™**
button redirects the developer to `https://app.isoplus.online` — the live ISO+
identity provider. Locally this cannot succeed: `CLIENT_ID`, `CLIENT_SECRET` and
`PERSONAL_ACCESS_TOKEN` in `Backend/.env` are empty. The developer is bounced to
a production system and cannot get into the application at all.

## What already exists

The application ships **two** login paths, both already wired up:

| Path | Frontend | Backend |
|---|---|---|
| ISO+ OAuth | `handleISOPlusLogin`, `Frontend/app/page.tsx:211` | `GET /api/auth/isoplus/redirect` → `/isoplus/callback` |
| Support-admin credentials | `handleAdminLogin`, `Frontend/app/page.tsx:183` | `POST /api/auth/login` |

The credentials form is reachable from the login screen: a ghost button at the
bottom sets `isSupportLogin(true)` (`Frontend/app/page.tsx:398`), swapping the
ISO+ button for an email/password form. `POST /api/auth/login` accepts any user
whose `role` is `support_admin` and whose password matches.

The seeded database already contains exactly such a user:

```
email:    arnold@hillsgrade.com.au
role:     support_admin
disabled: false
password: bcrypt hash present ($2a$10$…, 60 chars)
```

**Nothing needs to be built into the application.** The only missing piece is
that nobody knows that user's password. This spec covers making a known
password reliably settable on a local database.

## Goals

- Get a developer logged in locally, offline, with no ISO+ connectivity.
- Survive re-seeding, which drops and replaces the `users` collection.
- Work per-worktree, including `--isolated-db` worktrees.
- Add **no** authentication code, endpoint, or bypass to the application.

## Non-goals

- Exercising the ISO+ OAuth code path locally. A local mock OAuth provider was
  considered and explicitly deferred; it is the right tool only when developing
  the OAuth/callback/ticket code itself, and is a separate piece of work.
- A `/api/auth/dev-login` bypass endpoint. Rejected: it would place real
  auth-bypass code in a production repository that deploys automatically on
  merge. The existing credentials path makes it unnecessary.
- Changing the login UI, including which option is presented first.

## Design

### Command

`npm run dev:user`, alongside the existing `migrate` and `schema` commands and
following exactly the same shape: the root CLI (`scripts/dev.mjs user`) execs
into **this worktree's** backend container, so it targets whichever database
that worktree uses without the developer having to think about it.

| Flag | Effect |
|---|---|
| *(none)* | Set the default password on the single `support_admin` user |
| `--email <address>` | Target a specific user; required when several match |
| `--password <value>` | Use a specific password instead of the default |
| `--create` | Create the user when none exists |
| `--list` | Show local users, roles and disabled state; change nothing |

Default password: **`local-dev-only`**. Chosen to be self-evidently not a real
credential. Printed on success so it is never a secret to be looked up.

### Setting the password

Through the Mongoose `User` model, never a raw collection update:
`Backend/src/models/User.js` hashes on `pre('save')` with `bcrypt.hash(pw, 10)`,
and `comparePassword` verifies against that. Writing the collection directly
would store a plaintext value that `POST /api/auth/login` could never match.

The script therefore assigns `user.password = plain` and calls `user.save()`.

It also ensures the user is usable: `role` must be `support_admin` (the only
role `POST /api/auth/login` admits) and `disabled` must be `false`. Both are
corrected, and any correction is reported rather than done silently.

### The safety guard

The script **refuses to run unless `MONGODB_URI` is local** — host `localhost`,
`127.0.0.1`, or the compose service name `mongo`.

There is deliberately **no `--allow-remote` escape hatch**, unlike
`scripts/migrate.mjs`. Setting a known, published password on a real database is
categorically worse than a bad migration: it is a silent, immediate account
compromise. No flag should make it one keystroke away.

On refusal the script prints the masked URI and exits non-zero.

### Re-seeding

`npm run seed` restores with `--drop`, replacing the `users` collection and
discarding the password. This is expected, not a bug — but it is easy to forget
and presents as "my password stopped working".

`seed` therefore prints a reminder to re-run `npm run dev:user` when it finishes.

### Files

```
Backend/scripts/dev-user.mjs   new — the script
Backend/package.json           + "dev:user" script
scripts/dev.mjs                + `user` command, execs into the container
package.json                   + "dev:user" script
scripts/lib/seed.mjs           reminder after a restore
docs/local-development.md      new "Logging in locally" section
CLAUDE.md                      brief pointer
```

No file under `Backend/src/` or `Frontend/` is modified.

## Error handling

| Situation | Behaviour |
|---|---|
| `MONGODB_URI` not local | Refuse, print masked URI, exit 1 |
| No `support_admin` and no `--create` | List existing users, suggest `--create`, exit 1 |
| Several `support_admin` users | Require `--email`, list candidates, exit 1 |
| Backend container not running | Say so, suggest `npm run dev:up`, exit 1 |
| User exists with wrong role/disabled | Correct it, and report what was corrected |

## Verification

Claims require evidence. The work is done when:

1. `npm run dev:user` reports success against the seeded database.
2. `POST /api/auth/login` with the printed credentials returns **200** and sets
   a session cookie — proving the hash is one the application accepts, rather
   than trusting the script's own output.
3. A wrong password against the same endpoint still returns **401**, proving the
   script did not weaken credential checking.
4. `--list` shows the users without modifying anything.
5. Pointing `MONGODB_URI` at a non-local host causes a refusal and a non-zero
   exit.
6. `npm run seed` prints the reminder.
7. `git status` is clean of secrets, and no file under `Backend/src/` or
   `Frontend/` is changed.

## Risks

| Risk | Mitigation |
|---|---|
| A known password set on a real database | Local-only guard with no override; the default password is self-evidently fake. |
| Default password mistaken for a real credential | Named `local-dev-only`; printed, never hidden; documented as local-only. |
| Developer confused when re-seeding clears it | `seed` prints a reminder. |
| Perceived as an auth bypass in review | It is not: no application code changes, and the credential path being used already ships to production. The PR description should say so plainly. |
