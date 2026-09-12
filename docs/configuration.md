# Configuration

Copy `.env.example` to an ignored `.env.local` for local development and fill in
values without committing them. Next.js loads environment files only from this
project root; the parent `hackathon/.env.local` is not loaded automatically.

## Browser-visible values

Only these values may use the `NEXT_PUBLIC_` prefix and enter the browser bundle:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

The anonymous key is constrained by Supabase Row Level Security. It is not a
replacement for RLS or application authorization.

## Server-only secrets

The following values must never be imported by Client Components, returned by an
API, logged, or prefixed with `NEXT_PUBLIC_`:

- `SUPABASE_SERVICE_ROLE_KEY`
- `DATABASE_URL`
- `GEMINI_API_KEY`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `WORKER_SERVICE_TOKEN`
- `INFERENCE_SERVICE_TOKEN`
- `CRON_SECRET`

`GEMINI_MODEL` defaults to the confirmed target `gemini-3.6-flash`; the exact
provider identifier must still be verified before enabling model calls.

`APP_ORIGIN` is the Next.js application origin. API-27 is disabled in v0.2, so
`INFERENCE_ORIGIN` may equal `APP_ORIGIN` for this version while preserving the
interface boundary.

## Environment handling

- `.env.local` and other real environment files remain ignored.
- `.env.example` contains names and safe defaults only; never put real values in it.
- `NEXT_PUBLIC_` values are frozen into the client bundle during `next build`.
- Worker processes running outside Next.js must receive the same server-only values
  through their host's secret manager or an ignored local environment file.
