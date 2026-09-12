import { z } from "zod";
import type { LiveKitConnection } from "./media";

export const CONSENT_NOTICE_VERSION = "cm-privacy-v1" as const;
export const consentsSchema = z.object({
  transcription: z.boolean(),
  visualAffect: z.literal(false),
  structuredSharing: z.boolean(),
}).strict();
export const createRoomRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
}).strict();
export const joinRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  consents: consentsSchema,
  consentNoticeVersion: z.literal(CONSENT_NOTICE_VERSION),
}).strict();
export const consentPatchSchema = z.object({
  transcription: z.boolean().optional(),
  visualAffect: z.boolean().optional(),
  structuredSharing: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one consent field is required.",
});
export const emptyBodySchema = z.object({}).strict();

export type Consents = z.infer<typeof consentsSchema>;
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;
export type JoinRequest = z.infer<typeof joinRequestSchema>;
export type ConsentPatch = z.infer<typeof consentPatchSchema>;
export type RoomStatus = "lobby" | "meeting" | "mediation" | "ended";
export type ObserverStatus = {
  status: "idle" | "starting" | "ready" | "degraded" | "stopped";
  audio: "disabled" | "starting" | "ready" | "error";
  video: "disabled" | "starting" | "ready" | "error";
  meetingAgent: "disabled" | "starting" | "ready" | "error";
  lastHeartbeatAt: string | null;
};
export type Room = {
  id: string; title: string; status: RoomStatus; createdAt: string; updatedAt: string;
  mediaEpochAt: string | null; activeMediationSessionId: string | null;
  activeMediationNodeId: string | null; observer: ObserverStatus;
};
export type Participant = {
  id: string; roomId: string; displayName: string; role: "host" | "participant";
  status: "active" | "left"; livekitIdentity: string | null; joinedAt: string; leftAt: string | null;
};
export type MyParticipant = {
  participant: Participant; consents: Consents; consentRevision: number;
  consentNoticeVersion: typeof CONSENT_NOTICE_VERSION;
};
export type CreateRoomData = { room: Room; lobbyPath: string };
export type LobbyData = {
  roomId: string; title: string; status: RoomStatus; participantCount: number;
  canJoin: boolean; myParticipantId: string | null;
  consentNoticeVersion: typeof CONSENT_NOTICE_VERSION;
};
export type RoomData = { room: Room; participants: Participant[]; me: MyParticipant };
export type JoinData = { room: Room; me: MyParticipant; livekit: LiveKitConnection; navigationPath: string };
export type ConsentData = { me: MyParticipant };
export type ExitData = {
  roomId: string; roomStatus: RoomStatus; participantStatus: "active" | "left";
  mediaCleanup: "completed" | "pending"; navigationPath: "/";
};

export type TranscriptSegment = {
  id: string; roomId: string; participantId: string; content: string;
  startedAtMs: number | null; endedAtMs: number | null; isFinal: boolean; revision: number;
  streamId: string; sourceTrackSid: string; language: string | null; confidence: number | null;
  createdAt: string; updatedAt: string;
};
export type TranscriptPage = {
  items: TranscriptSegment[];
  pageInfo: { nextBeforeCursor: string | null; hasMore: boolean };
};
export type ViewOfOther = { participantId: string; interpretation: string };
export type ParticipantNodeState = {
  id: string; nodeId: string; participantId: string; position: string | null;
  supportingReasons: string[]; underlyingConcerns: string[]; emotionIntensity: number | null;
  viewOfOthers: ViewOfOther[]; acceptableCompromises: string[]; updatedAt: string;
};
export type PublicParticipantNodeState = Omit<ParticipantNodeState, "emotionIntensity" | "viewOfOthers">;
export type MindMapNode = {
  id: string; roomId: string; parentNodeId: string | null; topic: string; summary: string | null;
  status: "normal" | "heated" | "private_mediation" | "ready_to_resume";
  contentionScore: number; readinessScore: number | null; discussionLoopCount: number;
  createdAt: string; updatedAt: string;
};
export type MindMapData = { roomId: string; mapVersion: number; nodes: MindMapNode[]; participantStates: PublicParticipantNodeState[] };
export type NodeData = {
  node: MindMapNode; participantStates: PublicParticipantNodeState[];
  selfState: ParticipantNodeState | null; activeMediationSessionId: string | null;
};
export type MediationMember = {
  participantId: string; entryDecision: "pending" | "accept" | "decline";
  resumeDecision: "pending" | "accept" | "wait"; acceptedSummaryVersion: number | null;
  isolatedAt: string | null; updatedAt: string;
};
export type MediationSession = {
  id: string; roomId: string; nodeId: string;
  status: "proposed" | "starting" | "active" | "completed" | "cancelled";
  triggerReason: string | null; sharedSummary: string | null; summaryVersion: number;
  createdAt: string; expiresAt: string | null; startedAt: string | null; endedAt: string | null;
  members: MediationMember[]; transitionError: string | null;
};
export type MediationResolution = { session: MediationSession | null; isMember: boolean };
