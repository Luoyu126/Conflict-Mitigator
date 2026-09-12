import { z } from "zod";
import type { ParticipantNodeState, PublicParticipantNodeState } from "../../contracts/rooms.ts";
import { generateJson, type JsonModel } from "../integrations/gemini.ts";

export type PrivateMediationInput = {
  nodeTopic: string;
  selfState: ParticipantNodeState | null;
  others: PublicParticipantNodeState[];
  history: { role: "user" | "assistant"; content: string }[];
  userMessage: string;
};

const structuredSchema = z.object({
  position: z.string().trim().min(1).max(1000).nullable(),
  supportingReasons: z.array(z.string().trim().min(1).max(1000)).max(20),
  underlyingConcerns: z.array(z.string().trim().min(1).max(1000)).max(20),
  acceptableCompromises: z.array(z.string().trim().min(1).max(1000)).max(20),
});
const replySchema = z.object({ reply: z.string().trim().min(1).max(2000), structured: structuredSchema }).strict();
export type PrivateMediationOutput = z.infer<typeof replySchema>;

/**
 * Private mediator (Gemini). Only the participant's own message, node context and
 * others' public structured states are sent. The reply stays private; the structured
 * extraction is the only content eligible to become shared.
 */
export async function generatePrivateReply(
  input: PrivateMediationInput,
  generate: JsonModel = (prompt) => generateJson(prompt),
): Promise<PrivateMediationOutput> {
  const prompt = `You are a private meeting mediator helping one participant clarify their view before rejoining the group.
Be empathetic, neutral, and do not take sides or diagnose emotion. Reply in 2-3 sentences.
Then extract the participant's structured state (position, supportingReasons, underlyingConcerns, acceptableCompromises) that is safe to share with the team. Never echo the raw private message.
Return JSON only: {"reply": "...", "structured": {"position": null or "...", "supportingReasons": [], "underlyingConcerns": [], "acceptableCompromises": []}}.
Node topic: ${input.nodeTopic}
Others' public states: ${JSON.stringify(input.others)}
History: ${JSON.stringify(input.history)}
Private message: ${JSON.stringify(input.userMessage)}`;

  const result = await generate(prompt);
  const parsed = replySchema.safeParse(result);
  if (!parsed.success) throw new Error("Private mediation response failed validation.");
  return parsed.data;
}
