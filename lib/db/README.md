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

`migrations/003_multimodal_foundation.sql` enables independently consented visual
and voice analysis, owner-only observations, media cleanup fencing, evidence
revisions and private-chat readiness. It revokes direct browser access to business
and private tables; only the privacy-safe `room_events` invalidation channel remains.
Business reads and writes go through authenticated server APIs. Never expose the
database owner or `service_role` credentials to the browser.

Apply each migration once, in numeric order, to the intended database using
`psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f <migration-file>`. Docker initializes
only 001; an existing Docker volume also needs 002 and 003 explicitly applied.
Back up an existing database first and record applied migrations. Do not rerun 001
or remove a volume to upgrade it. These instructions do not migrate a shared or
remote database automatically.

The running media Worker calls maintenance every two seconds. It expires private
messages and observations after 24 hours, cancels expired proposals, and cleans
up mediation entry that has not completed within 30 seconds. Keep the Worker
running even when the web service has no requests.

## Schema validation

After applying all three migrations to a disposable database, set `DATABASE_URL`
and run `npm run test:server` and `npm run test:http`. The legacy
`tests/database/schema_v02.sql` documents the older 002-only access policy and is
not the acceptance suite for 003. Current tests cover revoked direct grants,
owner-only HTTP projections, consent revisions, cleanup and isolation.
