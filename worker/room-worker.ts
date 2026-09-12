import { randomUUID } from "node:crypto";
import type { WorkerContext, WorkerParticipant, WorkerStatusRequest, TranscriptIngestRequest, MeetingAnalysisRequest } from "../contracts/worker.ts";
import type { AffectResult, FrameMetadata } from "../contracts/affect.ts";
import { TRANSCRIPT_DATA_TOPIC } from "../contracts/transcript-packet.ts";
import { normalizeTranscriptIngestion } from "../lib/worker/transcript-ingestion.ts";
import { createHumeStream, type HumeStreamOptions, type HumeStream } from "../lib/integrations/hume.ts";
import { analyzeMeeting, type MeetingAnalysisInput, type MeetingAnalysisOutput } from "../lib/agents/meeting-agent.ts";
import { generateMeetingJson } from "../lib/integrations/meeting-model.ts";
import { WorkerHttpError, type WorkerTransport } from "./http.ts";
import { bounded, wait, type WorkerMedia, type MediaAdmin, type Publication, type CameraFrame } from "./media-types.ts";

export type AnalyzerInput = MeetingAnalysisInput & Pick<WorkerContext, "recentAffectObservations">;
export type RoomWorkerOptions = {
  roomId: string; runId: string; transport: WorkerTransport; media: WorkerMedia; admin: MediaAdmin;
  analyze?: (input: AnalyzerInput, signal: AbortSignal) => Promise<MeetingAnalysisOutput>;
  voice?: (options: HumeStreamOptions) => HumeStream;
  log?: (message: string) => void;
  timings?: { controlMs?: number; heartbeatMs?: number; staleMs?: number; cameraMs?: number; watchMs?: number };
};
type StreamState = { controller: AbortController; revision: number; identity: string; task: Promise<void> };

/** A single running request plus one replaceable latest value. Never queue camera frames or affect results. */
export class LatestOnly<T> {
  private latest: T | undefined;
  private running: Promise<void> | undefined;
  private lastStarted = 0;
  private process: (value: T) => Promise<void>;
  private signal: AbortSignal;
  private intervalMs: number;
  constructor(process: (value: T) => Promise<void>, signal: AbortSignal, intervalMs = 0) {
    this.process = process; this.signal = signal; this.intervalMs = intervalMs;
    signal.addEventListener("abort", () => { this.latest = undefined; }, { once: true });
  }
  offer(value: T): void {
    if (this.signal.aborted) return;
    this.latest = value;
    if (!this.running) this.running = this.drain().finally(() => { this.running = undefined; });
  }
  private async drain() {
    while (this.latest !== undefined && !this.signal.aborted) {
      await wait(Math.max(0, this.intervalMs - (Date.now() - this.lastStarted)), this.signal);
      if (this.signal.aborted) break;
      const value = this.latest; this.latest = undefined;
      if (value === undefined) continue;
      this.lastStarted = Date.now();
      try { await this.process(value); } catch { /* Next frame can recover; caller reports safe status. */ }
    }
  }
  async done(): Promise<void> { await this.running; }
}

