# LiveKit 音频实验室（仅本地）

独立的临时 Next.js 应用，验证 LiveKit 官方 React 组件的多人语音、连接耗时和音质。
使用 `LiveKitRoom`、`RoomAudioRenderer`、`ControlBar`、`StartAudio` 及参与者 Hooks。
本目录是用户明确要求的实验环境，不实现或替代 `docs/api/` 的正式业务接口。
通话页不连接数据库、Supabase、STT 或 AI Worker，不录音或保存音频。
独立的 `/emotion` 页面通过 Hume EVI 分析语音，配置与使用方式见下文。

## 启动

需要 Node.js 22.18+ 或 24。另一台电脑首次使用时：

```bash
git clone --branch feat/hume-voice-emotion --single-branch https://github.com/Luoyu126/Conflict-Mitigator.git
cd Conflict-Mitigator
```

将 `debug/env.example` 复制为仓库根目录的 `.env.local`，填写实际的 LiveKit 项目地址、API Key 和 API Secret。
macOS / Linux 使用 `cp debug/env.example .env.local`；PowerShell 使用 `Copy-Item debug/env.example .env.local`。
已有 `.env.local` 时只补充缺失配置，不覆盖现有文件。实际凭证不会随 Git 上传。

然后在仓库根目录运行（仅测试应用需要安装依赖，无需启动数据库或安装主应用依赖）：

```bash
npm --prefix debug ci
npm --prefix debug run dev
```

打开 **http://localhost:3001**。正式应用仍使用原来的 `npm run dev` / 3000 端口。
测试服务器仅监听 `127.0.0.1`；退出使用 Ctrl+C。

启动器只从根目录 `.env.local` 读取 `LIVEKIT_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET` 三项，
已有进程环境变量优先。不会复制、打印密钥或将密钥注入浏览器。
地址应使用 LiveKit 项目控制台提供的 `wss://...`。改变配置后重启测试应用。

## 两人通话

1. 两台电脑各自运行该应用，各自在本机配置同一 LiveKit 项目的凭证，然后打开 localhost:3001。
   若应用运行在远程开发机，可以通过 SSH 本地转发访问：
   `ssh -N -L 3001:127.0.0.1:3001 用户@开发机`，浏览器仍打开 localhost:3001。
   第二个客户端也可以建立自己的本地转发，无需分享服务端密钥。
2. 输入相同房间名和各自姓名，点击加入。实际房间固定加 `debug-audio-` 前缀。
3. 入会默认不开麦，使用官方麦克风按钮开启；箭头菜单可选择输入设备。
   若浏览器阻止播放，点击“开启声音播放”。戴耳机，避免同屋两台扬声器产生回声。
4. 测试正常对话、抢话、静音、切换设备、退出重进及临时断网恢复。
5. 用“退出 / 取消连接”卸载连接组件，释放本地媒体。一个客户端不会自动回放自己的声音。

仅用同一个浏览器的两个标签页也能验证连接，但不能代表两台设备的真实音质和网络表现。
本地 HTTP 的 localhost 属于可用麦克风的安全上下文；不要直接将它改成普通局域网 HTTP 地址。

## 音色对比

- 通话处理：请求启用回声消除、降噪、自动增益。
- 原声对比：请求关闭上述三项，保持单声道；浏览器或硬件仍可能进行处理，并非无损原始 PCM。
- 编码预设独立选择官方 `AudioPresets.speech` 或 `AudioPresets.musicHighQuality`。
  它们是目标配置，实际码率受声音内容、网络和编码器影响。
- 每轮退出再入会，每次只改变一项，读同一段话，比较吞字、金属音、底噪、爆音、音量起伏与打断感。
  页面显示浏览器实际报告的采样率、声道和处理开关；采集采样率不等于网络编码采样率。

## 指标含义

| 指标 | 含义 |
|---|---|
| 首次连接耗时 | 从提交入会到首次 connected，包含本地 token 请求，不是语音延迟 |
| RTT | 发送端 RTCP 报告的本机到媒体服务器往返时间，不是 A 到 B 的嘴到耳延迟 |
| 抖动 | 音频包到达间隔的波动，秒换算成毫秒 |
| 码率 | SDK 当前轨道码率，kbps；静音或刚开始时可能为 0 |
| 累计丢包 | 当前流累计包计数，不是最近两秒丢包率 |
| 累计平均缓冲 | jitterBufferDelay / jitterBufferEmittedCount，接收端自统计开始的平均缓冲时间 |

每 2 秒采样一次；浏览器不提供的字段显示 `—`。可下载当前统计 JSON，不导出 token、密钥或设备 ID。
不同电脑未同步的时间戳不能直接相减测单程延迟。精确嘴到耳测试需用独立录音设备同时记录
原始短促声音与接收端输出，在波形里比较时间差；控制扬声器回声与声学距离，重复测量。

## 实验边界

临时 token 有效期 10 分钟，仅允许加入指定测试房间、发布麦克风和订阅；每次入会随机生成身份。
token 到期不等于已建立的媒体连接自动终止。该 token 接口没有正式登录，仅在启动器开启的 development 模式
且请求为本机同源时工作，不应部署或公开代理。它不测试正式会议权限、人数限制或调解隔离。
真实通话会经过 LiveKit Cloud 并产生项目用量。

## 检查

