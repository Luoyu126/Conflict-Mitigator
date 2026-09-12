# Developer snapshot migration

## Execution status (2026-09-12)

The user approved execution, parallel module work, and owner-only emotion results
with authorized backend analysis. The original snapshot remains preserved on
`chore/import-developer-snapshot`; the integration branch is
`feat/migration-foundation`.

| Stage | Integrated commits | Outcome |
|---|---|---|
| Backend and shared contracts | `c8c81d79` through `71b6b437` | Authenticated APIs, migration 003, separate consents, shared media lifecycle, transactional Worker and mediation safeguards; accepted foundation fast-forwarded to local main. |
| Emotion modules | `e572807f`, `acecc713`, `cb799df7` | Hume adapter, Face++ inference, shared VAD presentation; preserves modality-specific scores and experimental mappings. |
| Backend runtime integration | `adb5ddf2`, `f977f48c` | Enabled private observation ingest, evidence checks, maintenance and a runnable LiveKit Worker with lease/control fencing. |
| HTTP acceptance | `0c6ff126` | Real Next.js handlers with local fake auth and disposable PostgreSQL. |
| Primary frontend | `98a11727` | feature/frontend design and copy, real UUID meeting/lobby/private workflows, independently consented media and owner-only result panels. |

The resulting source is integrated incrementally into **local main** after combined
acceptance. No remote push or deployment is part of this execution. Existing local
ZIP/debug content and environment files are preserved. SQL migrations were applied
only to an isolated temporary PostgreSQL database, not the user's shared database.

Validation at module integration: 72 server tests, 10 media tests and 16 Worker tests
passed without skips; TypeScript, ESLint and the complete production webpack build
passed. All 6 HTTP tests passed, verifying owner-only reads and consent withdrawal. Browser
acceptance uses mocked API/auth responses and covers create, lobby, live transcript
and map, isolated private chat, idempotent retry and versioned resume. Reproducible
HTTP and browser acceptance scripts live under `tests/`.

Remaining environment acceptance: configure real Supabase/LiveKit/provider accounts,
apply migrations to the chosen database, run both processes, and verify real two-person
camera/audio, browser speech support, Chinese voice quality, provider failures and
media isolation. No claim of successful live Face++, Hume or Gemini calls is made.
See [README](../README.md) for configuration, startup and current limitations.

The following sections preserve the original source inventory and planning rationale.
Statements about features being absent describe the **pre-migration snapshot**;
the execution status above and [multimodal v0.3](api/multimodal-v0.3.md) are current.

## Source and preservation

- Import branch: `chore/import-developer-snapshot`.
- Base: local `main` at `11707e2a` (one commit ahead of the locally recorded
  `origin/main`; no remote refresh or push was performed).
- Source commit: `0f4955c3` (`chore(migration): import developer source archive`).
- Archive: `Conflict-Mitigator-main.zip`.
- Archive SHA-256:
  `1bc585c64b743f37dd7a3ba6d44d436993f8ddefd348ebde38ad5607d7ff07f6`.
- 125 source/configuration/documentation files imported: 29 modified and 61 added
  relative to the base, with no tracked files deleted.
- The garbled archive filename was mapped to `龙虾建议-补充决策确认.md`.
  Its contents, including the appended third-round decisions, were preserved.
- Dependencies, build output, TypeScript cache, generated `next-env.d.ts`, and
  macOS metadata were excluded. The original archive remains outside Git.
- The import preserves the developer's implementation and contract claims;
  it does not certify correctness or independently validate their approval history.

## Proposed integration sequence

Keep the import commit as the backend and fallback source reference. Create each integration branch
from the latest accepted `main`, port the relevant changes, and review its complete
dependency closure. Do not cherry-pick the entire import for a partial rollout.
The batches below are review scopes, not independently cherry-pickable commits.

### Frontend source priority (user direction, 2026-09-12)

The primary frontend source is **`feature/frontend`**, verified on the remote at
`7fdea3127fca47eeab4126ac3e457365df1a9bc1`. This is the branch the user referred to
as `feature:fronted`. Before implementation, check for newer commits and record
the exact revision used for review.