export class RoomWorker {
  private stopController = new AbortController();
  private contextValue: WorkerContext | undefined;
  private contextAt = 0;
  private leaseExpiresAt = 0;
  private connected = false;
  private streams = new Map<string, StreamState>();
  private retryAt = new Map<string, number>();
  private transcriptQueue: TranscriptIngestRequest[] = [];
  private ingestTask: Promise<void> | undefined;
  private analysisTask: Promise<void> | undefined;
  private analysisController: AbortController | undefined;
  private analysisContext: WorkerContext | undefined;
  private statusState: WorkerStatusRequest;
  private controlBusy = false;
  private failures = new Set<"audio" | "video" | "meetingAgent">();
  private shuttingDown: Promise<void> | undefined;
  private options: RoomWorkerOptions;
  constructor(options: RoomWorkerOptions) {
    this.options = options;
    this.statusState = { runId: options.runId, status: "starting", audio: "starting", video: "starting", meetingAgent: "starting" };
    options.media.onChange(() => this.reconcile());
    options.media.onData((payload, identity, reliable, topic) => this.receiveTranscript(payload, identity, reliable, topic));
  }
  get signal() { return this.stopController.signal; }
  private log(message: string) { this.options.log?.(message); }
  private timing(key: keyof NonNullable<RoomWorkerOptions["timings"]>, fallback: number) { return this.options.timings?.[key] ?? fallback; }
  private fresh(): boolean {
    return !this.signal.aborted && Date.now() < this.leaseExpiresAt && Date.now() - this.contextAt <= this.timing("staleMs", 2500);
  }
  private member(identity: string): WorkerParticipant | undefined {
    if (!this.fresh() || this.contextValue?.room.status !== "meeting") return;
    return this.contextValue.participants.find(p => p.id === identity && p.livekitIdentity === identity && !p.mediaIsolated);
  }
  private permits(publication: Publication, revision?: number): boolean {
    const member = this.member(publication.identity);
    return Boolean(member && (revision === undefined || member.consentRevision === revision) && !publication.muted &&
      (publication.source === "camera" ? member.visualAffectConsent : publication.source === "microphone" && member.voiceAffectConsent));
  }
  private live(publication: Publication, revision: number): boolean {
    const current = this.options.media.publications().find(p => p.sid === publication.sid && p.identity === publication.identity);
    return Boolean(current && current.subscribed && this.permits(current, revision));
  }
  private async heartbeat(cleanup = false): Promise<void> {
    if (this.contextValue) {
      const active = this.contextValue.room.status === "meeting";
      const audio = active && this.contextValue.participants.some(p => !p.mediaIsolated && (p.transcriptionConsent || p.voiceAffectConsent));
      const video = active && this.contextValue.participants.some(p => !p.mediaIsolated && p.visualAffectConsent);
      this.statusState = { ...this.statusState, status: this.failures.size || !this.fresh() ? "degraded" : "ready",
        audio: !audio ? "disabled" : this.failures.has("audio") ? "error" : "ready",
        video: !video ? "disabled" : this.failures.has("video") ? "error" : "ready",
        meetingAgent: !active ? "disabled" : this.failures.has("meetingAgent") ? "error" : "ready" };
    }
    const lease = await this.options.transport.status({ ...this.statusState, ...(cleanup ? { mediaCleanupCompleted: true } : {}) }, this.signal);
    this.leaseExpiresAt = Date.parse(lease.leaseExpiresAt);
  }
  async run(): Promise<void> {
    try {
      await this.heartbeat();
      const background = Promise.all([this.loop("heartbeatMs", 10_000, () => this.heartbeat()),
        this.loop("watchMs", 250, async () => this.reconcile())]);
      try { await this.control(); await this.loop("controlMs", 1000, () => this.control()); }
      finally { this.stopController.abort(); await background; }
    } finally { await this.stop(); }
  }
  private async loop(key: "controlMs" | "heartbeatMs" | "watchMs", interval: number, operation: () => Promise<void>): Promise<void> {
    while (!this.signal.aborted) {
      await wait(this.timing(key, interval), this.signal);
      if (this.signal.aborted) break;
      try { await operation(); }
      catch (error) {
        if (this.signal.aborted) break;
        this.contextAt = 0; this.reconcile();
        this.log("Worker control or lease request failed; media analysis paused.");
        if (error instanceof WorkerHttpError && [401, 403, 404, 409].includes(error.status)) { this.stopController.abort(); break; }
      }
    }
  }
  /** Sole owner of context -> external effects -> acknowledgement ordering. */
  async control(): Promise<void> {
    if (this.controlBusy || this.signal.aborted) return;
    this.controlBusy = true;
    try {
      const context = await this.options.transport.context(this.signal);
      this.contextValue = context; this.contextAt = Date.now();
      this.reconcile();
      await this.executeControlTasks(context);
      if (this.signal.aborted) return;
      if (this.connected && !this.options.media.isConnected()) this.connected = false;
      if (!this.connected && context.room.status !== "ended" && context.participants.length) {
        await this.options.media.connect(this.signal); this.connected = true;
      }
      this.reconcile();
      this.maybeAnalyze();

    } finally { this.controlBusy = false; }
  }
  private async executeControlTasks(context: WorkerContext) {
    const removed = new Map<string, boolean>();
    const remove = async (identity: string, cutoff: number) => {
      const key = `${identity}:${cutoff}`;
      if (removed.has(key)) return removed.get(key)!;
      let success = false;
      try { await this.options.admin.remove(identity, cutoff, this.signal); success = true; }
      catch { this.log("LiveKit removal failed; durable cleanup remains pending."); }
      removed.set(key, success); return success;
    };
    for (const plan of context.pendingIsolations) {
      const results = [];
      for (const target of plan.targets) results.push({ participantId: target.participantId, revokeBeforeUnixSec: target.revokeBeforeUnixSec,
        succeeded: await remove(target.livekitIdentity, target.revokeBeforeUnixSec), errorCode: null as string | null });
      for (const result of results) if (!result.succeeded) result.errorCode = "MEDIA_REMOVE_FAILED";
      if (results.length && !this.signal.aborted) {
        try { await this.options.transport.post("mediation-isolation", { sessionId: plan.sessionId, results }, this.signal); }
        catch { this.log("Isolation acknowledgement deferred until the next control snapshot."); }
      }
    }
    let allCleanup = true;
    for (const target of context.mediaCleanupTargets) {
      if (!await remove(target.livekitIdentity, target.revokeBeforeUnixSec)) allCleanup = false;
    }
    if (context.deleteMediaRoom) {
      try { await this.options.admin.deleteRoom(this.signal); }
      catch { allCleanup = false; this.log("LiveKit room deletion remains pending."); }
    }
    if (allCleanup && (context.mediaCleanupTargets.length || context.deleteMediaRoom) && !this.signal.aborted) await this.heartbeat(true);
  }
  private reconcile(): void {
    if (this.analysisController && !this.analysisValid(this.analysisContext!)) this.analysisController.abort();
    const publications = this.options.media.publications();
    for (const [sid, state] of this.streams) {
      const pub = publications.find(p => p.sid === sid && p.identity === state.identity);
      if (!pub || !this.permits(pub, state.revision) || !pub.subscribed) state.controller.abort();
    }
    for (const pub of publications) {
      const allowed = this.permits(pub);
      if (!allowed) {
        if (pub.subscribed) pub.subscribe(false);
        continue;
      }
      if (!pub.subscribed) { pub.subscribe(true); continue; }
      if (this.streams.has(pub.sid) || Date.now() < (this.retryAt.get(pub.sid) ?? 0)) continue;
      const member = this.member(pub.identity)!;
      const controller = new AbortController();
      const abort = () => controller.abort(); this.signal.addEventListener("abort", abort, { once: true });
      const task = (pub.source === "camera" ? this.camera(pub, member.consentRevision, controller) : this.voice(pub, member.consentRevision, controller))
        .catch(() => { if (!controller.signal.aborted) this.log("A media analysis stream stopped; retry scheduled."); })
        .finally(() => { controller.abort(); this.signal.removeEventListener("abort", abort); this.streams.delete(pub.sid); this.retryAt.set(pub.sid, Date.now() + 2000); });
      this.streams.set(pub.sid, { controller, revision: member.consentRevision, identity: pub.identity, task });
    }
  }
  private async voice(pub: Publication, revision: number, controller: AbortController) {
    const streamId = randomUUID();
    const provider = new AbortController();
    const providerSignal = AbortSignal.any([controller.signal, provider.signal]);
    const epoch = Date.parse(this.contextValue?.room.mediaEpochAt ?? "");
    let lastFrameRoomMs: number | null = null;
    const outbox = new LatestOnly<{ result: Omit<AffectResult, "observationId">; sampledAtMs: number | null; observationId: string }>(async observation => {
      if (!this.live(pub, revision)) return;
      const { result, sampledAtMs, observationId } = observation;
      // Freeze receiver-relative timing when the provider callback arrives, before any upload queue delay.
      const metadata = { observationId, roomId: this.options.roomId, participantIdentity: pub.identity, trackSid: pub.sid,
        streamId, sampledAtMs, consentRevision: revision };
      await this.options.transport.post("affect-observations", { source: "voice", metadata, result: { ...result, observationId } }, controller.signal);
    }, controller.signal);
    const stream = (this.options.voice ?? createHumeStream)({ sampleRate: 24_000, signal: providerSignal,
      onResult: result => {
        if (result.status === "ok") this.failures.delete("audio");
        outbox.offer({ result, sampledAtMs: lastFrameRoomMs, observationId: randomUUID() });
      }, onError: () => { this.failures.add("audio"); this.log("Voice provider unavailable; stream will reconnect after backoff."); provider.abort(); } });
    try {
      await this.options.media.audio(pub, providerSignal, frame => {
        if (!this.live(pub, revision)) { controller.abort(); return; }
        if (Number.isFinite(epoch)) lastFrameRoomMs = Math.max(0, Date.now() - epoch);
        stream.write(frame);
      });
    } finally { stream.close(); await outbox.done(); controller.abort(); }
  }
  private async camera(pub: Publication, revision: number, controller: AbortController) {
    const streamId = randomUUID();
    const epoch = Date.parse(this.contextValue?.room.mediaEpochAt ?? "");
    let firstSdk: bigint | undefined, anchor: number | undefined;
    const latest = new LatestOnly<CameraFrame>(async frame => {
      if (!this.live(pub, revision) || !Number.isFinite(epoch)) return;
      const sdk = BigInt(frame.timestampUs);
      if (firstSdk === undefined) { firstSdk = sdk; anchor = Math.max(0, frame.receivedAt - epoch); }
      if (sdk < firstSdk) { controller.abort(); return; }
      const sampledAtMs = Math.round(anchor! + Number(sdk - firstSdk) / 1000);
      // Reject clock discontinuity instead of silently re-anchoring the same stream.
      if (Math.abs(sampledAtMs - (frame.receivedAt - epoch)) > 2500) { controller.abort(); return; }
      const encoded = await frame.encode();
      if (!this.live(pub, revision) || controller.signal.aborted) return;
      const metadata: FrameMetadata = { observationId: randomUUID(), roomId: this.options.roomId, participantIdentity: pub.identity,
        trackSid: pub.sid, streamId, sampledAtMs, consentRevision: revision, sdkTimestampUs: frame.timestampUs,
        width: encoded.width, height: encoded.height, rotationApplied: true };
      const result = await this.options.transport.infer(metadata, encoded.jpeg, controller.signal).catch(error => {
        if (!controller.signal.aborted) this.failures.add("video"); throw error;
      });
      this.failures.delete("video");
      if (this.live(pub, revision) && !controller.signal.aborted) await this.options.transport.post("affect-observations", { source: "visual", metadata, result }, controller.signal);
    }, controller.signal, this.timing("cameraMs", 1200));
    try { await this.options.media.video(pub, controller.signal, frame => {
      if (!this.live(pub, revision)) { controller.abort(); return; }
      latest.offer(frame);
    }); }
    finally { controller.abort(); await latest.done(); }
  }
  private receiveTranscript(payload: Uint8Array, identity: string | undefined, reliable: boolean, topic: string | undefined): void {
    if (!reliable || topic !== TRANSCRIPT_DATA_TOPIC || !identity || payload.byteLength > 32 * 1024 || this.transcriptQueue.length >= 32) return;
    const member = this.member(identity);
    if (!member?.transcriptionConsent) return;
    const mic = this.options.media.publications().find(p => p.identity === identity && p.source === "microphone" && !p.muted && /^TR_[A-Za-z0-9_-]+$/.test(p.sid));
    if (!mic) return;
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); } catch { return; }
    const parsed = normalizeTranscriptIngestion({ roomId: this.options.roomId, senderIdentity: identity, trackSid: mic.sid, receivedAt: new Date().toISOString(), payload: decoded });
    if (!parsed.ok || parsed.request.consentRevision !== member.consentRevision) return;
    this.transcriptQueue.push(parsed.request);
    if (!this.ingestTask) this.ingestTask = this.ingest().finally(() => { this.ingestTask = undefined; });
  }
  private transcriptAllowed(item: TranscriptIngestRequest) {
    const member = this.member(item.participantIdentity);
    return member?.transcriptionConsent && member.consentRevision === item.consentRevision &&
      this.options.media.publications().some(p => p.sid === item.trackSid && p.identity === item.participantIdentity && p.source === "microphone" && !p.muted);
  }
  private async ingest() {
    while (this.transcriptQueue.length && !this.signal.aborted) {
      const item = this.transcriptQueue.shift()!;
      for (let attempt = 0; attempt < 3 && this.transcriptAllowed(item); attempt++) {
        try { await this.options.transport.post("transcripts", item, this.signal); break; }
        catch (error) {
          if (error instanceof WorkerHttpError && error.status < 500) break;
          await wait(250 * 2 ** attempt, this.signal);
        }
      }
    }
  }
  private analysisValid(snapshot: WorkerContext): boolean {
    const current = this.contextValue;
    if (!this.fresh() || !current || current.room.status !== "meeting" || current.mapVersion !== snapshot.mapVersion) return false;
    return snapshot.participants.every(p => current.participants.some(c => c.id === p.id && c.consentRevision === p.consentRevision && !c.mediaIsolated)) &&
      snapshot.pendingTranscripts.every(t => current.pendingTranscripts.some(c => c.id === t.id && c.revision === t.revision));
  }
  private maybeAnalyze() {
    const context = this.contextValue;
    if (this.analysisTask || !context || !this.analysisValid(context) || !context.pendingTranscripts.length) return;
    const snapshot = structuredClone(context);
    const controller = new AbortController(); this.analysisController = controller; this.analysisContext = snapshot;
    const abort = () => controller.abort(); this.signal.addEventListener("abort", abort, { once: true });
    this.analysisTask = this.analyze(snapshot, controller).catch(() => { if (this.analysisValid(snapshot)) { this.failures.add("meetingAgent"); this.log("Meeting analysis failed; it remains pending for retry."); } })
      .finally(() => { controller.abort(); this.signal.removeEventListener("abort", abort); this.analysisController = undefined; this.analysisContext = undefined; this.analysisTask = undefined; });
  }
  private async analyze(snapshot: WorkerContext, controller: AbortController) {
    const input: AnalyzerInput = { mediaEpochAt: snapshot.room.mediaEpochAt, nodes: snapshot.nodes, participantStates: snapshot.participantStates,
      pendingTranscripts: snapshot.pendingTranscripts, recentAffectObservations: snapshot.recentAffectObservations };
    const analyze = this.options.analyze ?? ((value, signal) => analyzeMeeting(value, prompt => generateMeetingJson(prompt, { signal })));
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const output = await bounded(analyze(input, controller.signal), controller.signal, 25_000);
      if (!this.analysisValid(snapshot) || controller.signal.aborted) return;
      // Evidence must be explicitly selected by the model and belong to its speaker.
      for (const node of output.nodeUpserts) {
        if (!node.participantStates.length) throw new Error("Meeting node lacks transcript evidence.");
        for (const state of node.participantStates) {
        if (!state.evidenceTranscriptIds.length || state.evidenceTranscriptIds.some(id => !snapshot.pendingTranscripts.some(t => t.id === id && t.participantId === state.participantId))) {
          throw new Error("Meeting analysis has invalid transcript evidence.");
        }
        }
      }
      const body: MeetingAnalysisRequest = { analysisId: randomUUID(), baseMapVersion: snapshot.mapVersion,
        sourceTranscriptIds: snapshot.pendingTranscripts.map(t => t.id),
        sourceTranscriptRevisions: Object.fromEntries(snapshot.pendingTranscripts.map(t => [t.id, t.revision])), nodeUpserts: output.nodeUpserts };
      await this.options.transport.post("meeting-analysis", body, controller.signal);
      this.failures.delete("meetingAgent");
    } finally { clearTimeout(timeout); }
  }
  async stop(): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    this.shuttingDown = (async () => {
      this.stopController.abort(); this.contextAt = 0; this.transcriptQueue = [];
      this.analysisController?.abort();
      for (const state of this.streams.values()) state.controller.abort();
      for (const pub of this.options.media.publications()) if (pub.subscribed) pub.subscribe(false);
      const shutdown = new AbortController();
      await Promise.allSettled([bounded(this.options.media.close(), shutdown.signal),
        ...[...this.streams.values()].map(state => bounded(state.task, shutdown.signal)),
        ...(this.analysisTask ? [bounded(this.analysisTask, shutdown.signal)] : []),
        ...(this.ingestTask ? [bounded(this.ingestTask, shutdown.signal)] : []),
        this.options.transport.status({ ...this.statusState, status: "stopped", audio: "disabled", video: "disabled", meetingAgent: "disabled" }, AbortSignal.timeout(5000)),
      ]);
    })();
    return this.shuttingDown;
  }
}