```bash
npm --prefix debug test
npm --prefix debug run typecheck
npm --prefix debug run build
npm run lint
```

自动检查覆盖 token 限权、本地请求边界和统计单位，真实延迟和主观音质仍需两位参与者实测。

官方文档：[LiveKitRoom](https://docs.livekit.io/reference/components/react/component/livekitroom/)、
[RoomAudioRenderer](https://docs.livekit.io/reference/components/react/component/roomaudiorenderer/)、
[麦克风发布](https://docs.livekit.io/transport/media/publish/)。

## Hume EVI 实时语音情绪实验

打开 **http://localhost:3001/emotion**，也可从首页顶部进入。无需加入 LiveKit 房间。
运行 `npm --prefix debug run dev` 会同时启动 Next.js（127.0.0.1:3001）和
Hume WebSocket 转发（127.0.0.1:3002）。本页使用独立麦克风采集；停止或离开页面会释放设备并断开分析。

1. 在 `debug/.env.hume.local` 配置 `HUME_API_KEY`、`HUME_CONFIG_ID`，参考 `hume-env.example`。
   此文件被 Git 忽略。当前转发使用 API key 鉴权，不使用 secret key，也不把凭证发给浏览器。
2. 点击“开始语音情绪测试”，允许麦克风。建议先说英文完整句子，再停顿一下。
3. 页面随 EVI `user_message` 事件显示转写、VAD 三维图、可展开的 48 个原始字段和最近 20 个完整片段。
4. 点击“停止分析”结束本轮；每轮最多 5 分钟。切换采集设备需先停止，再在浏览器设置中选择后重开。

音频由 AudioWorklet 转为单声道 16-bit little-endian PCM，约每 100ms 发送一次；
按 AudioContext 实际采样率配置 Hume。转发使用专用 EVI 3 配置，不向浏览器转发 AI 回复。
本次对照测试中，发送 `pause_assistant_message` 后未获得语音结果，取消暂停后获得 48 项分数；
因此当前不暂停上游生成，可能产生 AI 回复对应的 EVI 用量，但不播放或展示这些回复。
密钥只留服务端，转发限制本机来源、消息大小、连接数及发送积压。
如果通过 SSH 使用网页，需要同时转发 3001 和 3002 两个端口。

本实验会向 Hume 发送音频并产生 EVI 用量；Hume 会处理转写与情绪，其留存遵循供应商账户设置和政策。
本应用仅在内存中处理音频和结果，不写入数据库或录音文件，不修改正式 STT / 节点 API。
分数不等于真实心理状态、概率百分比或节点争议程度，缺少分数不等于平静。
EVI 可能先返回无情绪的转写事件，之后才返回带情绪的片段；页面如实显示缺失。

真实浏览器端到端联调已从公开英文音频获得并显示 48 项真实情绪分数；中文样本暂未返回结果，不能承诺中文效果。
原 Expression Measurement `/v0/stream/models` 与 `/v0/batch/jobs` 在实测中返回已停用的 403，故使用 EVI。
页面显示的是收到事件的时间和供应商片段时间，不将两者相减冒充模型推理耗时。

验证：`npm --prefix debug test`、`npm --prefix debug run typecheck`、
`npm --prefix debug run build -- --webpack`。当前环境默认 Turbopack 构建的 CSS 子进程端口受限，
webpack 构建已通过。浏览器另验证了音频发送、情绪显示和停止后轨道进入 ended 状态。

官方协议参考：[EVI 音频输入](https://github.com/HumeAI/hume-typescript-sdk/blob/main/src/api/resources/empathicVoice/types/AudioInput.ts)、
[暂停回复](https://github.com/HumeAI/hume-typescript-sdk/blob/main/src/api/resources/empathicVoice/types/PauseAssistantMessage.ts)、
[情绪字段](https://github.com/HumeAI/hume-typescript-sdk/blob/main/src/serialization/resources/empathicVoice/types/EmotionScores.ts)。

### 语音 VAD 三维展示

`/emotion` 使用从 video 实验中提取的通用 `VadPlot`，在页面内显示可旋转三维图、三轴坐标、实验强度及短期轨迹。
X 为正负倾向 [-1,1]，Y 为激活 [0,1]，Z 为掌控感 [-1,1]。
48 项 Hume 分数按总和归一化，对 `VOICE_VAD_ANCHORS` 的参考坐标加权，版本为
`hume-vad-experiment-v1`。Anger / Fear / Disgust / Sadness / Joy 沿用 video 对应类别的参考点，
Calmness 采用 video 的中性原点；其余参考点也是公开可调整的设计参数。
这不是 Hume 直接测量的 VAD，也不是经训练或校准的心理量表，两种来源的数值不能当作已校准测量互换。

只使用完整语音片段更新坐标；临时转写不会覆盖仍有效的坐标。完整片段缺少任意字段、
出现重复或未知字段、无效数值、全零时显示未知。原始 48 项分数保留在折叠详情中。
超过 6 秒未收到新有效完整片段会隐藏向量和数值；此计时基于浏览器接收时刻，不冒充音频采样时刻。
停止、断线、重新开始时不继续展示旧向量为当前情绪。轨迹沿用 video 的 30 秒 / 24 点上限，
过期断点不连线；400ms 插值只用于动画。映射和图表完全在本地执行，不增加外部请求或正式 API 字段。
