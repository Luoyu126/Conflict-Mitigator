import { notFound } from "next/navigation";
import LiveMeeting from "./_components/live-meeting";
import type { MindMapData, TranscriptData } from "@/contracts/mind-map";
import MindMapWorkspace from "./_components/mind-map-workspace";
import mindMapMock from "./_fixtures/mind-map.json";
import transcriptMock from "./_fixtures/transcript.json";

type MeetingPageProps = {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<{
    replayAt?: string | string[];
    resume?: string | string[];
    mediated?: string | string[];
  }>;
};

export default async function MeetingPage({ params, searchParams }: MeetingPageProps) {
  const { roomId } = await params;
  if (roomId !== "demo") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomId)) notFound();
    return <LiveMeeting key={roomId} roomId={roomId} />;
  }
  const query = await searchParams;
  const replayAtValue = Array.isArray(query.replayAt)
    ? query.replayAt[0]
    : query.replayAt;
  const parsedReplayAt = replayAtValue ? Number(replayAtValue) : undefined;
  const initialReplayAt = Number.isFinite(parsedReplayAt)
    ? parsedReplayAt
    : undefined;
  const resumeValue = Array.isArray(query.resume) ? query.resume[0] : query.resume;
  const mediatedValue = Array.isArray(query.mediated)
    ? query.mediated[0]
    : query.mediated;

  return (
    <MindMapWorkspace
      roomId={roomId}
      mindMap={mindMapMock as MindMapData}
      transcript={transcriptMock as TranscriptData}
      initialReplayAt={initialReplayAt}
      autoPlayReplay={resumeValue === "1"}
      resumedNodeId={mediatedValue}
    />
  );
}
