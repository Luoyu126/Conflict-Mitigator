import { z } from "zod";
import type {
  MediationSession, MindMapNode, ParticipantNodeState, PublicParticipantNodeState, RoomStatus,
} from "./rooms";

// --- Shared consensus tree (docs/api/decision-overrides-v0.2.md §6) ---
export type ConsensusTreeKind =
  | "surface_conflict" | "participant_view" | "inferred_common_ground" | "open_question";
export type EpistemicStatus =
  | "shared_statement" | "participant_confirmed" | "llm_inferred" | "insufficient_evidence";
export type ConsensusTreeNode = {
  id: string;
  kind: ConsensusTreeKind;
  label: string;
  participantId: string | null;
  epistemicStatus: EpistemicStatus;
};
export type ConsensusTreeEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: "supports" | "conflicts_with" | "underlies" | "clarifies";
};
export type ConsensusTree = {
  version: number;
  generatedAt: string;
  nodes: ConsensusTreeNode[];
  edges: ConsensusTreeEdge[];
};

export type SessionData = { session: MediationSession; node: MindMapNode; roomStatus: RoomStatus };
export type MediationMeData = {
  session: MediationSession;
  node: MindMapNode;
  selfState: ParticipantNodeState | null;
  others: PublicParticipantNodeState[];
  chatAllowed: boolean;
  canAcceptResume: boolean;
  navigationPath: string;
  consensusTree: ConsensusTree | null;
};

export type PrivateMessage = {
  id: string;
  mediationSessionId: string;
  participantId: string;
  role: "user" | "assistant";
  content: string;
  clientMessageId: string | null;
  replyToMessageId: string | null;
  replyStatus: "pending" | "completed" | "failed" | null;
  createdAt: string;
};
export type PrivateMessagePage = {
  items: PrivateMessage[];
  pageInfo: { nextBeforeCursor: string | null; hasMore: boolean };
};
export type ChatCompletedData = {
  userMessage: PrivateMessage;
  assistantMessage: PrivateMessage;
  selfState: ParticipantNodeState;
  node: MindMapNode;
  session: MediationSession;
  consensusTreeVersion: number;
};
export type ChatPendingData = {
  userMessage: PrivateMessage;
  retryAfterMs: number;
  consensusTreeVersion: number;
};

export const proposeMediationRequestSchema = z.object({
  participantIds: z.array(z.string().uuid()).min(2).max(12),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict().refine((value) => new Set(value.participantIds).size === value.participantIds.length, {
  message: "participantIds must be unique.",
});
export const entryDecisionRequestSchema = z.object({
  decision: z.enum(["accept", "decline"]),
}).strict();
export const resumeRequestSchema = z.object({
  decision: z.enum(["accept", "wait"]),
  summaryVersion: z.number().int().min(1),
}).strict();
export const cancelRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();
export const sendMessageRequestSchema = z.object({
  clientMessageId: z.string().uuid(),
  content: z.string().trim().min(1).max(4000),
}).strict();
