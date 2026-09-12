import { z } from "zod";
import type { AffectObservation } from "./affect";
import type { MediationSession, MindMapNode, ObserverStatus, ParticipantNodeState, Room, TranscriptSegment } from "./rooms";

export const workerStatusRequestSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(["starting", "ready", "degraded", "stopped"]),
  audio: z.enum(["disabled", "starting", "ready", "error"]),
  video: z.enum(["disabled", "starting", "ready", "error"]),
  meetingAgent: z.enum(["disabled", "starting", "ready", "error"]),
  mediaCleanupCompleted: z.boolean().optional(),
}).strict();
export type WorkerStatusRequest = z.infer<typeof workerStatusRequestSchema>;
export type WorkerLeaseData = { runId: string; leaseExpiresAt: string; observer: ObserverStatus };

export type WorkerParticipant = {
  id: string;
  livekitIdentity: string | null;
  transcriptionConsent: boolean;
  visualAffectConsent: boolean;
  voiceAffectConsent: boolean;
  structuredSharingConsent: boolean;
  consentRevision: number;
  mediaIsolated: boolean;
};
export type IsolationTarget = { participantId: string; livekitIdentity: string; revokeBeforeUnixSec: number };
export type IsolationPlan = { sessionId: string; targets: IsolationTarget[] };
export type WorkerContext = {
  room: Room;
  mapVersion: number;
  recentAffectObservations?: AffectObservation[];
  participants: WorkerParticipant[];
  nodes: MindMapNode[];
  participantStates: ParticipantNodeState[];
  pendingTranscripts: TranscriptSegment[];
  hasMorePendingTranscripts: boolean;
  pendingIsolations: IsolationPlan[];
  mediaCleanupTargets: IsolationTarget[];
  deleteMediaRoom: boolean;
};

export const nodeUpsertSchema = z.object({
  id: z.string().uuid(),
  parentNodeId: z.string().uuid().nullable(),
  topic: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4000).nullable(),
  contentionScore: z.number().min(0).max(1),
  discussionLoopCount: z.number().int().min(0),
  participantStates: z.array(z.object({
    participantId: z.string().uuid(),
    position: z.string().trim().min(1).max(1000).nullable(),
    supportingReasons: z.array(z.string().trim().min(1).max(1000)).max(20),
    underlyingConcerns: z.array(z.string().trim().min(1).max(1000)).max(20),
    emotionIntensity: z.number().min(0).max(1).nullable(),
    viewOfOthers: z.array(z.object({
      participantId: z.string().uuid(),
      interpretation: z.string().trim().min(1).max(1000),
    })).max(11),
    acceptableCompromises: z.array(z.string().trim().min(1).max(1000)).max(20),
    evidenceTranscriptIds: z.array(z.string().uuid()).max(100),
    affectObservationIds: z.array(z.string().uuid()).max(30).default([]),
  })).max(12),
});
export type NodeUpsert = z.infer<typeof nodeUpsertSchema>;
export const meetingAnalysisRequestSchema = z.object({
  analysisId: z.string().uuid(),
  baseMapVersion: z.number().int().min(0),
  sourceTranscriptRevisions: z.record(z.string().uuid(), z.number().int().min(1)).optional(),
  sourceTranscriptIds: z.array(z.string().uuid()).min(1).max(100),
  nodeUpserts: z.array(nodeUpsertSchema).max(50),
}).strict();
export type MeetingAnalysisRequest = z.infer<typeof meetingAnalysisRequestSchema>;
export type MeetingAnalysisData = {
  analysisId: string;
  mapVersion: number;
  updatedNodeIds: string[];
  processedTranscriptIds: string[];
  duplicate: boolean;
};

export const transcriptIngestRequestSchema = z.object({
  segmentId: z.string().uuid(),
  participantIdentity: z.string().trim().min(1).max(64),
  trackSid: z.string().trim().min(1).max(64),
  streamId: z.string().uuid(),
  content: z.string().trim().min(1).max(8000),
  isFinal: z.literal(true),
  revision: z.number().int().min(1),
  startedAtMs: z.number().int().min(0).nullable(),
  endedAtMs: z.number().int().min(0).nullable(),
  language: z.string().trim().min(1).max(35).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  receivedAt: z.string().datetime(),
  timeBasis: z.enum(["receiver_estimate", "unknown"]),
  consentRevision: z.number().int().min(1),
}).strict();
export type TranscriptIngestRequest = z.infer<typeof transcriptIngestRequestSchema>;
export type TranscriptAcceptedData = { segment: TranscriptSegment; duplicate: boolean; analysisRequired: boolean };

export const isolationAckRequestSchema = z.object({
  sessionId: z.string().uuid(),
  results: z.array(z.object({
    participantId: z.string().uuid(),
    revokeBeforeUnixSec: z.number().int().min(0),
    succeeded: z.boolean(),
    errorCode: z.string().trim().min(1).max(100).nullable(),
  })).min(1).max(12),
}).strict();
export type IsolationAckRequest = z.infer<typeof isolationAckRequestSchema>;
export type IsolationAckData = { session: MediationSession; node: MindMapNode };
