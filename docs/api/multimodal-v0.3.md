# Multimodal integration contract · v0.3

This implements the user's September 12 migration decisions and supersedes the
audio-only/disabled-vision provisions of v0.2. Existing fields and state transitions
remain governed by frontend-api.md, internal-api.md and interact-api.md.

## Consent and media

`Consents.visualAffect` is a boolean again. `Consents.voiceAffect` is an additional
boolean, defaulting to false when omitted by an older caller. Transcription,
camera analysis, voice analysis and structured sharing are independent purposes.
Device permission or joining a call never implies analysis consent. Join and
consent PATCH return the full consent object. Any actual change increments the
single consentRevision; stale or future revisions cannot submit observations.

Participant tokens permit microphone and camera publication, subscription and the
documented final-transcript data topic. They never grant screen sharing, metadata
updates or administration. Devices start disabled. The shared LiveKit connection
owns devices: emotion analysis consumes its tracks rather than opening a second
browser microphone. Private mediation stops public media and both analysis paths.

## Trusted processing

A long-running Node Worker connects to each business room with a server-created
observer identity. It obtains API-20/21 leases/control, trusts SDK sender identity
and publication track SID, and checks consent and isolation before processing.
It polls control every second and renews its 30-second lease every 10 seconds.
Browser-final STT remains the sole public transcript source. Hume transcription
events supply emotion observations only; they are never added to API-22.

Visual processing uses sampled camera frames and the API-27 inference adapter,
then API-23. Voice processing streams the subscribed microphone frames to Hume
with server-held credentials and submits voice observations to API-23. Provider
calls use bounded buffering, timeouts and cancellation. No raw audio or image is
stored by this application. Provider configuration and retention must be described
in the analysis notice; provider failure reports unavailable, never calmness.

## Observation compatibility and ownership

API-23 keeps its existing `{metadata,result}` visual payload. It additionally
accepts `source: "visual" | "voice"` (omitted means visual). Voice metadata uses
the same observationId, roomId, participantIdentity, trackSid, streamId,
sampledAtMs and consentRevision; image-specific metadata is not required for voice.
Both modes require the current Worker run and active lease. The result retains
status, intensity, confidence, reason, model and inferenceMs; optional `scores`
and `vad` supply the original modality-specific model scores and labeled
experimental display projection. Voice inferenceMs is null when provider latency is unknown;
visual inferenceMs remains an integer. VAD is not a calibrated measurement and cannot
be copied to contentionScore or averaged across modalities.

Every observation is bound to one room, participant, track, stream and consent
revision. Conflicting reuse of observationId fails; exact retries are idempotent.
Only active public participants with current source consent can produce results.
Store derived observations for at most 24 hours; delete earlier with the room.
Display freshness is six seconds, separately from retention. Unknown/stale values
are explicit and cannot stand in for present emotion.

API-28 adds `GET /api/rooms/{roomId}/me/affect`: authenticated active membership,
no participant-id query parameter. Returns the standard `{data,requestId}`
envelope with `data.observations`, up to the latest 24 per modality, filtered to
the caller and current consent revision. Withdrawal hides those results from new
reads and excludes them from further analysis. Responses use no-store.

Observation DTO: `id, roomId, participantId, source, trackSid, streamId,
consentRevision, sampledAtMs, receivedAt, expiresAt, result`. The provider result
includes scores and VAD only for the owner and authorized backend. No personal
scores, detailed emotion labels or observation bodies enter room Realtime events,
public participant projections or shared consensus trees. Worker context may
include current, consent-valid observations for analysis. Other users' private
agents receive only the existing safe public projection.

API-24 additionally accepts sourceTranscriptRevisions (UUID-to-revision map);
the production Worker always supplies it and stale revisions return
409 TRANSCRIPT_REVISION_CONFLICT before writes.

Backend meeting analysis may use valid emotion evidence alongside final public
transcripts from the same speaker/time window. It must not manufacture a topic or
trigger mediation from a score alone. The contention threshold and unanimous
entry/resume decisions remain unchanged. Emotion processing during private chat
is disabled; private chat uses its existing text model flow.

## Transition and maintenance invariants

All room mutations lock room before session/member state. Isolation targets have
a fixed persisted revocation cutoff. Acknowledgements must match that target and
cannot reopen a terminal session. Participant removal/room deletion are durable
tasks, acknowledged only after successful LiveKit calls. New tokens remain blocked
while isolated, cleanup is pending or their not-before cutoff is in the future.
Worker maintenance runs every two seconds, closes expired proposals and cancels
isolation that remains starting for 30 seconds, preserving pending cleanup. It
deletes expired messages/results;
application queries also enforce expiry when maintenance is delayed.
