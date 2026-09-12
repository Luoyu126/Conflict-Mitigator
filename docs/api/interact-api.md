# interact-api.md · 页面、后端与媒体交互逻辑

> **已确认覆盖规则：** 实现时必须同时遵循
> [decision-overrides-v0.2.md](decision-overrides-v0.2.md)。发生冲突时 v0.2 优先。
> 本文后续的视频、Worker STT 插件、局部成员调解和纯轮询描述属于 v0.1 历史流程。

> 契约版本：v0.1-proposed · 与 frontend-api.md / internal-api.md 配套 · 不增加新的 HTTP 接口

本文解释三件事：**页面何时调用接口；后端收到请求后处理什么；音视频如何变成转写、辅助观察和共享图，再回到页面。** 字段的完整类型、必填和错误定义分别见 [frontend-api.md](frontend-api.md) 与 [internal-api.md](internal-api.md)。

来源标记：**[S1]** 原精简 API 文档；**[S2]** 原完整 API 与实时媒体规范；**[S3]** 配套 OpenAPI v0.1。本文整理已有约定，不表示服务、数据库增量或真实模型已经实现 / 测试。

## 0. v0.2 authoritative flow

```text
三名参与者匿名加入并连接 LiveKit 音频
  → 浏览器 Web Speech 产生 final 文本
  → reliable LiveKit data packet (cm.transcript.final.v1)
  → Worker 以可信 sender identity 校验并调用 API-22
  → Gemini 3.6 Flash 生成 API-24 结构化图更新
  → contention >= 0.72 + 2 speakers + 3 final segments
  → 服务层自动为所有 active participants 创建 pending proposal
  → Realtime 通知 + 全员 API-14 接受
  → 全员断开共享 LiveKit 音频，API-25 确认隔离
  → API-15 返回共享 versioned consensus tree，各自使用 API-17 私聊
  → 结构化安全提取后更新树并发 Realtime invalidation
  → AI 建议返回 + 全员对同一 summaryVersion 调用 API-18
  → API-05 新 token + 全员重连共享音频
```

API-23/API-27 固定返回 `409 FEATURE_DISABLED`。系统不采集视频、不保存原始音频，
没有预设或手动转写后备。Realtime 用于状态失效通知，HTTP GET 仍是授权后的真相来源。

## 1. 先区分“调用方”和“实现方”

| 范围 | 谁调用 | 谁接收 / 实现 | 详细契约 |
|---|---|---|---|
| API-01～19：页面业务接口 | 浏览器页面 / 组件 | Next.js Route Handler + services | frontend-api.md |
| API-20～25：Worker 接口 | 长驻媒体 Worker / 会议 Agent | Next.js 内部 Route Handler + services | internal-api.md |
| API-26：webhook | LiveKit | Next.js webhook handler | internal-api.md |
| API-27：视觉推理 | 视频处理 Worker | 独立 inference 服务 | internal-api.md |
| 发布 / 订阅音视频 | 浏览器、Worker 的 LiveKit SDK | LiveKit 实时媒体服务 | 原规范的 SDK 接入说明，不计入上述 27 个自定义 HTTP 操作 |
| readiness、本人状态提炼等 | 后端业务代码 | 同进程 service 函数 | 不是新 HTTP 接口 |

**frontend-api.md 不是“由前端实现的服务端代码”。前端调用其中的 19 个接口，后端实现它们；internal-api.md 是后端服务之间额外使用的 8 个接口。** [S1 §3；S2 §13]

```text
业务请求：
Browser -- HTTP API-01～19 --> Next.js route.ts --> services --> 数据库
Browser <-- JSON response -- Next.js

媒体处理（独立持续进行）：
Browser -- LiveKit SDK / WebRTC --> LiveKit --> Media Worker
Media Worker -- HTTP API-20～25 --> Next.js --> 数据库
Media Worker -- HTTP API-27 ----> Inference 服务
LiveKit     -- HTTP API-26 ----> Next.js webhook

结果显示：
Browser -- GET room / transcripts / mind-map / me --> Next.js --> 数据库
Browser <-- 当前状态 / 派生结果 ------------------ Next.js
```

