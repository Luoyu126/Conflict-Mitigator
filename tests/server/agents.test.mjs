import test from "node:test";
import assert from "node:assert/strict";
import { synthesizeConsensusTree, synthesizeSharedSummary } from "../../lib/agents/consensus.ts";
import { analyzeMeeting } from "../../lib/agents/meeting-agent.ts";
import { generatePrivateReply } from "../../lib/agents/mediation-agent.ts";

test("consensus tree synthesizes surface conflict, participant views and shared concerns", () => {
  const node = {
    id: "00000000-0000-4000-8000-000000000001", roomId: "00000000-0000-4000-8000-000000000000",
    parentNodeId: null, topic: "What should we cut?", summary: null, status: "private_mediation",
    contentionScore: 0.8, readinessScore: null, discussionLoopCount: 2,
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
  };
  const states = [
    {
      id: "s1", nodeId: node.id, participantId: "p1", position: "Cut the camera pipeline",
      supportingReasons: [], underlyingConcerns: ["Reliability"], acceptableCompromises: [], updatedAt: "2026-09-12T00:00:00.000Z",
    },
    {
      id: "s2", nodeId: node.id, participantId: "p2", position: "Keep the map",
      supportingReasons: [], underlyingConcerns: ["Reliability", "Clarity"], acceptableCompromises: [], updatedAt: "2026-09-12T00:00:00.000Z",
    },
  ];
  const tree = synthesizeConsensusTree(node, states, 1, "2026-09-12T01:00:00.000Z");
  assert.equal(tree.version, 1);
  assert.equal(tree.nodes.some((n) => n.kind === "surface_conflict" && n.label === "What should we cut?"), true);
  assert.equal(tree.nodes.filter((n) => n.kind === "participant_view").length, 2);
  assert.equal(tree.nodes.some((n) => n.kind === "inferred_common_ground" && n.label === "Reliability"), true);
  assert.equal(tree.nodes.every((n) => !/emotion|interpretation/i.test(JSON.stringify(n))), true);
  assert.ok(tree.edges.length >= 3);
});

test("shared summary combines positions and compromises without private text", () => {
  const node = {
    id: "n", roomId: "r", parentNodeId: null, topic: "Scope", summary: null, status: "heated",
    contentionScore: 0.7, readinessScore: null, discussionLoopCount: 0, createdAt: "x", updatedAt: "x",
  };
  const states = [
    { id: "a", nodeId: "n", participantId: "p1", position: "Ship small", supportingReasons: [], underlyingConcerns: [], acceptableCompromises: ["One flow"], updatedAt: "x" },
  ];
  const summary = synthesizeSharedSummary(node, states);
  assert.match(summary, /Scope/);
  assert.match(summary, /Ship small/);
  assert.match(summary, /One flow/);
});

test("meeting agent validates and returns structured node upserts", async () => {
  const upsert = {
    id: "00000000-0000-4000-8000-000000000003", parentNodeId: null, topic: "Cut the camera?",
    summary: null, contentionScore: 0.82, discussionLoopCount: 2,
    participantStates: [{
      participantId: "00000000-0000-4000-8000-000000000011", position: "Cut it",
      supportingReasons: ["Stability"], underlyingConcerns: ["Crash risk"], emotionIntensity: null,
      viewOfOthers: [], acceptableCompromises: [], evidenceTranscriptIds: [],
    }],
  };
  const output = await analyzeMeeting({
    nodes: [], participantStates: [], pendingTranscripts: [{ id: "t1", participantId: "00000000-0000-4000-8000-000000000011", content: "The camera crashes." }],
  }, async () => ({ nodeUpserts: [upsert] }));
  assert.equal(output.nodeUpserts.length, 1);
  assert.equal(output.nodeUpserts[0].contentionScore, 0.82);
  await assert.rejects(
    analyzeMeeting({ nodes: [], participantStates: [], pendingTranscripts: [] }, async () => ({ nodeUpserts: [{ topic: 123 }] })),
    /validation/,
  );
});

test("private mediator returns a reply plus structured extraction", async () => {
  const result = await generatePrivateReply({
    nodeTopic: "Scope", selfState: null, others: [], history: [],
    userMessage: "I am worried the demo will crash.",
  }, async () => ({ reply: "That makes sense.", structured: { position: "Reduce risk", supportingReasons: [], underlyingConcerns: ["Crash risk"], acceptableCompromises: [] } }));
  assert.equal(result.reply, "That makes sense.");
  assert.equal(result.structured.underlyingConcerns[0], "Crash risk");
});

test("analysis pairs emotion evidence using original reception time rather than delayed insertion", async () => {
  const epoch = "2026-09-12T00:00:00.000Z";
  const observations = [
    { id: "matched", participantId: "p1", sampledAtMs: 1000, result: { status: "ok" } },
    { id: "too-late", participantId: "p1", sampledAtMs: 15000, result: { status: "ok" } },
    { id: "other-speaker", participantId: "p2", sampledAtMs: 1000, result: { status: "ok" } },
    { id: "unknown", participantId: "p1", sampledAtMs: null, result: { status: "ok" } },
  ];
  await analyzeMeeting({ nodes: [], participantStates: [], mediaEpochAt: epoch,
    recentAffectObservations: observations,
    pendingTranscripts: [{ id: "t1", participantId: "p1", content: "Evidence", receivedAt: "2026-09-12T00:00:01.000Z", createdAt: "2026-09-12T00:00:15.000Z" },
      { id: "t2", participantId: "p1", content: "Unknown time" }],
  }, async prompt => {
    const input = JSON.parse(prompt.split("Input JSON: ")[1]);
    assert.deepEqual(input.pendingTranscripts[0].eligibleAffectObservationIds, ["matched"]);
    assert.deepEqual(input.pendingTranscripts[1].eligibleAffectObservationIds, []);
    return { nodeUpserts: [] };
  });
});
