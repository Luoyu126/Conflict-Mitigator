"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { EmotionObservation } from "../../lib/emotions";
import { appendVadTrail, projectVoiceVad, VAD_FRESH_MS, VAD_TRAIL_MS, VOICE_VAD_ANCHORS, VOICE_VAD_VERSION, type VadSample } from "../../lib/vad";
import VadPlot from "../vad-plot";

const labels: Record<string, string> = {
  Admiration: "钦佩", Adoration: "爱慕", "Aesthetic Appreciation": "审美欣赏", Amusement: "愉悦",
  Anger: "愤怒", Anxiety: "焦虑", Awe: "敬畏", Awkwardness: "局促", Boredom: "无聊",
  Calmness: "平静", Concentration: "专注", Confusion: "困惑", Contemplation: "沉思", Contempt: "轻蔑",
  Contentment: "安适", Craving: "渴求", Desire: "欲望", Determination: "决心", Disappointment: "失望",
  Disgust: "厌恶", Distress: "苦恼", Doubt: "疑虑", Ecstasy: "狂喜", Embarrassment: "窘迫",
  "Empathic Pain": "共情痛苦", Entrancement: "入迷", Envy: "嫉妒", Excitement: "兴奋", Fear: "害怕",
  Guilt: "内疚", Horror: "惊恐", Interest: "兴趣", Joy: "喜悦", Love: "爱", Nostalgia: "怀旧",
  Pain: "痛苦", Pride: "自豪", Realization: "恍然大悟", Relief: "释然", Romance: "浪漫",
  Sadness: "悲伤", Satisfaction: "满意", Shame: "羞耻", "Surprise (negative)": "负向惊讶",
  "Surprise (positive)": "正向惊讶", Sympathy: "同情", Tiredness: "疲倦", Triumph: "胜利感",
};

