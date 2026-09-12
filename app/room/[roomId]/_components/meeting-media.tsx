"use client";
import { useCallback, useEffect, useState } from "react";
import { VideoTrack, useTracks } from "@livekit/components-react";
import { ConnectionState, Track } from "livekit-client";
import { useMeetingAudio } from "@/hooks/use-meeting-audio";
import { useMeetingCamera } from "@/hooks/use-meeting-camera";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useTranscriptPublisher } from "@/hooks/use-transcript-publisher";
import { apiRequest } from "@/lib/api/client";
import AffectVadPlot from "@/components/shared/affect-vad-plot";
import { AFFECT_FRESH_MS, type MyAffectData } from "@/contracts/affect";
import { useApiPoll } from "@/app/_components/use-api-poll";
import { MeetingWorkspace, type LiveMeetingView } from "./live-meeting";
import styles from "./mind-map-workspace.module.css";

function MyAffect({ view }: { view: LiveMeetingView }) {
  const { room, me } = view.room;
  const [observations, setObservations] = useState<MyAffectData["observations"]>([]);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  useApiPoll(async signal => {
    try {
      const response = await apiRequest<MyAffectData>(`/api/rooms/${room.id}/me/affect`, { signal });
      if (!signal.aborted) { setObservations(response.data.observations); setError(""); setNow(Date.now()); }
    } catch { if (!signal.aborted) { setObservations([]); setError("Your analysis results are currently unavailable."); setNow(Date.now()); } }
  }, `${room.id}:${me.consentRevision}`);
  return <section className="cm-affect" aria-label="Your private emotion results"><h3>Your signals · only you</h3>
    <p>These estimates are available to you and backend mediation analysis. Other participants cannot see your scores.</p>
    {error && <p role="status">{error}</p>}
    {(["visual", "voice"] as const).map(source => {
      const consent = source === "visual" ? me.consents.visualAffect : me.consents.voiceAffect;
      const observation = observations.filter(item => item.source === source && item.participantId === me.participant.id && item.consentRevision === me.consentRevision)
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0];
      const sampledAt = observation?.sampledAtMs != null && room.mediaEpochAt ? Date.parse(room.mediaEpochAt) + observation.sampledAtMs : observation ? Date.parse(observation.receivedAt) : 0;
      const fresh = observation && now - sampledAt >= 0 && now - sampledAt <= AFFECT_FRESH_MS && Date.parse(observation.expiresAt) > now;
      const available = consent && fresh && observation.result.status === "ok";
      return <div key={source}><h4>{source === "visual" ? "Camera expression" : "Voice expression"}</h4>
        <p>{!consent ? "Analysis off" : !observation ? "Waiting for an observation…" : !fresh ? "Stale · waiting for a new observation" : observation.result.status !== "ok" ? "Analysis unavailable" : "Recent model estimate"}</p>
        {consent && <AffectVadPlot point={available ? observation.result.vad : null} label={source === "visual" ? "Camera expression" : "Voice expression"} />}
        {available && <>{observation.result.scores.map(score => <div key={score.name} className="cm-score"><span>{score.name}</span><span>{source === "voice" ? (score.score * 100).toFixed(1) : score.score.toFixed(1)}%</span></div>)}</>}
      </div>;
    })}
  </section>;
}
export default function MeetingMedia({ view }: { view: LiveMeetingView }) {
  const audio = useMeetingAudio(); const camera = useMeetingCamera();
  const tracks = useTracks([Track.Source.Camera]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("");
  const listening = view.room.me.consents.transcription && audio.isMicrophoneEnabled && audio.connectionState === ConnectionState.Connected;
  const publisher = useTranscriptPublisher({ consentRevision: view.room.me.consentRevision, enabled: listening, language: transcriptionLanguage });
  const speech = useSpeechRecognition({ enabled: listening, audioTrack: audio.localAudioTrack?.mediaStreamTrack, language: transcriptionLanguage, onFinal: publisher.publishFinal });
  const refreshDevices = useCallback(async () => {
    try { if (navigator.mediaDevices?.enumerateDevices) setDevices(await navigator.mediaDevices.enumerateDevices()); }
    catch { setError("Device names could not be read."); }
  }, []);
  useEffect(() => {
    let stopped = false;
    const refresh = () => { if (!stopped) void refreshDevices(); };
    const timer = setTimeout(refresh, 0);
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => { stopped = true; clearTimeout(timer); navigator.mediaDevices?.removeEventListener("devicechange", refresh); };
  }, [refreshDevices]);
  async function change(operation: () => Promise<unknown>) {
    if (busy) return; setBusy(true); setError("");
    try { await operation(); await refreshDevices(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not change the media device."); }
    finally { setBusy(false); }
  }
  const participants = <>{view.room.participants.filter(p => p.status === "active").map(participant => {
    const video = tracks.find(track => track.participant.identity === participant.livekitIdentity && !track.publication.isMuted);
    return <div className="cm-participant-tile" key={participant.id}>
      {video ? <VideoTrack trackRef={video} /> : <div className="cm-participant-avatar">{participant.displayName.slice(0, 2)}</div>}
      <strong>{participant.displayName}{participant.id === view.room.me.participant.id ? " (you)" : ""}</strong>
      <small>{video ? "Camera on" : "Camera off"}</small>
    </div>;
  })}<div className="cm-self-controls">
    {(error || publisher.error) && <p className="cm-error" role="alert">{error || publisher.error}</p>}
    <p role="status">Transcription: {speech.status === "unsupported" ? "Unavailable in this browser" : speech.status === "error" ? "Unavailable · toggle microphone to retry" : speech.status}</p>
    <label>Transcription language<select className="cm-device-select" value={transcriptionLanguage} onChange={e => setTranscriptionLanguage(e.target.value)}>
      <option value="">Browser language</option>
      <option value="zh-CN">Chinese (Mandarin)</option>
      <option value="en-US">English (US)</option>
    </select></label>
    <p>Pause before switching languages. Completed sentences appear in the transcript.</p>
    <details><summary>Microphone & camera devices</summary>
      <label>Microphone<select className="cm-device-select" defaultValue="" disabled={busy} onChange={e => void change(() => audio.selectMicrophone(e.target.value))}><option value="" disabled>Select microphone</option>{devices.filter(d => d.kind === "audioinput").map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}</select></label>
      <label>Camera<select className="cm-device-select" defaultValue="" disabled={busy} onChange={e => void change(() => camera.selectCamera(e.target.value))}><option value="" disabled>Select camera</option>{devices.filter(d => d.kind === "videoinput").map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}</select></label>
    </details>{view.consentPanel}<MyAffect view={view} />
  </div></>;
  const controls = <><div className={styles.controlGroup}>
    <button disabled={busy || audio.connectionState !== ConnectionState.Connected} aria-pressed={audio.isMicrophoneEnabled} onClick={() => void change(() => audio.setMicrophoneEnabled(!audio.isMicrophoneEnabled))}><span>♩</span>{audio.isMicrophoneEnabled ? "Mute" : "Unmute"}</button>
    <button disabled={busy || camera.connectionState !== ConnectionState.Connected} aria-pressed={camera.isCameraEnabled} onClick={() => void change(() => camera.setCameraEnabled(!camera.isCameraEnabled))}><span>▰</span>{camera.isCameraEnabled ? "Stop Video" : "Start Video"}</button>
  </div><div className={styles.controlGroupCenter}><span>Participants {view.room.participants.filter(p => p.status === "active").length}</span>
    {view.room.me.participant.role === "host" && <button disabled={view.busy} onClick={view.onEnd}>End meeting for everyone</button>}
  </div><button className={styles.leaveButton} disabled={view.busy} onClick={view.onLeave}>Leave</button></>;
  return <MeetingWorkspace view={view} participants={participants} controls={controls} />;
}