不是每次前端请求都要再触发一个 internal HTTP 请求。简单查询由 service 读库后返回；私聊由 service 直接调用模型与状态函数；媒体分支则在 Worker 中独立运行。**API-22、23、24 的响应回给 Worker，不会自动推送给浏览器。** 本版前端通过已定义的 GET 轮询取得变化。[S2 §1、§2.5、§12]

## 2. 四个页面用到什么

| 页面 | 初始化 / 自动查询 | 用户动作 | 跳转条件 |
|---|---|---|---|
| `/` | 原设计可先建立 Supabase 匿名认证会话；不是新增业务 API | API-01 创建会议；已有会议号可直接导航到 Lobby | 创建成功后使用 `lobbyPath` |
| `/room/[roomId]/lobby` | API-02 获取标题、人数、`canJoin`、告知版本；设备预览在本地 | API-04 Join，提交姓名与分析同意 | 返回媒体凭证和 `navigationPath` 后连接 / 进入会议 |
| `/room/[roomId]` | API-03、09、10；点击节点读 API-11；针对节点读 API-12 | 同意设置 API-06；调解提议 API-13；进入确认 API-14；退出 API-07；主持人结束 API-08 | 只有本人属于目标轮次，且服务端状态允许，才进入私聊；不是 heated 就自动跳转 |
| `/room/[roomId]/mediation/[nodeId]` | API-12 将 nodeId 解析为 sessionId；再读 API-15、16 | API-17 发消息；API-18 接受恢复 / 等待；API-19 取消；API-06、07 仍可用 | 本轮 completed / cancelled 时返回会议；媒体重连使用 API-05 |

页面 URL 使用 **nodeId**，私聊 / 确认命令使用 **sessionId**。同一个节点第二次调解会有新的 sessionId，不能把上一轮消息混进当前轮次。[S2 API-12、§12～13]

## 3. 每个前端接口之后，后端如何响应

这里的“后端处理”是既有业务规则的展开。涉及本地函数调用时，不要求再绕一圈 internal HTTP。[S3 对应 API 操作；S2 §12]