export default function EmotionPage() {
  const [phase, setPhase] = useState<"idle" | "connecting" | "listening">("idle");
  const [notice, setNotice] = useState("尚未开始。点击按钮后才会使用麦克风和发送音频。");
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<EmotionObservation | null>(null);
  const [history, setHistory] = useState<EmotionObservation[]>([]);
  const [level, setLevel] = useState(0);
  const [received, setReceived] = useState(0);
  const [vad, setVad] = useState<{ point: ReturnType<typeof projectVoiceVad>; at: number; trail: VadSample[] } | null>(null);
  const [now, setNow] = useState(0);
  const generation = useRef(0);
  const cleanup = useRef<() => void>(() => {});

  function stop() {
    generation.current++; cleanup.current(); cleanup.current = () => {};
    setPhase("idle"); setLevel(0); setNotice("已停止，麦克风已释放。上次结果保留在页面中。");
  }
  useEffect(() => () => { generation.current++; cleanup.current(); }, []);
  useEffect(() => {
    if (phase !== "listening") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [phase]);

  async function start() {
    if (phase !== "idle") return;
    const run = ++generation.current;
    setPhase("connecting"); setError(""); setLatest(null); setHistory([]); setReceived(0); setVad(null);
    setNotice("正在请求麦克风并连接 Hume…");
    let stream: MediaStream | undefined; let context: AudioContext | undefined;
    let socket: WebSocket | undefined; let source: MediaStreamAudioSourceNode | undefined;
    let capture: AudioWorkletNode | undefined; let timeout: ReturnType<typeof setTimeout> | undefined;
    let noResult: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      clearTimeout(timeout); clearTimeout(noResult);
      if (capture) { capture.port.onmessage = null; capture.disconnect(); }
      source?.disconnect(); stream?.getTracks().forEach(track => track.stop());
      if (context && context.state !== "closed") void context.close();
      if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close(); }
    };
    cleanup.current = dispose;
    const fail = (message: string) => {
      if (generation.current !== run) return;
      generation.current++; dispose(); setPhase("idle"); setLevel(0); setError(message);
      setNotice("分析已停止。可检查后重新开始。");
    };
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error("请使用支持 AudioWorklet 的浏览器，通过 localhost 打开页面。");
      // Resume within the click gesture; capture is connected only after Hume is ready.
      context = new AudioContext({ sampleRate: 24000 });
      await context.resume();
      if (generation.current !== run) { dispose(); return; }
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      }, video: false });
      if (generation.current !== run) { dispose(); return; }
      stream.getAudioTracks()[0].onended = () => fail("麦克风已断开，请重新选择设备后开始。");
      await context.audioWorklet.addModule("/pcm-worklet.js");
      if (generation.current !== run) { dispose(); return; }
      source = context.createMediaStreamSource(stream);
      capture = new AudioWorkletNode(context, "pcm-capture", { channelCount: 1, channelCountMode: "explicit" });
      socket = new WebSocket("ws://127.0.0.1:3002/evi");
      timeout = setTimeout(() => fail("连接 Hume 超时。请确认本地转发服务及网络正常。"), 15000);
      socket.onopen = () => socket?.send(JSON.stringify({ type: "start", sampleRate: context!.sampleRate }));
      socket.onerror = () => fail("无法连接本地分析服务，请用 npm --prefix debug run dev 启动完整测试环境。");
      socket.onclose = () => fail("分析连接已断开，请重新开始。");
      capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (generation.current !== run || socket?.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 256000) { fail("网络发送积压，分析已停止。请检查网络后重试。"); return; }
        const samples = new Int16Array(event.data);
        let power = 0; for (const value of samples) power += (value / 32768) ** 2;
        setLevel(Math.min(1, Math.sqrt(power / samples.length) * 5));
        socket.send(event.data);
      };
      socket.onmessage = event => {
        if (generation.current !== run) return;
        const data = JSON.parse(event.data);
        if (data.type === "error") { fail(data.message); return; }
        if (data.type === "ready") {
          clearTimeout(timeout); setPhase("listening"); setNotice("正在监听。请说完整句子，稍作停顿，结果会随 Hume 事件更新。");
          source!.connect(capture!); capture!.connect(context!.destination);
          noResult = setTimeout(() => {
            if (generation.current === run) setNotice("尚未收到识别结果。请确认音量条有变化，并尝试说一句英文；结果速度取决于 Hume。" );
          }, 20000);
        }
        if (data.type === "observation") {
          clearTimeout(noResult); const observation = data as EmotionObservation;
          setLatest(observation); setReceived(value => value + 1);
          setNotice(observation.scores.length ? "已收到声音情绪分数。" : "已收到转写，但本条消息没有情绪分数。");
          if (!observation.interim) setHistory(value => [observation, ...value].slice(0, 20));
          // Final audio segments are observations; provisional transcripts are not new VAD samples.
          if (!observation.interim) {
            const at = Date.now(); const point = projectVoiceVad(observation.scores);
            setNow(at);
            setVad(previous => ({ point, at, trail: appendVadTrail(previous?.trail ?? [], point, at) }));
          }
        }
      };
    } catch (reason) {
      dispose();
      fail(reason instanceof DOMException && reason.name === "NotAllowedError" ? "麦克风权限未获允许，请在浏览器中开启后重试。" : "无法启动麦克风分析，请检查设备和浏览器支持情况。");
    }
  }

  const stale = vad != null && now - vad.at > VAD_FRESH_MS;
  const point = phase === "listening" && !stale ? vad?.point ?? null : null;
  const vadStatus = phase !== "listening" ? "分析未开启" : stale ? "上次片段已过期，等待新语音结果"
    : !vad ? "等待带有情绪分数的完整语音片段" : "情绪分数缺失或无效，无法获得三维坐标";

  return <main>
    <header><p className="eyebrow">LOCAL DEBUG · HUME EVI</p><h1>实时语音情绪测试</h1>
      <p>说一句话，观察声音中表现出的情绪。无需加入 LiveKit 房间。建议先用英文测试；中文效果尚未验证。</p>
      <Link href="/">← 返回音视频实验室</Link>
    </header>
    <section className="panel">
      <p>点击开始即同意将本次麦克风音频发送给 Hume EVI，按 EVI 实际用量计费。EVI 会处理转写、情绪并可能生成回复；本页只显示你的识别结果，不播放 AI 回复。本应用不保存音频或转写到文件、数据库。Hume 端的数据留存遵循其账户设置与政策。</p>
      <div className="room-heading">
        <button className="primary" disabled={phase !== "idle"} onClick={() => void start()}>开始语音情绪测试</button>
        <button disabled={phase === "idle"} onClick={stop}>停止分析</button>
      </div>
      <p role="status">{notice}</p>{error && <p className="error" role="alert">{error}</p>}
      <label>麦克风输入音量 <meter min={0} max={1} value={level} style={{ width: "100%" }} /></label>
      <p className="muted">每轮最多 5 分钟。音频持续发送，情绪随识别片段更新，并非每帧都有结果。收到 {received} 条结果。</p>
    </section>
    <section className="panel"><h2>当前结果</h2>
      <VadPlot inline point={point} trail={point ? vad!.trail.filter(p => now - p.at <= VAD_TRAIL_MS) : []}
        status={vadStatus} anchors={VOICE_VAD_ANCHORS} names={labels} version={VOICE_VAD_VERSION}
        source="Hume" freshness="收到完整语音片段超过 6 秒" />
      <p className="muted">三维图使用完整语音片段；正负倾向、激活程度、掌控感沿用 video 的坐标约定。有效期从浏览器收到片段起算，不代表当前瞬间的情绪。</p>
      <p>{latest?.text || "等待你说话…"} {latest && <small>（{latest.interim ? "识别中" : "完整片段"}）</small>}</p>
      {latest && <p className="muted">收到时间：{new Date(latest.receivedAt).toLocaleTimeString()} · 片段：{latest.startMs ?? "未知"}–{latest.endMs ?? "未知"} ms</p>}
      {latest?.scores.length ? <>
        <details style={{ marginTop: 20 }}><summary>查看全部 {latest.scores.length} 个原始情绪字段</summary>
          <div className="table-scroll"><table><thead><tr><th>情绪</th><th>API 字段</th><th>分数</th></tr></thead>
            <tbody>{latest.scores.map(({ name, score }) => <tr key={name}><td>{labels[name] || name}</td><td>{name}</td><td>{score.toFixed(4)}</td></tr>)}</tbody></table></div>
        </details>
      </> : <p className="muted">尚无情绪分数；无结果不代表平静。</p>}
      <p className="muted">分数反映模型识别到的声音表达，不是人的真实心理状态、百分比或节点争议强度。</p>
    </section>
    <section className="panel"><h2>最近完整片段（最多 20 条）</h2>
      {history.length === 0 ? <p className="muted">说完一句话后，完整结果会出现在这里。</p> : history.map((item, index) =>
        <div key={`${item.receivedAt}-${index}`} style={{ borderBottom: "1px solid #344150", padding: "12px 0" }}>
          <small>{new Date(item.receivedAt).toLocaleTimeString()}</small><p>{item.text}</p>
          <p>{item.scores.slice(0, 3).map(({ name, score }) => `${labels[name] || name} ${score.toFixed(3)}`).join(" · ") || "未返回情绪分数"}</p>
        </div>)}
    </section>
  </main>;
}