- Preserve this branch's existing page design, layout, typography, colors,
  component appearance, visible wording, labels, and presentation interactions.
  When both branches cover the same UI, `feature/frontend` takes precedence.
- Consult `chore/import-developer-snapshot` only for frontend cases absent from
  `feature/frontend`. Adapt fallback UI to the primary design and wording style;
  do not replace an existing primary page with the archive's page wholesale.
- Use reviewed migration-branch backend services, API clients, authentication,
  Realtime and media hooks to connect the primary UI to real data. Presentation
  priority does not authorize changing API contracts, consent, privacy or
  server-controlled lifecycle rules to match a demo.
- Inventory coverage by page, component, control, and state before porting UI.
  Record each item's primary reference, missing behavior, fallback source and
  required API integration. Check loading, empty, error, disconnected, waiting,
  cancelled and ended states individually rather than declaring a whole page
  uncovered because one state is missing.

Initial source inspection (not browser visual acceptance):

| Area | Primary branch coverage | Integration treatment |
|---|---|---|
| Global presentation | `app/globals.css`, `app/layout.tsx` | Preserve primary styling and typography; integrate required providers without reverting presentation. |
| Home | `app/_components/home-hero.tsx`, `app/page.tsx`; preview entry and existing copy | Preserve existing design/copy; consult migration forms for missing create/join behavior and fit them to this design. |
| Lobby | Placeholder page only | Consult migration lobby for missing controls and states; carry over any applicable primary wording and apply the primary visual style. |
| Meeting | `mind-map-workspace.tsx` and its CSS module, meeting page, transcript/map fixtures | Preserve workspace design and labels; connect reviewed room, map, transcript, audio and mediation APIs. |
| Private mediation | `mediation-room.tsx` and its CSS module, mediation page | Preserve existing design/copy; connect real private chat, consensus tree, consent, isolation and resume state. Consult the snapshot for uncovered states only. |

The primary branch is based on older scaffold history and uses fixtures,
synthetic transitions and replay query parameters. Review changes relative to its
merge base; port its frontend additions without reverting newer `main` backend,
documentation or dependencies. Its `contracts/mind-map.ts` includes demo-specific
shapes; adapt the presentation to the approved DTOs instead of adopting fixture
schemas as production API contracts. Demonstration content and simulated progress
must not substitute for real transcripts, model replies or server authorization.

| Batch | Scope | Required evidence before merging |
|---|---|---|
| 1. Contracts and configuration | Review v0.2 overrides against existing decisions and the new multimodal direction below; shared DTOs and validation schemas; environment example; required dependencies and lockfile; TypeScript configuration | Resolve any actual contract disagreement; define audio/visual observation ownership and consent; clean dependency install; typecheck; retain existing media tests. Defer media grant changes until their transport is reviewed. |
| 2. Database and server foundation | Migration 002, database access, membership and event repositories, authentication, HTTP errors, validation and idempotency | Run migration and SQL assertions in a disposable database; verify RLS, private-message ownership, expiry visibility and idempotency. Verify upgrade behavior with representative existing rows. Do not apply to a shared database as part of a code merge. |
| 3. Room lifecycle and public reads | Room/join/consent/leave/end services and routes; transcript and map queries | Authenticated room lifecycle tests, cross-room access rejection, token restrictions and consent revisions; document and test pending media cleanup. Include required mediation state handling. |
| 4. Media and meeting analysis | LiveKit media/data grants, browser transport contracts, internal APIs, webcam and voice emotion adapters, webhook, meeting analysis and worker integration | Implement or locate the running Worker; prove packet-to-API-22 ingestion, lease checks, analysis dispatch, server-side media removal, and modality-specific consent/withdrawal. Enable visual endpoints only after revising the conflicting v0.2 contract. |
| 5. Private mediation | Mediation routes/services, Gemini adapter, consensus tree, proposal and isolation transitions, resume and cancellation | Isolated database lifecycle tests; real media isolation before chat; per-user private access; same-version unanimous resume; provider configuration and timeouts; scheduled retention cleanup. |
| 6. Browser experience | Use `feature/frontend` as the primary source for design and wording; complete the coverage inventory above; use migration UI only for uncovered cases; integrate reviewed auth/Realtime, API client and media hooks; update outdated README text | Compare browser rendering and wording against the recorded primary revision; verify consistent styling for fallback states; replace production fixture/simulation paths with real APIs; build with freshly installed platform dependencies; multi-user smoke tests covering join, transcription, proposal, isolation, private chat, reconnect and leave. |

