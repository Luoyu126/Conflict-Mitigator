import { notFound } from "next/navigation";
import type { MindMapData, MindMapNode, TranscriptData } from "@/contracts/mind-map";
import mindMapMock from "../../_fixtures/mind-map.json";
import transcriptMock from "../../_fixtures/transcript.json";
import MediationRoom from "./_components/mediation-room";

type MediationPageProps = {
  params: Promise<{ roomId: string; nodeId: string }>;
  searchParams: Promise<{
    fromReplay?: string | string[];
    triggerAt?: string | string[];
    resumeAt?: string | string[];
  }>;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MediationPage({
  params,
  searchParams,
}: MediationPageProps) {
  const { roomId, nodeId } = await params;
  const query = await searchParams;
  const mindMap = mindMapMock as MindMapData;
  const transcript = transcriptMock as TranscriptData;
  const snapshotNode = mindMap.nodes.find((candidate) => candidate.id === nodeId);

  if (!snapshotNode) notFound();

  const fromReplay = firstValue(query.fromReplay) === "1";
  const triggerAtValue = Number(firstValue(query.triggerAt));
  const resumeAtValue = Number(firstValue(query.resumeAt));
  const triggerAt = fromReplay && Number.isFinite(triggerAtValue)
    ? triggerAtValue
    : undefined;
  const resumeAt = fromReplay && Number.isFinite(resumeAtValue)
    ? resumeAtValue
    : undefined;
  const node = triggerAt === undefined
    ? snapshotNode
    : transcript.mindMapEvents.reduce<MindMapNode>((current, event) => {
        if (event.nodeId !== nodeId || event.atMs > triggerAt) return current;
        return { ...current, ...event.patch };
      }, { ...snapshotNode });

  return (
    <MediationRoom
      roomId={roomId}
      nodeId={node.id}
      topic={node.topic}
      summary={node.summary ?? "This topic needs further clarification."}
      initialContention={node.contentionScore}
      initialReadiness={node.readinessScore ?? 0.35}
      discussionLoopCount={node.discussionLoopCount}
      fromReplay={fromReplay}
      triggerAt={triggerAt}
      resumeAt={resumeAt}
    />
  );
}
