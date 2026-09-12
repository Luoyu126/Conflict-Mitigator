"use client";
import type { Consents } from "@/contracts/rooms";

export const EMPTY_CONSENTS: Consents = { transcription: false, visualAffect: false, voiceAffect: false, structuredSharing: false };
export const CONSENT_OPTIONS: { key: keyof Consents; label: string }[] = [
  { key: "transcription", label: "Allow live transcription of my microphone" },
  { key: "visualAffect", label: "Allow Face++ analysis of my camera expressions" },
  { key: "voiceAffect", label: "Allow Hume analysis of my voice" },
  { key: "structuredSharing", label: "Allow structured sharing from private mediation (never raw messages)" },
];
export default function ConsentOptions({ value, onChange, disabled = false }: {
  value: Consents; onChange: (key: keyof Consents, value: boolean) => void; disabled?: boolean;
}) {
  return <fieldset className="cm-consents" disabled={disabled}>
    <legend>Choose what you share</legend>
    {CONSENT_OPTIONS.map(({ key, label }) => <label key={key}>
      <input type="checkbox" checked={value[key]} onChange={event => onChange(key, event.target.checked)} />
      <span>{label}</span>
    </label>)}
    <p>Camera and microphone controls are separate. You can change these choices during the meeting.</p>
    <details><summary>How analysis uses your data</summary><p>With your consent, camera samples are sent to Face++ and microphone audio to Hume. Browser speech recognition may use your browser provider’s speech service. Final meeting transcripts and authorized auxiliary observations are processed by the configured meeting model provider (SiliconFlow or Google Gemini). Private mediation uses Google Gemini. This application does not store raw camera images or audio. Providers process data under their own terms; this application does not control provider retention. Derived emotion results are retained for up to 24 hours, visible only to you and authorized backend analysis, and hidden from other participants. Scores are model estimates, not a measure of your inner feelings. Analysis pauses in private mediation.</p></details>
  </fieldset>;
}