`services/rooms`, `services/worker`, `services/mediation`, and shared repository
exports cross domain boundaries. Check imports and state transitions while forming
each batch; split files or combine coupled batches where necessary. Automatic
proposal and isolation acknowledgement couple batches 4 and 5. Never enable a
partial public/private media workflow before both sides are verified.

### Multimodal scope and parallel implementation

The user additionally requests camera, voice, and their respective emotion
recognition capabilities from these source branches:

- `feat/livekit-camera-emotion` at `919c1a8a`: LiveKit video controls, Face++
  frame analysis, seven-category parsing, experimental VAD and bounded trails.
- `feat/hume-voice-emotion` at `74e7308c`: LiveKit voice controls, PCM streaming
  through a server-side Hume EVI relay, 48-field emotion parsing and experimental
  VAD display. The existing `main` LiveKit audio primitives remain the starting
  point for shared media integration.

**Confirmed result visibility:** the participant may see their own emotion
results, and the backend may use them for mediation analysis. Other participants
must not receive that person's scores. Apply this boundary to HTTP projections,
Realtime payloads, shared trees, logs, and model context supplied for other users.
It supersedes the imported plan's camera exclusion and backend-only score display
direction; it does not authorize publishing individual scores or raw private data.

These are local experiment branches. Their demo token endpoints and localhost
relays do not provide production participant authorization. Do not merge the
debug applications or their authentication assumptions as production features.
Face++ processes sampled images and Hume processes audio externally; credentials
remain server-side. The Hume experiment can generate unplayed upstream replies
and incur usage; operational configuration needs validation before enabling it.

The recommended execution order is **shared foundation, parallel modules, then
integrated acceptance**. The numbered batches above remain functional review
scopes; they need not all be implemented serially.

1. **Define shared contracts before enabling the new features.** Align the API
   documents, consent semantics, observation types, database changes and private
   result projections. The snapshot currently enforces disabled vision in
   `contracts/rooms.ts`, `services/rooms/index.ts`, migration 002's
   `CHECK (visual_affect_consent = false)`, microphone-only token grants and
   API-23/API-27 handlers. Voice emotion has no dedicated consent/observation
   contract; transcription consent alone does not authorize this new purpose.
   Define source, owner, track/stream identity, timing, validity, consent revision,
   retention and access rules together. Preserve an applied migration's history;
   use a subsequent migration where required by actual deployment state.
2. **Land a working foundation through a reviewed integration branch.** Include
   the required parts of batches 1–3: authentication, database access, uniform
   responses, room membership, join/token/leave, consent and media lifecycle.
   Keep `feature/frontend` as the presentation baseline. One owner supplies the
   LiveKit connection, track/device lifecycle, control context and module slots.
   Verify a real create/join/leave path and cross-user access controls; a directory
   skeleton or fixture-driven page does not satisfy this prerequisite. Keep
   unfinished analysis features disabled until their complete paths are tested.
3. **Branch all parallel tasks from the same accepted foundation commit.** Use
   separate worktrees. With four agent slots, the coordinator owns shared
   infrastructure/integration while three agents own frontend, camera and voice.
   Worker and mediation integration can proceed with the coordinator and then
   freed agents; do not add concurrent writers to shared infrastructure files.
4. **Integrate completed modules serially into an integration branch.** Each
   module supplies focused tests and its exact base/commit. Resolve dependencies
   and run combined validation before merging a reviewable increment to `main`.
   Do not merge the complete source snapshot or all experiment branches at once.

