# HTTP integration tests

These tests launch the real Next.js development server with webpack, a local fake
Supabase `/auth/v1/user` server, and an existing **disposable localhost PostgreSQL**
database with all migrations applied. They exercise HTTP authentication, response
envelopes, idempotency, media token signing, membership/privacy, consent and internal
Worker lease enforcement. They never start LiveKit transport or call AI providers.

```bash
# Provide DATABASE_URL for the disposable database and install project dependencies.
node --test --test-isolation=none tests/http/routes.test.mjs
```

`CM_HTTP_DATABASE_URL` can override `DATABASE_URL`. `CM_HTTP_APP_DIR` can point to
another checkout whose current production source should run; otherwise this
checkout is used. Both local servers use ephemeral ports. Do not run another
`next dev` in that app checkout at the same time because Next holds a dev lock.

The harness stops its child process group and local auth server and removes only
its generated rooms/auth-subject idempotency records in teardown. A real socket
permission is required in restricted sandboxes. No production environment or
provider credentials are needed; all service/media signing credentials are fake.
