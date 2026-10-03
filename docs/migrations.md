# Database migrations

Schema and data migrations use
[ts-migrate-mongoose](https://github.com/ilovepixelart/ts-migrate-mongoose).
Migrations are versioned files in `Backend/migrations/`, committed to the repo,
each recorded in a `migrations` collection in the database it was applied to.

## Commands

Run from the repo root. Each one execs into this worktree's backend container,
so it targets whichever database that worktree uses — including an
`--isolated-db` one.

```bash
npm run migrate -- list                     # what exists, and its state
npm run migrate -- create add-archived-flag # scaffold a new migration
npm run migrate -- up                       # apply everything pending
npm run migrate -- up <name>                # everything pending UP TO and including <name>, oldest first
npm run migrate -- up <name> --single       # only <name>
npm run migrate -- down <name>              # <name> AND every newer applied migration, newest first
npm run migrate -- down <name> --single     # only <name>
npm run migrate -- prune                    # drop records with no file
```

The `--` is npm's separator for passing arguments through. Without Docker —
running the backend natively — use `cd Backend && npm run migrate -- up`.

**`up <name>` and `down <name>` are not "only this one".** Checked against the
runner (`ts-migrate-mongoose`, `collectMigrationsToRun`): `up <name>` applies every
pending migration up to and including `<name>`, oldest first, and `down <name>`
rolls back `<name>` and every NEWER applied migration, newest first. Add `--single`
(`-s`) to either to act on just the named migration. On 2026-10-04 an
`up backfill-document-numbering-initialized` on dev, without `--single`, also applied
the six older migrations that had never run there. Always run `list` first, and
use `--single` unless you really mean "everything up to here".

**`list` is not read-only.** It first syncs: migration files that are not yet
recorded in the database are imported into the `migrations` collection, after an
interactive checkbox prompt (without a terminal it imports them all). Against a
remote database that is a write, and `list` does not need `--allow-remote`.

`up` and `down` take the **bare migration name**, not the filename:
`add-archived-flag`, not `1785922362521-add-archived-flag.js`.

## Look at the schema first

**Before writing a migration, run `npm run schema`.** A migration is a claim
about what the data currently looks like, and the models are only half the
story — they say what the code expects, not what is actually stored.

```bash
npm run schema                  # every collection
npm run schema -- boards        # one collection, by name or model
npm run schema -- boards --json # machine-readable, for tooling or an agent
```

For each collection it prints the declared Mongoose path (type, required,
default, ref, unique) beside what a live sample actually contains (how often
each field is present, and which types it holds), the real indexes, and then
the part that matters:

```
Drift — read this before writing a migration:
  declared but absent from the sample: attribute.name, pdfAttribute.name
    -> existing documents predate the field; a backfill is probably needed.
```

Three kinds of drift are reported, each mapping to a way migrations go wrong:

| Reported | What it means for your migration |
|---|---|
| **declared but absent from the sample** | The model gained a field that existing documents never got. A `default` in the schema does **not** write itself to stored documents — only to new ones. If code will read this field, backfill it. |
| **in the data but not in the model** | A field removed from the schema but never cleaned up, or written outside Mongoose. Safe to drop only once you know nothing still reads it. |
| **required but not universally present** | The schema says required, the data disagrees. A migration that assumes the field exists will throw partway through and leave the collection half-migrated. |

Fields are sampled (200 documents by default, `--sample=1000` for more), so
100% presence is strong evidence, not proof. Schema-less containers — `Item.data`,
`AuditTrail.metadata` — are collapsed to a key count rather than expanded, since
their keys are user-defined board columns and not schema at all.

Empty collections say so explicitly instead of reporting every field as missing.

## Writing one

`create` scaffolds from `Backend/migrations/template.js`:

```js
/**
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  await connection.collection('boards').updateMany(
    { archived: { $exists: false } },
    { $set: { archived: false } },
  )
}

/**
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  await connection.collection('boards').updateMany({}, { $unset: { archived: '' } })
}
```

Both functions receive the live Mongoose connection. Use
`connection.collection(...)` for raw driver access, or import a model from
`../src/models` when you want schema validation and hooks.

**Write a real `down`.** A migration you cannot roll back is one you cannot
safely deploy. If a change is genuinely irreversible — dropping a field whose
values are not recoverable — say so in a comment at the top of the file, and
consider a two-step deploy that stops writing the field before removing it.

## Conventions

- **Files are `.js`, not `.ts`.** The Backend is ESM JavaScript with no
  TypeScript toolchain. The upstream CLI always writes `.ts`, so
  `Backend/scripts/migrate.mjs` renames it after `create`. The runner loads
  `.js` natively.
- **Migrations are committed.** They are schema history; a migration only on
  one machine is not a migration.
- **Never edit an applied migration.** Once it has run anywhere but your own
  machine, it is immutable — write a new one.
- **Keep them independent of application code where you can.** A migration that
  imports a model will break when that model later changes. Raw collection
  access ages better.

## The connection string

There is exactly one connection string in this project: `MONGODB_URI`.

`ts-migrate-mongoose` normally wants its own `uri` or `MIGRATE_MONGO_URI`, which
would be a second copy free to drift from the first — a migration pointed at the
wrong database waiting to happen. `Backend/scripts/migrate.mjs` therefore
resolves `MONGODB_URI` exactly as the app does (compose environment in Docker,
`Backend/.env` when running natively) and passes it through as
`MIGRATE_MONGO_URI`.

Everything else lives in `Backend/migrate.json`: the `migrations` collection
name, the migrations path and the template path.

## The remote guard

The wrapper refuses to run against a URI that does not look local
(`localhost`, `127.0.0.1`, or the compose service `mongo`), unless you pass
`--allow-remote`:

```bash
npm run migrate -- up --allow-remote
```

This exists because `up` is destructive and effectively irreversible against
production data. Deliberately typing `--allow-remote` is the point.

## Worktrees

`npm run migrate` targets the database of the worktree you are standing in. A
worktree created with `--isolated-db` has its own database, so you can develop
a migration there without touching what other worktrees see:

```bash
npm run worktree -- new feature/archive-boards --isolated-db
cd ../worktrees/feature-archive-boards
npm run dev:up
npm run seed
npm run migrate -- up
```

Worktrees sharing the default database share its migration state too. If two
branches add different migrations against the shared database, roll one back
before switching, or use `--isolated-db`.

## Deployment

Migrations are **not** run automatically on boot, and deliberately so: several
containers start at once and would race, and an automatic migration on deploy
turns a bad migration into an outage with no decision point.

`ts-migrate-mongoose` is a regular dependency, so it ships in the Elastic
Beanstalk bundle and can be run against an environment explicitly:

```bash
cd Backend
MONGODB_URI="<target>" npm run migrate -- up --allow-remote
```

Run it as a deliberate step, after taking a backup, and check `list` first.
