# Local PostgreSQL

The local database uses PostgreSQL 16 in Docker, bound to `127.0.0.1:5432`.
Database and bootstrap owner: `conflict_mitigator`.
The password is in the ignored `.env.postgres.local` file. The application's
`DATABASE_URL` is in the ignored `.env.local` file.

Start the database from the repository root:

```bash
sudo docker compose --env-file .env.postgres.local up -d postgres
```

Open a SQL session:

```bash
sudo docker compose --env-file .env.postgres.local exec postgres psql -U conflict_mitigator -d conflict_mitigator
```

Stop the service while retaining its data:

```bash
sudo docker compose --env-file .env.postgres.local stop postgres
```

On a fresh checkout, create `.env.postgres.local` with a randomly generated
`POSTGRES_PASSWORD` before starting, and set the matching `DATABASE_URL` locally.
Never commit either environment file. Data persists in the project's Docker volume.

## Schema

`migrations/001_initial_schema.sql` implements the seven tables in
`docs/database_schema.md`. Docker applies it only when initializing an empty data
volume. Editing it does not migrate an existing database; use a new migration for
later changes. Do not remove the volume to apply schema updates.

`migrations/002_v02_supabase_schema.sql` is the additive implementation schema for
the confirmed v0.2 contract. It adds anonymous-auth identity binding, consent and
media isolation state, transcript revisions/evidence, the full mediation state
machine, versioned consensus trees, idempotency and Worker receipts, privacy-safe
Realtime invalidations, RLS, cascading room deletion, and 24-hour private-message
expiry. Apply migrations in numeric order. The cleanup function is defined here;
configuring a remote scheduler remains a separately permission-gated deployment
action.

IDs use UUIDs as specified by the database field definitions (`room_123` in the
document is an illustrative identifier, not a valid UUID). Required fields follow
the TypeScript models. Scores use double precision with range checks; structured
lists use JSONB arrays. Defaults initialize UUIDs, timestamps, states, and lists.
Triggers maintain `updated_at`; foreign keys use PostgreSQL's default NO ACTION
deletion behavior. Multiple mediation sessions per node are supported.

After migration 002, browser roles have read-only RLS access to safe shared tables,
members can see only their own unexpired private messages, and sensitive analysis
tables remain inaccessible directly. Application writes still go through the
authenticated server service. The bootstrap owner/superuser and Supabase
`service_role` can bypass RLS, so those credentials must never reach the browser.

## Schema validation

After applying both migrations to a disposable database, run:

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" < tests/database/schema_v02.sql
```

The test runs in a transaction and rolls back. It verifies room-member RLS,
participant-only private messages, immediate expiry visibility, physical cleanup,
and cascading room deletion.
