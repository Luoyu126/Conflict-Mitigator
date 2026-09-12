import { z } from "zod";
import type { MindMapNode, ParticipantNodeState, TranscriptSegment } from "../../contracts/rooms.ts";
import { nodeUpsertSchema, type NodeUpsert } from "../../contracts/worker.ts";
import { generateJson, type JsonModel } from "../integrations/gemini.ts";

export type MeetingAnalysisInput = {
  nodes: Pick<MindMapNode, "id" | "topic" | "contentionScore" | "discussionLoopCount" | "status">[];
  participantStates: ParticipantNodeState[];
  pendingTranscripts: Pick<TranscriptSegment, "id" | "participantId" | "content">[];
};
export type MeetingAnalysisOutput = { nodeUpserts: NodeUpsert[] };

/**
 * Runs the meeting-structure analysis (Gemini) and returns semantic node upserts.
 * Evidence transcript IDs are intentionally left empty; the worker assigns them
 * deterministically from speaker attribution so the model never fabricates evidence.
 */
export async function analyzeMeeting(
  input: MeetingAnalysisInput,
  generate: JsonModel = (prompt) => generateJson(prompt),
): Promise<MeetingAnalysisOutput> {
  const prompt = `You are a meeting-structure analyzer for a conflict-aware meeting tool.
Given final transcript segments and the current discussion map, produce a JSON object with a single key "nodeUpserts" (array).
Each element describes a discussion node and each participant's structured state:
{
  "id": "<uuid or existing node id>",
  "parentNodeId": null,
  "topic": "short topic",
  "summary": null,
  "contentionScore": 0..1,
  "discussionLoopCount": 0,
  "participantStates": [
    {
      "participantId": "<participant id>",
      "position": null or "what they want",
      "supportingReasons": [],
      "underlyingConcerns": [],
      "emotionIntensity": null,
      "viewOfOthers": [],
      "acceptableCompromises": [],
      "evidenceTranscriptIds": []
    }
  ]
}
Only derive positions, reasons, concerns and compromises that are actually expressed. Never invent agreement or diagnose emotion.
Do not include a node status field. Keep participantId values exactly as given in the input.

Input JSON: ${JSON.stringify(input)}`;

  const result = await generate(prompt);
  const parsed = z.object({ nodeUpserts: z.array(nodeUpsertSchema).max(50) }).safeParse(result);
  if (!parsed.success) throw new Error("Meeting analysis response failed validation.");
  return { nodeUpserts: parsed.data.nodeUpserts };
}