| Owner | Independent scope | Shared files outside that owner's edits |
|---|---|---|
| Coordinator / foundation | API and observation contracts, SQL, auth, room/media lifecycle, Worker orchestration, dependency manifest/lockfile, shared VAD types/plot, final integration | Sole owner of shared interfaces; collect requested changes from module agents before revising them. |
| Frontend agent | Primary `feature/frontend` pages/components, copy and styles; own-result panels and missing states integrated through agreed module slots | No independent changes to auth, SQL, media tokens, provider adapters or shared contracts. |
| Camera agent | Extract Face++ adapter and response parsing from `debug/app/api/face-emotion/route.ts` and `debug/lib/face-emotion.ts`; visual validity/expiry and consent-stop behavior with tests | Do not copy the debug upload endpoint into the public API or modify shared meeting pages, token grants, VAD plot or package files. |
| Voice agent | Extract Hume transport/parsing from `debug/evi-server.mjs`, `debug/lib/emotions.ts`, and PCM conversion from `debug/public/pcm-worklet.js`; streaming lifecycle and tests | Do not ship localhost-only auth, independently own a second meeting microphone, change public STT selection, shared VAD plot or package files. |

Freeze the track/control and observation interfaces before assigning these
implementation tasks. Camera and voice both include `vad.ts` / `vad-plot.tsx`,
so their common presentation/types must be consolidated once; keep modality
mapping parameters separate. These mappings are experimental and uncalibrated:
never copy their values directly into `contentionScore`, substitute missing
results with calmness, or average the two modalities as equivalent measurements.
Backend use must retain source validity and discussion evidence.

The current canonical transcript source remains browser-final speech recognition
through LiveKit packets and API-22. Hume's incidental transcripts must not become
a second public transcript writer. If that source is to change, update the
contract explicitly before implementation.

Before implementation, settle the remaining transport details against the API
contracts: the camera demo uses a browser upload, while API-27/API-23 specify a
Worker/inference path; the Hume demo uses its own browser microphone and local
relay, while production needs authenticated, consent-controlled media ownership.
These choices must be resolved in the foundation review, not invented separately
by the module agents. This plan does not introduce a new HTTP endpoint or field.

Combined acceptance must cover permission denial, consent withdrawal, stale and
unavailable results, per-user result access, supplier failure, disconnect/rejoin,
and private mediation. Entering isolation must stop camera, voice, STT and both
emotion-analysis streams, reject stale in-flight results, and prevent shared
media re-entry until authorized. Leaving/ending must release devices and provider
connections. Verify the primary frontend design and copy after all modules join.

## Pre-migration findings (historical)

- The snapshot contains packet normalization and a meeting-analysis function, but
  the inspection did not locate a running Worker entry point, its LiveKit packet
  subscription, observer dispatch, or actual participant-removal calls.
- `services/media/index.ts` remains a placeholder. Stored cleanup/isolation plans
  are not proof that LiveKit actions execute.
- Migration 002 defines `cleanup_expired_private_messages()` but explicitly does
  not schedule it. Verify retention enforcement and configure a maintenance job.
- The Gemini adapter uses a configured/default model string; successful provider
  identification and calls have not been verified.
- README still describes placeholder pages and missing routes despite this import.
- The snapshot adds contract overrides and third-round decision text. Review these
  alongside the existing decision record before integrating behavior into `main`.
- Frontend browser acceptance and the detailed state coverage inventory remain
  pending. Existing primary design and copy must be preserved during integration;
  contract conflicts that cannot be resolved from evidence require user judgment.

## Initial snapshot validation (historical)

The extracted snapshot passed TypeScript (`--noEmit --incremental false`) and
ESLint commands using its bundled dependencies during initial investigation.
The Node test command exited successfully, but only file-level results appeared;
individual assertions and skip reporting still need verification. Database access
was explicitly disabled for that invocation.

The import itself is checked for byte equality against all 125 included archive
files (with the single filename mapping), and `git diff --check` is run. This is a
source-preservation check, not a replacement for clean-install/build validation.
No database migration, external model/media call, deployment, remote push, or
merge into `main` has been performed.

For this plan update, remote heads were inspected and `feature/frontend` was
fetched for source comparison. Only this migration document was changed; neither
frontend source nor the imported implementation was modified.
