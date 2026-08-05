# Seed data

Database dumps used to populate the local Mongo. **Everything in this directory
except this file is gitignored, and must stay that way** — these archives
contain real ISO+ business data (workspaces, boards, invoices, users).

## Getting an archive

Ask the team for a current dump, or take one yourself:

```bash
mongodump --uri "<source-connection-string>" --archive --gzip > seed/isoplus-dump.archive.gz
```

The file must be `mongodump --archive --gzip` output. `dev.mjs seed` picks the
most recently modified `*.gz` in this directory unless you name one explicitly.

## Restoring

```bash
npm run seed              # prompts before dropping anything
npm run seed -- --yes     # skip the prompt
```

## The namespace remap

The dumps circulating in the team were taken from a database called **`isoplus`**,
but the application connects to **`business-dashboard`** (see
`Backend/.env.example`). `scripts/dev.mjs seed` therefore restores with:

```
--nsInclude=isoplus.*  --nsFrom=isoplus.*  --nsTo=<target>.*
```

`<target>` is `MONGO_DB` from your `.env`, so a worktree created with
`--isolated-db` seeds its own database rather than the shared one.

`--drop` is scoped by `--nsInclude`: it replaces only the collections the
archive contains, and leaves other databases in the container untouched.

## If your dump has a different source database

Change `DUMP_DB` in `scripts/lib/seed.mjs`, or restore by hand:

```bash
docker compose -f docker-compose.infra.yml exec -T mongo \
  mongorestore --archive --gzip --drop \
  --nsInclude='<source>.*' --nsFrom='<source>.*' --nsTo='business-dashboard.*' \
  < seed/your-dump.gz
```
