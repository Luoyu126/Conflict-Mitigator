# Frontend migration acceptance

This browser check runs the actual application pages with intercepted anonymous-auth
and business API responses. It exercises frontend routing and state handling; it
is **not** a Supabase, LiveKit, microphone/camera, Face++, Hume, or Gemini integration
test. Requests to origins other than the configured localhost app and mock-auth
origins are blocked. No existing room or database is changed.

Start a dedicated development server with the following **test-only** configuration:

```sh
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:59999 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=local-browser-test-key \
npm run dev -- --webpack --hostname 127.0.0.1 --port 3104
```

No server needs to listen on port 59999: the browser intercepts auth requests.
Webpack supports worktrees that symlink their dependency directory outside the
project; ordinary installations can use the default development bundler.
Do not reuse a server compiled with real Supabase configuration.

In another terminal, run from the repository root:

```sh
APP_ORIGIN=http://127.0.0.1:3104 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium \
node tests/browser/migration-acceptance.mjs
```

`playwright-core` is a repository dependency. Provide an existing Chromium
executable, or omit `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if a compatible Playwright
browser is already installed at its default location. In an isolated container
that requires disabling Chromium's sandbox, set `PLAYWRIGHT_NO_SANDBOX=1`.
An extracted browser may additionally require its own `LD_LIBRARY_PATH`.

Optional variables:

- `APP_ORIGIN`: default `http://127.0.0.1:3104`; only localhost origins are accepted.
- `MOCK_SUPABASE_ORIGIN`: default `http://127.0.0.1:59999`; must match the development
  server's `NEXT_PUBLIC_SUPABASE_URL` and must be a localhost origin.
- `BROWSER_ARTIFACT_DIR`: screenshot destination; defaults to a new temporary
  directory whose path is printed on completion.

The check verifies:

1. Create and join navigation, with all four analysis/sharing choices initially off.
2. UUID rooms display API-provided map and transcript content without demo people.
3. Starting private mediation stops new media-token requests.
4. Private messages come from the API; retrying a failed send reuses `clientMessageId`.
5. Resume submits the displayed `summaryVersion`, waits for completed server state,
   then requests fresh media credentials.
6. Multiple independent roots and nested descendants all render inside the fitted canvas, with only real parent-child edges; node selection and zoom remain usable.
7. The flow emits no uncaught browser errors.

Lobby, live meeting, and private mediation screenshots are saved for visual review.
The fixture deliberately makes media-token requests return a retryable conflict:
real device and media lifecycle acceptance remains a separate integration check.
