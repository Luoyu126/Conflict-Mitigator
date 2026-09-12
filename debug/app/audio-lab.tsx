"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import {
  LiveKitRoom, RoomAudioRenderer, StartAudio, ControlBar,
  useParticipants, useIsSpeaking, useIsMuted, useParticipantTracks,
} from "@livekit/components-react";
import { AudioPresets, Track, type Participant, type RoomOptions } from "livekit-client";
import Metrics from "./metrics";

type Session = {
  serverUrl: string; participantToken: string; roomName: string; identity: string;
  options: RoomOptions;
};

function ParticipantCard({ participant }: { participant: Participant }) {
  const speaking = useIsSpeaking(participant);
  const muted = useIsMuted({ participant, source: Track.Source.Microphone });
  const microphones = useParticipantTracks([Track.Source.Microphone], participant.identity);
  return <div className={`participant ${speaking ? "speaking" : ""}`}>
    <strong>{participant.name || "参与者"}{participant.isLocal ? "（你）" : ""}</strong>
    <span>{muted || microphones.length === 0 ? "麦克风关闭" : speaking ? "正在说话" : "麦克风开启"}</span>
  </div>;
}

function Participants() {
  const participants = useParticipants();
  return <section className="panel"><h2>参会者 · {participants.length}</h2>
    <div className="participants">{participants.map((p) => <ParticipantCard key={p.identity} participant={p} />)}</div>
  </section>;
}

export default function AudioLab() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connectionMs, setConnectionMs] = useState<number | null>(null);
  const started = useRef(0);
  const connected = useRef(false);
  const joining = useRef(false);
  const onConnected = useCallback(() => {
    if (!connected.current) { connected.current = true; setConnectionMs(Math.round(performance.now() - started.current)); }
  }, []);
  const onDisconnected = useCallback(() => { setSession(null); setNotice("已断开会议连接。"); }, []);
  const onError = useCallback(() => setError("LiveKit 连接或设备操作失败，请检查网络与项目配置；可以退出后重试。"), []);
  const onMediaDeviceFailure = useCallback(() => setError("无法使用麦克风，请检查浏览器权限、设备是否被占用以及麦克风选择。"), []);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (joining.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setError("麦克风需要安全上下文，请通过 http://localhost:3001 打开测试页。"); return;
    }
    joining.current = true; setBusy(true); setError(""); setNotice("");
    setConnectionMs(null); connected.current = false; started.current = performance.now();
    const values = new FormData(event.currentTarget);
    const processed = values.get("profile") === "speech";
    try {
      const response = await fetch("/api/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: values.get("room"), name: values.get("name") }),
        cache: "no-store", signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法加入测试房间。");
      setSession({ ...data, options: {
        audioCaptureDefaults: {
          echoCancellation: processed, noiseSuppression: processed,
          autoGainControl: processed, channelCount: 1,
        },
        publishDefaults: {
          audioPreset: values.get("bitrate") === "high" ? AudioPresets.musicHighQuality : AudioPresets.speech,
        },
      } });
    } catch (error) {
      setError(error instanceof Error ? error.message : "入会失败，请重试。");
    } finally { joining.current = false; setBusy(false); }
  }

  return <main>
    <header><p className="eyebrow">LOCAL DEBUG · LIVEKIT REACT</p><h1>音频实验室</h1>
      <p>进入同一个测试房间，比较实时交谈的延迟、清晰度和音色。</p>
    </header>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    {!session ? <form className="panel" onSubmit={join}>
      <h2>加入语音测试</h2>
      <div className="form-grid">
        <label>房间名<input name="room" required maxLength={48} pattern="[a-zA-Z0-9_-]+" defaultValue="voice-test" /></label>
        <label>你的名字<input name="name" required maxLength={40} placeholder="例如：小陈 / 电脑 B" /></label>
        <label>音频处理<select name="profile" defaultValue="speech">
          <option value="speech">通话处理：回声消除、降噪、自动增益</option>
          <option value="raw">原声对比：请求关闭三项处理（戴耳机）</option>
        </select></label>
        <label>编码预设<select name="bitrate" defaultValue="speech">
          <option value="speech">Speech · 语音码率</option>
          <option value="high">Music high quality · 较高码率</option>
        </select></label>
      </div>
      <p className="muted">各设备填写相同房间名。加入后点击麦克风按钮再开口；只有你开启麦克风后才发布声音。测试音频经 LiveKit Cloud 传输，本应用不录音、不转写。</p>
      <button className="primary" disabled={busy}>{busy ? "正在准备…" : "加入测试房间"}</button>
    </form> : <LiveKitRoom
      key={session.identity} serverUrl={session.serverUrl} token={session.participantToken}
      options={session.options} connect audio={false} video={false}
      onConnected={onConnected}
      onDisconnected={onDisconnected}
      onError={onError}
      onMediaDeviceFailure={onMediaDeviceFailure}
      data-lk-theme="default"
    >
      <div className="room-heading"><p>房间：<strong>{session.roomName}</strong></p>
        <button onClick={() => { setSession(null); setNotice("已退出测试，麦克风轨道将释放。"); }}>退出 / 取消连接</button>
      </div>
      <Participants />
      <RoomAudioRenderer />
      <StartAudio label="点击开启声音播放" />
      <ControlBar controls={{ microphone: true, camera: false, screenShare: false, chat: false, leave: false }} />
      <Metrics connectionMs={connectionMs} />
    </LiveKitRoom>}
    <section className="panel instructions"><h2>怎么听、怎么比较</h2>
      <ol><li>两台电脑各自运行 debug 应用，打开 localhost:3001，使用同一 LiveKit 项目和房间名。使用耳机，避免同屋扬声器形成回声。</li>
        <li>双方开启麦克风，轮流读同一段话，再尝试快速问答、同时说话、轻声和较大音量，留意吞字、金属音及音量变化。</li>
        <li>退出后每次只改一项设置：先比较音频处理，再比较编码预设。浏览器实际执行的处理以统计面板为准。</li>
        <li>RTT 只能辅助判断网络。测真正的嘴到耳延迟，需要让独立录音设备同时录到原始短促声音和远端播放声音，比较两个波形的时间差；不同电脑未同步的时钟不能直接相减。</li></ol>
      <p className="muted">只有自己一个人时不会回放自己的声音。临时身份不关联正式用户；本页面不验证正式业务鉴权、调解隔离或 AI 功能。</p>
    </section>
  </main>;
}
