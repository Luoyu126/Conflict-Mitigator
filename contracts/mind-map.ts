export type NodeStatus =
  | "normal"
  | "heated"
  | "private_mediation"
  | "ready_to_resume";

export type MindMapNode = {
  id: string;
  roomId: string;
  parentNodeId: string | null;
  topic: string;
  summary: string | null;
  status: NodeStatus;
  contentionScore: number;
  readinessScore: number | null;
  discussionLoopCount: number;
  sourceSegmentIds?: string[];
};

export type MindMapData = {
  mockMeta: {
    source: string;
    generatedFor: string;
    snapshotAtMs: number;
    statusTransitionsAreSynthetic: boolean;
    notes: string;
  };
  roomId: string;
  updatedAt: string;
  nodes: MindMapNode[];
};

export type TranscriptParticipant = {
  id: string;
  displayName: string;
};

export type TranscriptSegment = {
  id: string;
  roomId: string;
  participantId: string;
  speaker: string;
  content: string;
  startedAtMs: number;
  endedAtMs: number;
  isFinal: boolean;
  sourceParagraph: number;
  timestampUnavailable?: boolean;
};

export type MindMapEvent = {
  atMs: number;
  operation: "upsert" | "update";
  nodeId: string;
  demoOnly?: boolean;
  patch: Partial<Omit<MindMapNode, "id" | "roomId">>;
};

export type TranscriptData = {
  mockMeta: {
    source: string;
    durationMs: number;
    timingMode: string;
    contentMode: string;
    statusTransitionsAreSynthetic: boolean;
    notes: string;
  };
  roomId: string;
  participants: TranscriptParticipant[];
  transcriptSegments: TranscriptSegment[];
  mindMapEvents: MindMapEvent[];
};
