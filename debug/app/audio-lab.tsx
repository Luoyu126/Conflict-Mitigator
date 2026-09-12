"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import {
  LiveKitRoom, RoomAudioRenderer, StartAudio, ControlBar,
  useParticipants, useIsSpeaking, useIsMuted, useParticipantTracks, VideoTrack,
} from "@livekit/components-react";
import { AudioPresets, VideoPresets, Track, type Participant, type RoomOptions } from "livekit-client";
import Metrics from "./metrics";
import FaceAnalysis from "./face-analysis";

type Session = {
  serverUrl: string; participantToken: string; roomName: string; identity: string;
  options: RoomOptions;
};

function ParticipantCard({ participant }: { participant: Participant }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [overlayTarget, setOverlayTarget] = useState<HTMLDivElement | null>(null);
  const [mirrored, setMirrored] = useState(false);
  const speaking = useIsSpeaking(participant);
  const muted = useIsMuted({ participant, source: Track.Source.Microphone });
  const cameras = useParticipantTracks([Track.Source.Camera], participant.identity);
  const cameraMuted = useIsMuted({ participant, source: Track.Source.Camera });
  const microphones = useParticipantTracks([Track.Source.Microphone], participant.identity);
  return <div className={`participant ${speaking ? "speaking" : ""}`}>
    <div className="camera-screen">
    {cameras[0] && !cameraMuted ? <VideoTrack ref={videoRef} trackRef={cameras[0]} style={{ transform: mirrored ? "scaleX(-1)" : "none" }} /> : <div className="camera-placeholder">摄像头关闭</div>}
    {participant.isLocal && <div className="camera-vad-slot" ref={setOverlayTarget} />}
    </div>
    <strong>{participant.name || "参与者"}{participant.isLocal ? "（你）" : ""}</strong>
    <button type="button" aria-pressed={mirrored} onClick={() => setMirrored((value) => !value)}
      title="仅镜像你看到的画面，不改变发送的视频">画面镜像：{mirrored ? "开" : "关"}</button>
    <span>{muted || microphones.length === 0 ? "麦克风关闭" : speaking ? "正在说话" : "麦克风开启"}</span>
    {participant.isLocal && cameras[0] && !cameraMuted && <FaceAnalysis key={cameras[0].publication.trackSid} videoRef={videoRef} overlayTarget={overlayTarget} />}
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
  const onMediaDeviceFailure = useCallback(() => setError("无法使用麦克风或摄像头，请检查浏览器权限、设备占用及设备选择。"), []);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (joining.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setError("摄像头和麦克风需要安全上下文，请通过 http://localhost:3001 打开测试页。"); return;
    }
    joining.current = true; setBusy(true); setError(""); setNotice("");
    setConnectionMs(null); connected.current = false; started.current = performance.now();
    const values = new FormData(event.currentTarget);
    const processed = values.get("profile") === "speech";
    const videoPreset = values.get("resolution") === "360" ? VideoPresets.h360 : VideoPresets.h720;
    try {
      const response = await fetch("/api/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: values.get("room"), name: values.get("name") }),
        cache: "no-store", signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法加入测试房间。");
      setSession({ ...data, options: {
        videoCaptureDefaults: { resolution: videoPreset.resolution },
        audioCaptureDefaults: {
          echoCancellation: processed, noiseSuppression: processed,
          autoGainControl: processed, channelCount: 1,
        },
        publishDefaults: {
          videoCodec: "vp8", videoEncoding: videoPreset.encoding, simulcast: true,
          audioPreset: values.get("bitrate") === "high" ? AudioPresets.musicHighQuality : AudioPresets.speech,
        },
      } });
    } catch (error) {
      setError(error instanceof Error ? error.message : "入会失败，请重试。");
    } finally { joining.current = false; setBusy(false); }
  }

  return <main>
    <header><p className="eyebrow">LOCAL DEBUG · LIVEKIT REACT</p><h1>音视频实验室</h1>
      <p>进入同一个测试房间，比较摄像头画面、实时交谈的延迟和音质。</p>
    </header>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    {!session ? <form className="panel" onSubmit={join}>
      <h2>加入音视频测试</h2>
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
      <label>视频预设<select name="resolution" defaultValue="720"><option value="720">720p · 30 fps</option><option value="360">360p · 20 fps（低带宽对比）</option></select></label>
      </div>
      <p className="muted">各设备填写相同房间名。加入后手动开启摄像头或麦克风，按钮旁菜单可选择设备。音视频经 LiveKit Cloud 传输，本应用不录制。表情分析需入会后另行同意开启。</p>
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
        <button onClick={() => { setSession(null); setNotice("已退出测试，摄像头和麦克风轨道将释放。"); }}>退出 / 取消连接</button>
      </div>
      <Participants />
      <RoomAudioRenderer />
      <StartAudio label="点击开启声音播放" />
      <ControlBar controls={{ microphone: true, camera: true, screenShare: false, chat: false, leave: false }} />
      <Metrics connectionMs={connectionMs} />
    </LiveKitRoom>}
    <section className="panel instructions"><h2>怎么测试画面延迟</h2>
      <p>打开两个窗口，用不同名字加入同一房间。在 A 开摄像头，B 保持设备关闭并观看 A 的远端画面。本机预览不经过网络，不能用于判断传输延迟。</p>
      <p>让 A 的摄像头拍摄一个毫秒秒表；用手机同时拍下原始秒表和 B 收到的画面，暂停照片或录像后比较两个读数。重复多次。这是包含采集、编码、网络、解码和显示的近似端到端延迟，不需要两台电脑时钟同步。</p>
      <p>对比 720p 和 360p 时退出后重进。帧率、缓冲和 RTT 只作为定位卡顿的辅助指标，不能相加当成端到端延迟。</p>
      <h2>语音对比</h2>
      <ol><li>两台电脑各自运行 debug 应用，打开 localhost:3001，使用同一 LiveKit 项目和房间名。使用耳机，避免同屋扬声器形成回声。</li>
        <li>双方开启麦克风，轮流读同一段话，再尝试快速问答、同时说话、轻声和较大音量，留意吞字、金属音及音量变化。</li>
        <li>退出后每次只改一项设置：先比较音频处理，再比较编码预设。浏览器实际执行的处理以统计面板为准。</li>
        <li>RTT 只能辅助判断网络。测真正的嘴到耳延迟，需要让独立录音设备同时录到原始短促声音和远端播放声音，比较两个波形的时间差；不同电脑未同步的时钟不能直接相减。</li></ol>
      <p className="muted">只有自己一个人时不会回放自己的声音。临时身份不关联正式用户；本页面不验证正式业务鉴权、调解隔离或 AI 功能。</p>
    </section>
  </main>;
}