| 前端接口 | 后端处理 | 是否涉及内部 / 外部调用 | 前端拿到结果后做什么 |
|---|---|---|---|
| [API-01 创建会议](frontend-api.md#api-01) | 验证用户与幂等键；写 rooms，记录创建者，状态 lobby | 此时不连接 LiveKit，不调模型 | 201：取 `room.id / lobbyPath`，去 Lobby |
| [API-02 读 Lobby](frontend-api.md#api-02) | 校验目标；只返回最小会前信息和加入许可 | 无模型或媒体处理 | 展示标题、人数和同意选项，不显示成员私聊 / 图 |
| [API-03 读会议](frontend-api.md#api-03) | 检查成员身份；组装 room、participants、me、observer 状态 | 读取已维护的业务状态，不在每次 GET 启动 Worker | 更新头部、AI 状态与会议阶段 |
| [API-04 Join](frontend-api.md#api-04) | 幂等创建 / 恢复本人 participant；绑定 identity；校验隔离；签 token；确保观察者已启动 | 服务端 `ensureObserver` / LiveKit dispatch；Worker 随后注册 API-20、读取 API-21 | 200：使用 `livekit` 连接；用户自行开启设备 |
| [API-05 新媒体 token](frontend-api.md#api-05) | 检查仍可重连且不在隔离 / cutoff 内；签新 token | 服务端 token SDK；不新建 participant | 使用新凭证重连；不能绕过 MEDIA_ISOLATED |
| [API-06 改同意](frontend-api.md#api-06) | 保存实际变更并递增 consentRevision；撤回共享时取消本人所在轮次 | Worker 从 API-21 看到新控制状态；API-22、23 拒绝旧同意版本 | 更新选择；必要时重新读取调解状态，不把撤回说成删除历史 |
| [API-07 Leave](frontend-api.md#api-07) | 本人标 left、禁新 token；取消相关未关闭轮次；登记媒体清理 | 移除 / 撤销公共媒体；失败由 Worker 控制与维护链路续做 | 202：停止设备并断开，导航 `/`；不等待普通界面继续传音视频 |
| [API-08 End](frontend-api.md#api-08) | 验证 host；业务 room=ended；成员标 left；关闭轮次 | 撤销媒体重入，DeleteRoom、停止 / 清理观察者；失败保留任务 | 202：显示结束并退出；其他成员通过 API-03 获知 ended |
| [API-09 读转写](frontend-api.md#api-09) | 按窗口读取公开 transcript，按 createdAt/id 升序返回 | 转写此前由 API-22 写入；GET 本身不运行 STT | 按 id/revision 替换，必要时用 before 补页 |
| [API-10 读图](frontend-api.md#api-10) | 读取一致的图快照和安全公开观点 | 图通常由 API-24 或后端调解 service 更新 | 按 parentNodeId 画图；mapVersion 不变不重绘 |
| [API-11 读节点](frontend-api.md#api-11) | 校验 room/node 归属；区分公开状态与本人 selfState | 普通 service 查询 | 打开详情面板，展示 heated 与调解入口 |
| [API-12 解析调解轮次](frontend-api.md#api-12) | 根据节点返回未关闭或最近轮次与 isMember | 普通 service 查询 | 取得 `session.id`；非成员不能继续访问 /me |
| [API-13 提议调解](frontend-api.md#api-13) | 校验 heated、名单、共享同意；创建 proposed，冻结成员；仅发起人 accept | 此时不执行媒体隔离，不启用私聊 | 201：显示等待其他人确认 |
| [API-14 进入确认](frontend-api.md#api-14) | 仅更新本人的决定；拒绝即取消；全员 accept 后持久化 starting 和隔离计划 | Worker API-21 取计划 → LiveKit 管理调用 → API-25 回执 | 200/202：读 session；starting 期间停止公共媒体、显示等待，不开放私聊 |
| [API-15 读本人调解上下文](frontend-api.md#api-15) | 只允许本轮成员；组装本人完整状态、他人公开观点、chatAllowed 等 | 普通 service 查询；不在 GET 中生成回复 | 更新聊天许可、readiness、shared summary 与导航 |
| [API-16 读本人消息](frontend-api.md#api-16) | 使用 session + 当前 participant 双重过滤分页 | 普通 service 查询，不读取他人的消息 | 显示自己的历史和 replyStatus |
| [API-17 发私聊](frontend-api.md#api-17) | 保存本人 user/pending；调用本人 Agent；只更新本人状态；评估 readiness / 摘要；保存回复 | 后端直接调模型 / service，**不把私聊发送到 API-22 或 API-24** | 201/200 显示回复；202 按 retryAfterMs 查询；失败按同一 clientMessageId 重试 |
| [API-18 恢复确认](frontend-api.md#api-18) | 检查 ready 与 summaryVersion；仅登记本人；全员接受同版本后事务完成恢复 | 无需让浏览器调用内部隔离确认；恢复后本人调用 API-05 | 仅 completed 才回会议和重连；一个人的 accept 不等于全员恢复 |
| [API-19 取消调解](frontend-api.md#api-19) | 校验成员或 host；取消本轮，node normal、readiness=null；不将 ended 房间复活 | 已开始的移除可能仍结束；按新 token / cutoff 规则重连 | 不受 readiness 阈值困住；以当前服务端状态决定返回 |

## 4. 创建 → 加入 → Worker 开始观察

```text
首页
  API-01 { title }
  ← 201 { data: { room, lobbyPath }, requestId }

Lobby
  API-02
  ← title / canJoin / consentNoticeVersion
  本地设备预览、姓名输入、分析同意
  API-04 { displayName, consents, consentNoticeVersion }

Next.js / service
  验证当前认证身份
  按 room + auth subject upsert participant
  固定 LiveKit identity = participant.id
  确保每个房间一个有效观察者
  签发 LiveKitConnection

浏览器
  ← room / me / livekit / navigationPath
  SDK room.connect(serverUrl, participantToken)
  用户启用 microphone / camera

Media Worker（另一个长驻执行过程）
  API-20 { runId, status, audio, video, meetingAgent, ... }
  ← leaseExpiresAt
  API-21 + X-Worker-Run-Id
  ← participants / consents / mediaAllowed / 任务与待处理输入
  订阅允许分析的远端轨道
```

API-04 的 HTTP 完成并不代表 STT / 视频模型已经就绪；前端使用 `room.observer` 显示 `starting / ready / degraded`。同意处理音频、同意视觉分析与设备权限是不同的事：拒绝视觉分析不等于不能普通视频通话。[S2 API-04、§4.2；S3 Consents / ObserverStatus]

Worker 每 10 秒调用 API-20 续 30 秒租约，启动后及每 1 秒调用 API-21 读取控制状态；旧 runId 不得继续提交结果。这是原设计的后台运行方式，不能在一个短时 Next.js 请求返回后靠未持久化任务无限运行。[S2 API-20、21、§14.1]

## 5. 音频链路：麦克风如何变成前端字幕

### 5.1 流从哪里来

这一路不是“浏览器拿到音频 URL 再调用我们的上传 API”。浏览器发布 microphone track，Worker 从 LiveKit 订阅该人的轨道，以 SDK 帧流读取音频。[S2 §3.1～3.2]

| SDK 对象 / 字段 | 用途 |
|---|---|
| `participant.identity` | 对应业务 participant.id，确定是谁的轨道 |
| `publication.sid` | 当前音频 Track SID，提交时是 `trackSid` |
| `publication.source` | 必须是 microphone；不把 screen-share audio 当麦克风 |
| `track.kind` | 必须是 audio |
| `AudioStream` 中的 `event.frame` | 本次 AudioFrame，不是一个下载地址 |
| `AudioFrame.data` | int16 PCM 原始样本，不是 MP3 / 带 WAV 头的文件 |
| `sample_rate / num_channels / samples_per_channel` | 采样率、声道、每声道样本数；下游必须按这些解释字节 |

原规范的默认目标是 16kHz、单声道、20ms 块；该配置对应 320 样本 / 640 字节。这是项目配置，不是所有 LiveKit 音频固定的尺寸。每个参与者独立一条 STT 流，不先把所有人混音。[S2 §3.2]

### 5.2 STT 与 API-22 的边界

```text
已获同意的 microphone track
  → AudioStream / AudioFrame
  → STT 插件 stream.push_frame(frame)
  → 并发接收 interim / final 事件
  → Worker 标准化
  → API-22：POST /api/internal/rooms/{roomId}/transcripts
  → 数据库存 transcript_segments

浏览器每秒 API-09
  ← items / pageInfo
  → 显示字幕
```

v0.2 使用浏览器 Web Speech final 结果，经 LiveKit data packet 送给 Worker；Worker 再调用 API-22。浏览器不持有 Worker 凭证，且不新增第 28 个 HTTP 接口。下列插件流式说明仅保留为 v0.1 背景。

| 原始内容 | 标准化 / API 字段 | 规则 |
|---|---|---|
| 轨道的 participant.identity | `participantIdentity` | 不用显示名、ASR speaker_id 冒充业务身份 |
| 轨道 SID、连续处理流 | `trackSid / streamId` | 换轨 / 重连 / 时间轴重锚时更新连续流标识 |
| 已选择的识别候选文本 | `content` | 空候选不制造空记录 |
| 识别事件类型 | `isFinal` | interim=false；确认 final=true |
| Worker 维护的句子关联 | `segmentId / revision` | 同一句 interim→final 复用 ID，修订号递增 |
| 经供应商适配的时间 | `startedAtMs / endedAtMs / timeBasis` | 换算为房间相对毫秒；未知用 null / unknown |
| 实际语言和可信度 | `language / confidence` | 供应商未定义时 null；不能把缺省 0 当真实可信度 |
| 当前控制上下文 | `consentRevision` | 入库时再次核对，撤回后的旧结果不能写入 |
| Worker 收到 STT 事件时间 | `receivedAt` | UTC 时间，仅用于接收记录，不冒充说话开始时间 |

API-22 返回 `segment / duplicate / analysisRequired`。其中 `analysisRequired` 表示最终片段还有待分析工作，**不是模型分析已完成的证明**。Meeting Agent 从 API-21 读取尚未处理的 final；只有成功 API-24 后才标记为已消费。[S3 API-21、22、24]

前端将相同 id 的旧 revision 替换为新 revision，不把中间版、最终版重复追加。只读最新一页可能漏掉窗口之外的数据，因此按 `pageInfo.nextBeforeCursor` 补齐到已知记录。[S2 API-09]

## 6. 视频链路：摄像头如何影响节点状态（v0.2 已禁用）

### 6.1 视频不是直接变成 contentionScore

```text
camera track
  → VideoStream / VideoFrameEvent
  → 抽样、像素转换、旋转校正、缩放、JPEG 编码
  → API-27：Worker → 独立 Inference 服务
  ← VisualAffectResult
  → API-23：Worker → Next.js，保存派生观察

Meeting Agent
  API-21 读取 final transcript + 当前图 + recentAffectObservations
  → 判断同一参与者、同一时段是否有充分讨论证据
  → API-24 提交有证据的节点 / 个人结构化状态更新

浏览器
  API-10 / API-11 / API-15 读取相应安全投影
  → 更新图、节点状态或本人状态
```

**API-27 不写业务数据库，API-23 也不直接把 `intensity` 填进某个 node 的 `contentionScore`。** 它们先提供视觉辅助观察，再由会议分析结合公开讨论证据使用。[S2 §3.3～3.4；S3 API-23、24、27]

### 6.2 从 VideoFrame 到 JPEG

| SDK 内容 | Worker 怎么处理 |
|---|---|
| `participant.identity / publication.sid` | 确定哪个人的 camera track；不是做人脸身份识别 |
| `VideoFrameEvent.frame` | 原始帧像素对象 |
| `VideoFrame.type / data` | 缓冲可能是 YUV 等格式，不能假定全是 RGB 字节 |
| `VideoFrame.convert(RGB24)` | 转像素格式；不会自动生成 JPEG |
| `VideoFrameEvent.rotation` | 在上传前实际旋转像素；不是只在 metadata 声称已转正 |
| `width / height` | 使用编码后 JPEG 的实际尺寸填写 metadata |
| `VideoFrameEvent.timestamp_us` | 保留为 `sdkTimestampUs` 字符串；不能默认是 UTC / Unix 时间 |

原规范默认每人最多 1fps、最长边 640px、JPEG ≤512KiB；一个执行中请求加一个最新待处理帧。模型慢时替换旧待处理帧，不能让图片任务无限堆积或阻塞音频 STT。[S2 §3.3]

### 6.3 API-27 的调用与结果

```http
POST <INFERENCE_ORIGIN>/internal/v1/affect/frames
Authorization: Bearer <INFERENCE_SERVICE_TOKEN>
Content-Type: multipart/form-data; boundary=<由 HTTP 客户端生成>
```

两个 part：`metadata` 使用 application/json；`frame` 使用 image/jpeg 二进制。具体字段见 [API-27](internal-api.md#api-27)。不是逐字段 form 字符串，不传图片 URL，不把原始 RGB / YUV bytes 标成 JPEG。[S2 §3.3；S3 FrameUpload]

关键 metadata 为 `observationId、roomId、participantIdentity、trackSid、streamId、sampledAtMs、sdkTimestampUs、width、height、rotationApplied、consentRevision`。它们分别用于去重、身份 / 轨道归属、时间关联、尺寸校验、旋转处理和同意检查。

结果 `VisualAffectResult` 包含 `observationId、status、intensity、confidence、faceCount、reason、model、inferenceMs`。`ok` 时必须单人脸、intensity 非空；`unavailable` 时 intensity/confidence 为 null。无脸、多脸或图像质量差不能用 0 表示“情绪稳定”。这里的强度只是辅助估计，不是诊断，也不是对真实心理状态的断言。[S3 VisualAffectResult]

### 6.4 API-23 与 API-24 如何接力

Worker 把同一份 `metadata` 与 API-27 的 `data` 结果组成 `{ metadata, result }`，提交 API-23。后端再次检查 observationId、camera track、身份和 consentRevision；只保存派生结果，默认不持久保存原始 JPEG。[S3 API-23]

API-23 返回的 `nodeId` 通常为 null：**视频帧本身不知道用户正在讨论哪个议题。** 选中的 UI 节点也不是归因证据。API-24 中 `ParticipantStateDraft.affectObservationIds` 只有在同人、同时段的 final transcript 证据成立时才用于融合和节点关联；证据不足就继续保留未归因观察。[S2 §3.4；S3 ParticipantStateDraft]

因此前端看到 heated 的路径是“新文本 / 视觉证据 → 分析 → 服务端更新节点 → 页面重新读取”，不是摄像头一帧到达就强制切换页面。

## 7. Meeting Agent 如何更新图

有效 Worker 调用 API-21，读取 `pendingTranscripts / nodes / participantStates / recentAffectObservations / mapVersion`。这些不包含任何人的私聊原文。分析后提交：[S3 WorkerContext / MeetingAnalysisRequest]

```text
API-24 request
  analysisId             本次分析的幂等 UUID
  baseMapVersion         读取上下文时看到的版本
  sourceTranscriptIds    本批公开 final 输入
  nodeUpserts[]          有证据的节点创建 / 更新；可为空
```

后端验证房间一致性、树不成环、参与者 / 证据归属、当前轮次与版本，再一次性写节点 / 个人状态、递增图版本、标记已处理转写。数组使用原规范的完整替换语义，不默认追加。`NodeUpsert` 不接受直接设置 `status / readinessScore`；普通会议分析只能由服务层管理 normal / heated，不能伪造用户同意把节点直接推进私聊或 ready。[S3 API-24、NodeUpsert、ParticipantStateDraft]

若 `baseMapVersion` 冲突，重新读 API-21 后再计算 / 提交，不能用旧结果覆盖新状态。若 `hasMorePendingTranscripts=true`，成功处理当前批后继续取后续批。没有有效 final 输入时，不凭空调用 API-24 写节点。[S2 API-21、24]

浏览器通过 API-10 的 `mapVersion` 与 nodes 看见更新；GET 本身不负责再次运行 Agent。

## 8. Heated → 接受 → 隔离 → 私密聊天

本段把进入操作与媒体隔离明确区分；路由跳转不构成隐私保障。[S2 §4.3、§12.3]

| 阶段 | 前端 | 后端 / Worker | 业务状态 |
|---|---|---|---|
| 建议 | API-10 / 11 看到 heated，显示建议 | 分数与讨论证据产生建议 | node=heated；尚未强制任何人进入 |
| 提议 | API-13 提交 participantIds、可选 reason | 校验名单 / 同意，创建本轮；仅发起人 accept | session=proposed；其余成员 pending |
| 逐人确认 | 相关人分别 API-14 `{decision}` | 只能修改调用者自己的决定 | 任一 decline → cancelled；未全 accept 仍 proposed |
| 开始隔离 | 最后一人收到 202；相关浏览器停止本地 tracks 并断开公共 LiveKit | 持久化隔离计划、禁止目标新 token，Worker API-21 读取计划 | session=starting；node 仍 heated；不允许私聊 |
| 执行媒体管理 | 显示处理中，不声称已经安全就绪 | Worker 执行原规范的 RemoveParticipant + cutoff 撤销 / 检查 | 逐人记录是否成功 |
| 隔离回执 | 不调用这个内部接口 | Worker API-25 提交 sessionId + results | 全部通过后 session=active，node=private_mediation |
| 私聊开启 | API-15 得到 chatAllowed=true，开放输入 | 私聊后端仍逐请求检查本人身份、轮次和同意 | 允许 API-17 |

v0.2 的自动提议冻结房间内所有 active participants；全员接受后所有人都断开公共音频。原设计的局部成员调解描述不再适用。同房间仍至多一个未关闭轮次，名单冻结后不能因为某人短暂断线就悄悄换人。

**源规范的部署前提：** 隔离方案按 LiveKit Cloud 的明确 token 撤销 cutoff 设计；不是假定自托管 RemoveParticipant 自动让旧 token 失效。DB 状态更新与外部媒体调用不是原子事务，必须保留 starting、目标清单、失败 / 重试与取消；严格隔离效果仍需在实际部署里测试。[S2 §4.3]

隔离完成后，目标用户的摄像头和麦克风不再进入公开会议分析。**小黑屋是私密文本阶段，不能把旧视频分数说成仍在实时采集的新情绪。** [S2 §4.3]

## 9. 一条私聊如何产生回复、共享观点和 readiness

```text
Browser API-17 { clientMessageId, content }
  → Next.js 验证本人 / session=active / structuredSharing
  → 幂等保存本人 user message，replyStatus=pending
  → 本人的 Private Agent service
       读取本人本轮消息
       读取当前节点 + 本人状态
       读取其他人允许协作的结构化观点（不读其他人的原始私聊）
       调用模型，校验回复和状态草案
  → 保存唯一 assistant，关联 replyToMessageId
  → 只更新本人 participant_node_states
  → 根据节点最新结构化状态评估 readiness / 生成可公开摘要
  → 以版本检查提交；旧摘要发生变化则旧恢复确认失效
  ← 201：userMessage / assistantMessage / selfState / node / session
```

这是一个业务请求中的服务调用，**不是 API-17 → API-22 → API-24**。后两者只处理公开会议输入 / 会议 Agent 结果，不能承载私聊。[S2 §12.4；S3 API-17、22、24]

本版保留 `position / supportingReasons / underlyingConcerns / emotionIntensity / viewOfOthers / acceptableCompromises`，不单列 misunderstanding。对外只共享适合公开、获允许的结构化提炼；把原话改成 concern 不天然等于可以公开。`viewOfOthers` 是本人对他人的理解，不是对方真实意图；`acceptableCompromises` 必须由本人表达或确认，不能把 AI 提议当作用户已接受。[S2 §5.1；S3 ParticipantNodeState]

### 成功、进行中与超时

| 情况 | API-17 响应 | 页面行为 |
|---|---|---|
| 第一次处理完成 | 201 + ChatCompletedData | 显示回复，刷新状态 |
| 同一发送已经完成，再次请求 | 200 + ChatCompletedData | 合并既有消息，不重复添加 |
| 同一发送已有请求执行中 | 202 + ChatPendingData | 使用 userMessage / retryAfterMs 显示等待，调用 API-16 |
| 模型等待超时 | 504 + error.userMessageId；用户消息标 failed | 显示失败；同一内容重试沿用 clientMessageId |
| 摘要 / readiness 因并发或生成失败未完成 | 保留已成功的聊天，维持未准备好状态 | 不展示虚假的 ready；后续有效交互再评估 |

原规范限制单次生成等待 25 秒；超时中止，不在 HTTP 返回之后暗示还有一个没有持久队列的后台生成任务。`202` 的重复请求场景也不能被理解为“模型已经完成”。[S2 API-17、§12.4；S3 ChatPendingData]

## 10. 恢复、取消和重新连接

当 API-15 返回 `canAcceptResume=true` 时，展示 `session.sharedSummary / summaryVersion`。每位成员对**自己实际看到的同一个版本**调用 API-18：`{ decision: "accept" 或 "wait", summaryVersion }`。[S3 ResumeRequest / MediationMeData]

全员接受同一有效版本后，后端事务完成：[S2 §12.5]

```text
session.status = completed
session.endedAt = 当前时间
node.status = normal
node.readinessScore = null
node.discussionLoopCount = 0
room.status = meeting（已经 ended 则不重新开启）
```

保留节点内容和最近的 contentionScore，不伪造清零，不出现 resolved。旧分数不直接触发新调解；原规范建议短暂冷却，并要求新 final 讨论证据。[S2 §12.5]

前端通过当前响应或后续 API-15 看到 completed 后返回 `/room/[roomId]`，调用 API-05 拿新 token，然后重连。麦克风 / 摄像头由本人重新开启，不能因为页面自动跳转就远程打开。[S2 §4.3、§12.5]

有人 wait 则不完成恢复；任何本轮成员可调用 API-19 取消，不受 readiness 阈值阻拦。取消后的晚到 API-25 回执不得把 cancelled 重新置 active；若之前媒体撤销仍完成，重连仍遵守 cutoff 和新 token 规则。[S3 API-18、19、25]

## 11. 同意撤回、离会、结束与 webhook

### 同意撤回

API-06 更新同意版本后，Worker 从 API-21 读取并停止对应分支；API-22、23 在入库时拒绝旧版本数据。前端不能把“设置已保存”说成“已经发给供应商的字节被收回”，也不能把撤回等同于自动删除历史。撤回 structuredSharing 会取消本人所在轮次。[S2 §2.3；S3 API-06]

### 离会 / 结束与清理

API-07 只让本人离开；API-08 才是 host 结束整个业务会议。两者先提交业务状态并禁止重入，再处理外部媒体。`202 / mediaCleanup=pending` 时，Worker 从 API-21 获取 `mediaCleanupTargets / deleteMediaRoom`，执行待清理操作后通过 API-20 上报 `mediaCleanupCompleted=true`；后端核对后才能清除标记、停止执行者。[S2 §14.1；S3 API-07、08、20、21]

### LiveKit webhook 是另一条入口

API-26 由 LiveKit 调用，前端不调用。后端使用原始请求 body + 官方 Authorization 签名验签后消费事件；以事件 id 去重，快速返回 204。它维护媒体 presence / track 信息或辅助清理，但不提供真实音视频 bytes。[S2 §4.4；S3 API-26]

`room_finished` 可能仅表示公共媒体房间空了；当大家都进入文本小黑屋时，不能因此把业务 rooms.status 改 ended。短暂断线与主动 API-07 离会也不是同一件事。[S2 §4.4、§12.3]

## 12. 结果如何回到前端：Realtime 失效通知 + 授权读取

v0.2 使用 Supabase Realtime 发布房间/调解版本失效通知，并使用 Presence 显示网络在线状态。事件不携带私聊原文或完整共识树；客户端收到更新后仍调用下列授权 GET 获取真相。

| 前端位置 | 读取方式 | 关键合并 / 判断字段 |
|---|---|---|
| 会议页 | 每 1 秒 API-03、09、10 | room.status / observer；segment.id + revision；mapVersion |
| 节点详情 / 本节点轮次解析 | API-11、12 | node.status；session.id / status；isMember |
| 调解页 | 每 1 秒 API-15 | chatAllowed；canAcceptResume；summaryVersion；navigationPath |
| 等待回复 / 多标签页消息同步 | API-16；202 时参考 retryAfterMs | message.id；replyStatus；replyToMessageId |
| 初始服务端页面渲染 | 原规范允许 Server Component 调同一个 service | 不需要服务器再请求自己一次 HTTP；后续浏览器调用仍遵守契约 |

**三个容易误解的地方：**

- 只实现用户点击的 POST 不够：前端还需要上述 GET 初始化和自动刷新。
- Worker 拿到 API-24 的 200 只表示后端已接受分析，不表示浏览器已画完；浏览器下一次读图才看到新版本。
- HTTP 202、页面跳转、AI 分数都不能替代 `session.status / chatAllowed / 全员同版本确认` 这些服务端业务事实。

## 13. 本次不补造的边界

**模型与评分策略：** v0.2 选择 Gemini 3.6 Flash，并以 0.72 作为产品工作流触发阈值；它是产品启发式规则，不是心理学或诊断结论。视觉供应商不适用。

**首次提议提醒的节点发现：** v0.2 在 Room 与 Realtime 事件中同时提供 `activeMediationSessionId` 和 `activeMediationNodeId`，客户端再通过 API-12 读取轮次；不新增第 28 个 HTTP 接口。

**数据库迁移与部署：** 原规范提出的 auth 身份映射、mediation_members、affect_observations、版本 / 幂等收据等仍需落地。上述 API 文档是契约，不证明数据库已经存在这些列，也不证明媒体隔离与模型质量已经通过端到端测试。[S2 §11、§14.3]

## 14. 阅读分工与原文定位

前端同学以 [frontend-api.md](frontend-api.md) 为字段依据，结合本文的页面流程、等待状态与轮询逻辑实现 UI；不需要实现 / 持有内部服务凭证。后端同学同时读取前两份接口文件：实现前端调用的业务入口，也实现 / 对接 Worker、webhook 和推理服务。媒体同学重点看本文 §4～8、§11 以及 internal-api.md。[S2 §13]

| 标记 | 原文件 | 本次采用的内容 |
|---|---|---|
| S1 | `conflict_mitigator_api_contract_compact.md` | 27 个 API 的编号、职责与业务拆分范围 |
| S2 | `conflict_mitigator_api_v0.1.md` | §1～5 媒体 / 身份 / 状态边界；§8 接口行为；§12 时序；§13 分工；§14 失败处理 |
| S3 | `conflict_mitigator_openapi_v0.1.yaml` | 字段、必填、可空、枚举、全部成功响应与错误契约 |

LiveKit SDK / 官方管理方法的说明沿用 S2 的既有引用与接入选择，本次是文档拆分，不是对实际部署版本重新做联调验证。
