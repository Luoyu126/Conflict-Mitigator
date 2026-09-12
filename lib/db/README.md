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

IDs use UUIDs as specified by the database field definitions (`room_123` in the
document is an illustrative identifier, not a valid UUID). Required fields follow
the TypeScript models. Scores use double precision with range checks; structured
lists use JSONB arrays. Defaults initialize UUIDs, timestamps, states, and lists.
Triggers maintain `updated_at`; foreign keys use PostgreSQL's default NO ACTION
deletion behavior. Multiple mediation sessions per node are supported.

Private messages have row-level security enabled with no participant policies yet,
so non-owner roles have no access by default. The bootstrap owner is a superuser
and bypasses RLS. Before implementing participant-facing access, add authenticated
authorization and a restricted application role; never expose the bootstrap
connection to the browser. Same-room membership checks and shared-summary content
filtering also belong in the upcoming authorization/API implementation.
