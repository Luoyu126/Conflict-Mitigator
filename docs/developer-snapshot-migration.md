# Developer snapshot migration

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
| 1. Contracts and configuration | Review v0.2 overrides against existing decisions; shared DTOs and validation schemas; environment example; required dependencies and lockfile; TypeScript configuration | Resolve any actual contract disagreement; clean dependency install; typecheck; retain existing media tests. Defer the LiveKit data grant change until its transport is reviewed. |
| 2. Database and server foundation | Migration 002, database access, membership and event repositories, authentication, HTTP errors, validation and idempotency | Run migration and SQL assertions in a disposable database; verify RLS, private-message ownership, expiry visibility and idempotency. Verify upgrade behavior with representative existing rows. Do not apply to a shared database as part of a code merge. |
| 3. Room lifecycle and public reads | Room/join/consent/leave/end services and routes; transcript and map queries | Authenticated room lifecycle tests, cross-room access rejection, token restrictions and consent revisions; document and test pending media cleanup. Include required mediation state handling. |
| 4. Media and meeting analysis | LiveKit final-transcript data grant, browser transport contracts, internal APIs, disabled visual endpoints, webhook, meeting analysis and worker integration | Implement or locate the running Worker; prove packet-to-API-22 ingestion, lease checks, analysis dispatch, and server-side media removal. Verify disabled visual responses. |
| 5. Private mediation | Mediation routes/services, Gemini adapter, consensus tree, proposal and isolation transitions, resume and cancellation | Isolated database lifecycle tests; real media isolation before chat; per-user private access; same-version unanimous resume; provider configuration and timeouts; scheduled retention cleanup. |
| 6. Browser experience | Use `feature/frontend` as the primary source for design and wording; complete the coverage inventory above; use migration UI only for uncovered cases; integrate reviewed auth/Realtime, API client and media hooks; update outdated README text | Compare browser rendering and wording against the recorded primary revision; verify consistent styling for fallback states; replace production fixture/simulation paths with real APIs; build with freshly installed platform dependencies; multi-user smoke tests covering join, transcription, proposal, isolation, private chat, reconnect and leave. |

`services/rooms`, `services/worker`, `services/mediation`, and shared repository
exports cross domain boundaries. Check imports and state transitions while forming
each batch; split files or combine coupled batches where necessary. Automatic
proposal and isolation acknowledgement couple batches 4 and 5. Never enable a
partial public/private media workflow before both sides are verified.

## Known follow-up work

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

## Validation status

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
