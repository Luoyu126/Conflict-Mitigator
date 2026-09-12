# LiveKit 音视频实验室（仅本地）

独立的临时 Next.js 应用，验证 LiveKit 官方 React 组件的多人语音、连接耗时和音质。
使用 `LiveKitRoom`、`RoomAudioRenderer`、`ControlBar`、`StartAudio` 及参与者 Hooks。
本目录是用户明确要求的实验环境，不实现或替代 `docs/api/` 的正式业务接口。
不连接数据库、Supabase、STT 或 AI Worker，不录音或保存音频。

## 启动

需要 Node.js 22.18+ 或 24。另一台电脑首次使用时：

```bash
git clone --branch feat/livekit-camera-emotion --single-branch https://github.com/Luoyu126/Conflict-Mitigator.git
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

临时 token 有效期 10 分钟，仅允许加入指定测试房间、发布麦克风、摄像头和订阅；每次入会随机生成身份。
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

## 摄像头与画面延迟测试

仍使用 http://localhost:3001 和相同的 `debug-audio-` 测试房间前缀，兼容原语音测试。
入会前选择 720p / 30 fps 或 360p / 20 fps；这些是目标预设，实际值以统计为准。
入会默认关闭摄像头和麦克风，使用控制栏手动开启或切换设备。退出释放媒体轨道。
画面通过官方 VideoTrack 渲染；本机画面仅为预览，远端画面才经过 LiveKit。
不录像、不保存画面；Face++ 分析需要另行同意开启。视频会增加 LiveKit Cloud 项目流量。

1. 两个窗口用不同名字进入同一房间，A 开摄像头，B 保持设备关闭，观察 A 的远端画面。
2. A 摄像头拍摄毫秒秒表，用手机同时拍到原始秒表和 B 收到的画面，比较同一照片中的两个读数。
3. 多次取样估计端到端画面延迟；包括摄像头采集、编码、网络、解码及显示，受屏幕刷新和拍照精度影响。
4. 退出重进对比两种分辨率；真正跨设备表现请用两台电脑测试。同机双窗口会共享 CPU 和网络。

视频统计每两秒更新，包含每路编码的分辨率、帧率、RTT、抖动、丢包、接收丢帧和累计平均解码 / 缓冲耗时。
Simulcast 每路分行显示，码率为轨道总码率，不能按行相加。缺失字段显示 `—`。
RTT 不是端到端延迟，也不能用 RTT / 2 加缓冲和解码均值推算真实单程延迟。

官方视频组件说明：https://docs.livekit.io/reference/components/react/concepts/rendering-video/

## Face++ 摄像头表情实验

在 `debug/.env.faceplusplus.local` 配置 `FACEPLUSPLUS_API_KEY`、`FACEPLUSPLUS_API_SECRET`，
可选 `FACEPLUSPLUS_REGION=us`（默认）或 `cn`，必须匹配账号区域。
该文件被 Git 忽略，仅服务端读取；不要提交实际密钥。可参考 `debug/faceplusplus-env.example`。
本地接口每次请求读取此文件，不需要为了更新密钥重启服务。

加入房间并开启自己的摄像头后，点击“同意并开始表情分析”。仅发送本人的画面，
远端参与者卡片不提供分析按钮。每次将长边不超过 640px 的 JPEG 发往 Face++ Detect API，
仅请求 `emotion,blur`；请求完成后至少等待 1.2 秒，不并发积压。
不保存图片、不返回 face_token / image_id，不做身份识别。Face++ 服务端的数据处理依其服务条款。
默认关闭；停止、关闭摄像头或退出会议会取消等待与本地请求、清除结果。
已发送至供应商的请求无法撤回。失败或限流时停止，用户可手动重试。

显示七类表情分数（0–100）、服务端请求往返耗时和浏览器本次采样至结果耗时。
分数不是人的真实心理状态，耗时不是纯模型推理时间或 LiveKit 视频延迟。
无脸、多脸、模糊或缺少有效分数显示无法判断，不把缺失当成“平静”。
测试代理 `/api/face-emotion` 仅限 development、本机同源和显式分析确认标记；
它不是正式 API-27，不写数据库。下方的 VAD 映射只生成实验强度，不写入正式 emotionIntensity 或 contentionScore。

官方接口文档：https://console.faceplusplus.com/documents/5679127

### VAD 三维情绪向量（实验）

视频右上角显示小型三维向量浮层，支持拖动、方向键旋转和重置视角；坐标、强度及参数保留在下方。
X 是正负倾向 [-1,1]，Y 是激活程度 [0,1]，Z 是掌控感 [-1,1]。
七类分数归一化后，对 `debug/lib/vad.ts` 的参考点加权；参考点为设计假设，
尤其掌控感不是 Face++ 直接测量值，不能当成已验证心理测量结果。
当前版本 `facepp-vad-experiment-v1`；参数在面板“查看实验映射参数”中公开。

强度公式为 `sqrt(0.15 * V² + 0.70 * A² + 0.15 * D²)`，范围 0–1。
中性参考为原点；正向激动也可能获得高分，不表示冲突或生气。
分数与坐标来自最新有效采样，400ms 插值仅用于向量动画，不产生新观测；
尊重系统减少动画设置。轨迹仅保留内存中的近 30 秒、最多 24 个有效采样，
无效结果或长时间间断重置轨迹，不连线冒充连续观测。

从浏览器抽帧时刻计，超过 6 秒未更新的采样显示过期并隐藏向量、显示未知分数。
无脸、多脸、低质量、无有效分数、停止或关闭摄像头都不以 0 替代未知。
当前不增加第三方请求，不写数据库，不修改正式 API 契约。
实验分数只作为未来 `VisualAffectResult.intensity` 的候选；正式 `emotionIntensity`
仍需后续服务结合本人同时间段文本证据融合，不能直接写 `contentionScore`。
