# Conflict Mitigator API decision overrides · v0.2

> **Current multimodal override:** [multimodal-v0.3.md](multimodal-v0.3.md) takes precedence for camera/voice consent, private emotion visibility and media lifecycle.


> Status: confirmed implementation contract · 2026-09-12

This document records confirmed product decisions that override conflicting
language in `frontend-api.md`, `internal-api.md`, `interact-api.md`, and the legacy
PRD. Unmentioned fields and behavior remain governed by those v0.1 documents.
When text conflicts, this document takes precedence.

## 1. Scope and media

- Implement API-01 through API-27. API-23 and API-27 remain addressable but are
  deliberately disabled as specified below.
- The current product is audio-only. Do not publish, subscribe to, persist, or
  analyze camera tracks. UI video regions are placeholders only.
- `Consents.visualAffect` remains in the compatibility DTO but is always `false`.
  The UI does not expose a visual-affect control. A request attempting to set it
  to `true` returns `409 FEATURE_DISABLED`.
- Raw audio is never stored.

## 2. Browser speech recognition transport

- Speech recognition runs in each participant's browser. There is no preset or
  manual transcript fallback; unsupported recognition and empty results are
  shown as unavailable or ignored.
- Only browser-confirmed final results are transported. Interim results may be
  displayed locally but are not published or persisted.
- The browser publishes final transcript envelopes as reliable LiveKit data
  packets on topic `cm.transcript.final.v1`. The participant token may publish
  data solely so this product flow can operate; it still grants no camera,
  screen-share, metadata-update, or room-admin capability.
- The worker trusts the LiveKit packet sender identity, not a display name or a
  participant ID inside the payload. It validates membership, consent revision,
  room state, payload size, topic, monotonic revision, and media isolation before
  translating the packet into API-22. Invalid packets are discarded and logged
  without their transcript content.
- API-22 remains Worker-authenticated. No browser service credential is exposed
  and no API-28 is added.

Final packet payload:

```json
{
  "segmentId": "uuid",
  "streamId": "uuid",
  "revision": 1,
  "content": "Final recognized text",
  "startedAtMs": null,
  "endedAtMs": null,
  "language": "en-US",
  "confidence": null,
  "consentRevision": 1,
  "recognizedAt": "2026-09-12T17:00:00.000Z"
}
```

`content` is 1–8000 characters after trimming. `segmentId` is stable for a
logical utterance, `revision` starts at 1, and time/confidence fields are nullable
when the Web Speech implementation does not provide reliable values.

## 3. Automatic mediation proposal

- Gemini 3.6 Flash is the configured model target. The implementation must verify
  the actual provider model identifier before enabling calls.
- API-24 accepts structured node analysis containing a 0–1 `contentionScore`.
  After accepting the analysis, the service automatically creates one proposed
  mediation session when the evaluated node simultaneously has:
  - `contentionScore >= 0.72`;
  - final transcript evidence from at least two distinct active participants; and
  - at least three final transcript segments.
- All active room participants are frozen into the proposal, including people who
  have not spoken about that node. Every member begins with `entryDecision=pending`.
  The LLM/service is the proposer and does not pre-accept for any participant.
- API-13 remains implemented for contract compatibility, but the product UI never
  exposes a manual proposal action. Both API-13 and the automatic path reuse the
  same authorization, idempotency, eligibility, and single-open-session domain
  service. The automatic API-24 path is the canonical product flow.
- A proposal never enters mediation by itself. Every frozen member must accept
  through API-14. Any decline cancels the proposal.

## 4. Room discovery and Realtime

The `Room` DTO returned through API-01/API-03/API-04 adds the required field:

| Field | Type | Meaning |
|---|---|---|
| `activeMediationNodeId` | UUID / null | Node associated with the single open mediation session; null when none exists. |

`activeMediationSessionId` and `activeMediationNodeId` change atomically.

Supabase Realtime emits room-scoped events with this envelope:

```json
{
  "type": "room.mediation.changed",
  "roomId": "uuid",
  "roomVersion": 12,
  "occurredAt": "2026-09-12T17:00:00.000Z",
  "activeMediationSessionId": "uuid-or-null",
  "activeMediationNodeId": "uuid-or-null"
}
```

Consensus-tree changes use `type=mediation.consensus-tree.changed` and additionally
contain `mediationSessionId` and `consensusTreeVersion`. Events are invalidation
signals; authorized clients refetch API-03 or API-15 rather than trusting event
payloads as full state. Presence tracks network presence only, not business
membership or authorization.

## 5. Media isolation and return

- All frozen members enter mediation together. After unanimous API-14 acceptance,
  every member disconnects from the public LiveKit audio room and new media tokens
  are blocked while the session is `starting` or `active`.
- API-25 records server-side isolation results. Private chat opens only after all
  members are isolated and the session becomes `active`.
- AI readiness only proposes a return. All members must accept the same summary
  version through API-18. On completion, each browser requests a fresh API-05
  token and reconnects to public audio.

## 6. Shared consensus tree

API-15 `MediationMeData` adds `consensusTree: ConsensusTree | null`. It is null
before generation and required once an active session has successfully generated
version 1. API-17 `ChatCompletedData` and `ChatPendingData` add the integer
`consensusTreeVersion`, which is `0` before generation.

```ts
type ConsensusTree = {
  version: number; // >= 1
  generatedAt: string; // UTC ISO8601
  nodes: ConsensusTreeNode[]; // 1..100
  edges: ConsensusTreeEdge[]; // 0..200
};

type ConsensusTreeNode = {
  id: string; // UUID, stable across versions while meaning is stable
  kind: "surface_conflict" | "participant_view" | "inferred_common_ground" | "open_question";
  label: string; // 1..1000, privacy-filtered
  participantId: string | null; // only participant_view may identify an owner
  epistemicStatus: "shared_statement" | "participant_confirmed" | "llm_inferred" | "insufficient_evidence";
};

type ConsensusTreeEdge = {
  id: string; // UUID
  sourceNodeId: string;
  targetNodeId: string;
  relation: "supports" | "conflicts_with" | "underlies" | "clarifies";
};
```

Version 1 is generated when mediation becomes active. A new version is committed
after an API-17 interaction successfully extracts privacy-safe structured state.
The tree may use shared meeting statements and the sharing allowlist: positions,
reasons/concerns, neutral misunderstanding descriptions, participant-confirmed
compromises, readiness, and final shared summaries. It must never contain raw
private messages, detailed emotion data, or verbatim private interpretations.
Inferred common ground is always labeled `llm_inferred`; insufficient evidence is
represented explicitly instead of fabricating agreement.

## 7. Visual endpoints disabled

API-23 and API-27 authenticate their documented caller first, then return:

```http
HTTP/1.1 409 Conflict
Cache-Control: no-store
Content-Type: application/json
```

```json
{
  "error": {
    "code": "FEATURE_DISABLED",
    "message": "Visual affect analysis is disabled for this product version.",
    "retryable": false,
    "issues": [],
    "userMessageId": null,
    "retryAfterMs": null
  },
  "requestId": "uuid"
}
```

They do not parse or persist visual payloads and do not call an inference model.
Keeping the routes satisfies compatibility; it does not enable visual processing.

## 8. Retention and privacy

- Private messages are readable only by their participant owner plus authorized
  backend/LLM processing for that mediation session.
- Each private message expires 24 hours after `createdAt`; room deletion cascades
  earlier. Cleanup is enforced in the database and by a scheduled maintenance job.
- Shared outputs use the allowlist in section 6. Detailed emotion values stay
  backend-only. Raw audio and visual frames are never stored.
