# internal-api.md · 后端内部与媒体接口

> **Current multimodal override:** [multimodal-v0.3.md](multimodal-v0.3.md) takes precedence for camera/voice consent, private emotion visibility and media lifecycle.


> 契约版本：v0.1-proposed · 按业务拆分版 · 共 8 个 HTTP 操作（API-20～27）

> **已确认覆盖规则：** 实现时必须同时遵循
> [decision-overrides-v0.2.md](decision-overrides-v0.2.md)。发生冲突时 v0.2 优先。

本文件只列服务间调用：6 个 Worker 接口、1 个 LiveKit webhook、1 个独立视觉推理接口。**这是按调用者划分，不是实现责任划分：后端也必须实现 frontend-api.md 中的 19 个业务接口。**

前端不持有本文件使用的服务凭证。`/api/internal` 命名不等于权限保护；必须鉴权、校验房间归属与执行租约。交互顺序见 [interact-api.md](interact-api.md)。

**来源与边界：** 本次拆分沿用 `conflict_mitigator_api_contract_compact.md` 的 27 个操作；用配套 `conflict_mitigator_openapi_v0.1.yaml` 展开字段、嵌套类型、约束及所有成功状态，并用原完整 API 文档补充已有处理说明。未增加接口、未修改原文件、未执行服务联调。原规范中的身份 / 逐人确认 / 幂等 / 派生观察等数据库增量仍是设计前提，不代表迁移已完成。

**精简表格中的省略已按原 OpenAPI 展开：** API-14 的 200/202，API-17 的 200/201/202，API-23 的 200/201 均保留；不是本次新增的返回行为。

## 1. 通用 HTTP 约定

| 项目 | 约定 |
|---|---|
| 服务地址 | API-20～26 使用 `APP_ORIGIN`；API-27 使用 `INFERENCE_ORIGIN`。 |
| 路径 | `{roomId}` 等是替换参数；对应 Next.js 目录中的 `[roomId]`。 |
| JSON | 请求 / 响应使用 camelCase；DB 的 snake_case 不直接暴露。未标明允许额外字段的对象不接受任意附加字段。 |
| ID / 时间 | 业务 ID 是 UUID；绝对时间是 UTC ISO8601；`*AtMs` 的媒体时间相对 `room.mediaEpochAt`，不是 Unix 毫秒。 |
| 必填 / null | 必填表示字段必须存在；可空按类型中的 `null` 判断。`[]`、省略和 `null` 不能混用。 |
| 成功包装 | `{"data": <本接口 DTO>, "requestId": <UUID>}`；下文返回表只展开 `data`。204 无响应体。 |
| requestId | 每次 HTTP 请求的追踪 UUID；不作为用户身份、幂等 ID 或消息 ID。 |
| 缓存 | 业务数据、token、私聊响应使用 `Cache-Control: no-store`。 |
| 重试 | 原请求被重试时保持相同逻辑 ID；状态 / 版本冲突先读当前状态，不无限重复旧请求。 |

| 类别 | 认证 |
|---|---|
| API-20 | `Authorization: Bearer <WORKER_SERVICE_TOKEN>`；请求 body 提供 runId。 |
| API-21～25 | 相同 Worker bearer，另带 `X-Worker-Run-Id: <当前有效租约 runId>`。 |
| API-26 | 官方 `Authorization` 签名 Header；用 `WebhookReceiver` 校验原始 body。不是应用 Bearer。 |
| API-27 | `Authorization: Bearer <INFERENCE_SERVICE_TOKEN>`；独立推理服务凭证。 |

Worker JSON 上限沿用原规范建议：普通 256KiB，meeting-analysis 2MiB；视觉 metadata ≤16KiB、JPEG ≤512KiB。转写 / 视觉 / 图提交分别使用 `segmentId+revision / observationId / analysisId` 去重，不逐帧添加业务 Idempotency-Key。

### 通用错误

错误响应结构为 [`ApiError`](#dto-apierror)，其内部字段全部在本文件末尾定义。每个接口的错误段列出特有或细化的错误；通用项不重复展开。

| HTTP | code | 处理含义 |
|---|---|---|
| 400 | `INVALID_REQUEST` | JSON / multipart / 请求格式无法解析。 |
| 401 | `UNAUTHENTICATED` | 缺少或无效认证；webhook 细化为签名失败。 |
| 403 | `FORBIDDEN` | 当前认证主体无操作权限。 |
| 404 | `NOT_FOUND` | 目标不存在，或为避免泄露他人私聊存在性而隐藏。 |
| 422 | `VALIDATION_ERROR` | 字段类型、引用或内容违反契约。 |
| 429 | `RATE_LIMITED` | 按 `error.retryAfterMs` 等待，避免立即密集重试。 |
| 500 | `INTERNAL_ERROR` | 安全的内部错误说明，不返回堆栈、密钥或原始 prompt。 |

## 2. 按业务查找接口

| 业务模块 | 编号 | Method / Path | 功能 |
|---|---|---|---|
| Worker 生命周期与输入读取 | [API-20](#api-20) | `POST /api/internal/rooms/{roomId}/worker-status` | 注册／续租媒体 Worker |
| Worker 生命周期与输入读取 | [API-21](#api-21) | `GET /api/internal/rooms/{roomId}/context` | 获取会议观察 Worker 所需输入 |
| 转写、视觉结果与图更新 | [API-22](#api-22) | `POST /api/internal/rooms/{roomId}/transcripts` | 接收标准化 STT 片段 |
| 转写、视觉结果与图更新 | [API-23](#api-23) | `POST /api/internal/rooms/{roomId}/affect-observations` | 接收辅助视觉分析结果 |
| 转写、视觉结果与图更新 | [API-24](#api-24) | `POST /api/internal/rooms/{roomId}/meeting-analysis` | 提交会议 Agent 的结构化图更新 |
| 媒体隔离确认 | [API-25](#api-25) | `POST /api/internal/rooms/{roomId}/mediation-isolation` | 确认本轮媒体隔离结果 |
| LiveKit 事件入口 | [API-26](#api-26) | `POST /api/webhooks/livekit` | 接收并验签 LiveKit 官方事件 |
| 独立视觉推理服务 | [API-27](#api-27) | `POST /internal/v1/affect/frames` | 抽样 JPEG → 辅助 affect 分析 |

## 3. 接口字段与行为

### Worker 生命周期与输入读取

<a id="api-20"></a>
### API-20 · 注册／续租媒体 Worker

`POST /api/internal/rooms/{roomId}/worker-status`

**调用方向：** 媒体 Worker → Next.js；注册执行权 / 续租 / 上报健康与清理状态。

**认证：** Worker bearer。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |

**请求体：** `application/json`；必须发送。类型 `WorkerStatusRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `runId` | 是 | UUID | 每次 Worker 进程执行生成的新 UUID；不是 LiveKit track SID。 |
| `status` | 是 | `"starting"` / `"ready"` / `"degraded"` / `"stopped"` | 工作状态。 |
| `audio` | 是 | `"disabled"` / `"starting"` / `"ready"` / `"error"` | 音频分支。 |
| `video` | 是 | `"disabled"` / `"starting"` / `"ready"` / `"error"` | 视频分支。 |
| `meetingAgent` | 是 | `"disabled"` / `"starting"` / `"ready"` / `"error"` | 结构分析分支。 |
| `mediaCleanupCompleted` | 否 | boolean<br>缺省 false | 可选；true 表示 Worker 已完成当前待清理目标。服务端重新核对当前目标，不能盲信过期 ack；缺省 false。 |

请求示例：
```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440007",
  "status": "ready",
  "audio": "ready",
  "video": "ready",
  "meetingAgent": "ready",
  "mediaCleanupCompleted": false
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `WorkerLeaseData` |

`data: WorkerLeaseData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `runId` | 是 | UUID | 被接受的 runId。 |
| `leaseExpiresAt` | 是 | UTC ISO8601 | 服务器当前时间后 30 秒；建议每 10 秒续约。 |
| `observer` | 是 | [`ObserverStatus`](#dto-observerstatus) | 媒体 Worker 的业务健康投影；不是 LiveKit participant 信息。 |

**业务约束：** 服务端认证后对房间租约加锁：空闲／过期可接受新 runId；未过期且不同 runId 返回 409。每 10 秒续 30 秒租约；其他 internal 写入需校验同一个有效 runId。心跳还可处理过期提议、过期 chat 租约，并为超过官方时间窗口的待撤销目标刷新 cutoff。mediaCleanupCompleted=true 仅在服务端核对当前待清理目标确已移除后清除 room 清理标志；status=stopped 只有清理完成后释放执行权。不能靠 browser 心跳获得 worker 权限。

**主要写入 / 结果：** rooms.observer_state 租约与健康状态；过期任务维护；经核对的媒体清理状态。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 WORKER_LEASE_CONFLICT`。

**契约来源：** 原 OpenAPI 的 `post__api_internal_rooms__roomId__worker_status`；原 API 规范 API-20。

<a id="api-21"></a>
### API-21 · 获取会议观察 Worker 所需输入

`GET /api/internal/rooms/{roomId}/context`

**调用方向：** 当前有效 Worker → Next.js；读取待分析内容及控制计划。

**认证：** Worker bearer + 有效 X-Worker-Run-Id。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| header | `X-Worker-Run-Id` | 是 | UUID | 必须等于此房间有效租约的 runId。 |

**请求体：** 无。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `WorkerContext` |

`data: WorkerContext`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `room` | 是 | [`Room`](#dto-room) | rooms 的安全 API 投影；补充字段在迁移附录中明确列出。 |
| `mapVersion` | 是 | integer<br>≥ 0 | 当前共享图版本。 |
| `participants` | 是 | [`WorkerParticipant`](#dto-workerparticipant)[]<br>至少 0 项；至多 12 项 | 身份映射、同意与隔离状态。 |
| `nodes` | 是 | [`MindMapNode`](#dto-mindmapnode)[]<br>至少 0 项；至多 500 项 | 共享节点。 |
| `participantStates` | 是 | [`ParticipantNodeState`](#dto-participantnodestate)[]<br>至少 0 项；至多 6000 项 | 授权 Agent 可读的结构化当前状态，不含私聊。 |
| `pendingTranscripts` | 是 | [`TranscriptSegment`](#dto-transcriptsegment)[]<br>至少 0 项；至多 100 项 | 尚未被成功 analysis 标记处理的 final 片段，最旧优先最多 100 条。 |
| `hasMorePendingTranscripts` | 是 | boolean | 是否还有剩余 final 片段；提交分析后继续取下一批。 |
| `recentAffectObservations` | 是 | [`AffectObservation`](#dto-affectobservation)[]<br>至少 0 项；至多 200 项 | 最近 15 秒最多 200 条未过期辅助观察；无图像字节。 |
| `pendingIsolations` | 是 | [`IsolationPlan`](#dto-isolationplan)[]<br>至少 0 项；至多 1 项 | 本房间至多一个 starting 会话的隔离任务。 |
| `mediaCleanupTargets` | 是 | [`IsolationTarget`](#dto-isolationtarget)[]<br>至少 0 项；至多 12 项 | 【补充】本房间主动离会／结束后仍需要 RemoveParticipant+撤销的目标；没有时 []。 |
| `deleteMediaRoom` | 是 | boolean | 【补充】是否在撤销所有成员 token 后删除媒体 room；业务 ended 且尚待清理时为 true。 |

**业务约束：** 不返回 private_messages。pendingTranscripts 最旧优先；分析失败未标记，重试仍可读取。最多一个有效 runId 消费；在没有有效输入时不凭空更新节点。启动后和每 1 秒查询一次控制状态；逐帧使用缓存同意，最终写入还需后端再检查。

**主要写入 / 结果：** 无。

**错误：** 通用错误表中的状态均适用。

**契约来源：** 原 OpenAPI 的 `get__api_internal_rooms__roomId__context`；原 API 规范 API-21。

### 转写、视觉结果与图更新

<a id="api-22"></a>
### API-22 · 接收标准化 STT 片段

`POST /api/internal/rooms/{roomId}/transcripts`

**调用方向：** 音频 STT 分支 → Next.js；只交标准化文本，不交 PCM 音频。

**认证：** Worker bearer + 有效 X-Worker-Run-Id。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| header | `X-Worker-Run-Id` | 是 | UUID | 必须等于此房间有效租约的 runId。 |

**请求体：** `application/json`；必须发送。类型 `TranscriptIngestRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `segmentId` | 是 | UUID | Worker 为一句持续转写分配的稳定 UUID，interim→final 复用。 |
| `participantIdentity` | 是 | string | 从 track_subscribed 的 participant.identity 取出，不使用 ASR diarization 的 speaker_id。 |
| `trackSid` | 是 | string | 麦克风 track SID。 |
| `streamId` | 是 | UUID | 连续处理流 ID。 |
| `content` | 是 | string<br>最短 1 字符；最长 8000 字符 | 已规范化的转写文本。 |
| `isFinal` | 是 | boolean | 只在确认 FINAL_TRANSCRIPT 时 true。 |
| `revision` | 是 | integer<br>≥ 1 | 该 segment 的修订号。 |
| `startedAtMs` | 是 | integer / null<br>非空分支：≥ 0 | 统一 room 时间轴开始毫秒；未知填 null。 |
| `endedAtMs` | 是 | integer / null<br>非空分支：≥ 0 | 统一 room 时间轴结束毫秒；未知填 null。 |
| `language` | 是 | string / null | 适配后的语言代码，未知 null。 |
| `confidence` | 是 | number / null<br>非空分支：≥ 0；≤ 1 | 供应商明确给出的置信度；未知 null。 |
| `receivedAt` | 是 | UTC ISO8601 | Worker 接收 STT 事件的 UTC 时间；不拿它冒充说话开始时间。 |
| `timeBasis` | 是 | `"receiver_estimate"` / `"unknown"` | 本版本仅允许接收端估计或未知，不声称样本级跨轨精确同步。 |
| `consentRevision` | 是 | integer<br>≥ 1 | 送入 STT 时记录的同意版本。 |

请求示例：
```json
{
  "segmentId": "550e8400-e29b-41d4-a716-446655440005",
  "participantIdentity": "550e8400-e29b-41d4-a716-446655440001",
  "trackSid": "TR_audio_demo",
  "streamId": "550e8400-e29b-41d4-a716-446655440007",
  "content": "我认为应该保留这个功能。",
  "isFinal": true,
  "revision": 2,
  "startedAtMs": 42000,
  "endedAtMs": 44500,
  "language": "zh",
  "confidence": 0.94,
  "receivedAt": "2026-09-12T14:00:44.500Z",
  "timeBasis": "receiver_estimate",
  "consentRevision": 1
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `TranscriptAcceptedData` |

`data: TranscriptAcceptedData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `segment` | 是 | [`TranscriptSegment`](#dto-transcriptsegment) | 带说话人归属的公共会议转写；不接收任何私聊原文。 |
| `duplicate` | 是 | boolean | 相同 id+revision 的重复请求。 |
| `analysisRequired` | 是 | boolean | 服务端是否还有该最终段未处理的分析工作。 |

**业务约束：** 以 room+segmentId 去重，revision 必须递增；同 id+revision+相同正文返回 duplicate=true，冲突正文 409。final 后不接受回退为 interim，也不允许晚到旧 run 覆盖。验证 identity 关联人、mic source、该媒体区间已同意且不在隔离、时间合理；不合规结果返回 409 并丢弃，不进入 transcript。final 首次提交后成为待分析输入。

**主要写入 / 结果：** transcript_segments upsert。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`422 VALIDATION_ERROR / TRACK_IDENTITY_MISMATCH`；`409 SEGMENT_REVISION_CONFLICT / CONSENT_REVOKED / MEDIA_ISOLATED`。

**契约来源：** 原 OpenAPI 的 `post__api_internal_rooms__roomId__transcripts`；原 API 规范 API-22。

<a id="api-23"></a>
### API-23 · 接收辅助视觉分析结果

`POST /api/internal/rooms/{roomId}/affect-observations`

**调用方向：** 视频处理 Worker → Next.js；只交 metadata 和视觉模型结果，不交 JPEG。

**认证：** Worker bearer + 有效 X-Worker-Run-Id。

**v0.2 行为：** 本接口仅为兼容保留。完成调用方认证后立即返回
`409 FEATURE_DISABLED`，不解析或保存请求体。下列 v0.1 成功结构仅为历史契约，
当前产品不可达。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| header | `X-Worker-Run-Id` | 是 | UUID | 必须等于此房间有效租约的 runId。 |

**请求体：** `application/json`；必须发送。类型 `AffectObservationRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `metadata` | 是 | [`FrameMetadata`](#dto-framemetadata) | 本项目逐帧视觉接口 metadata JSON part；所有身份来自服务端已订阅轨道。 |
| `result` | 是 | [`VisualAffectResult`](#dto-visualaffectresult) | 本项目视觉分析适配器的归一化输出，不是 LiveKit 内置情绪字段。 |

请求示例：
```json
{
  "metadata": {
    "observationId": "550e8400-e29b-41d4-a716-446655440006",
    "roomId": "550e8400-e29b-41d4-a716-446655440000",
    "participantIdentity": "550e8400-e29b-41d4-a716-446655440001",
    "trackSid": "TR_camera_demo",
    "streamId": "550e8400-e29b-41d4-a716-446655440007",
    "sampledAtMs": 43000,
    "sdkTimestampUs": null,
    "width": 640,
    "height": 360,
    "rotationApplied": true,
    "consentRevision": 1
  },
  "result": {
    "observationId": "550e8400-e29b-41d4-a716-446655440006",
    "status": "ok",
    "intensity": 0.62,
    "confidence": 0.81,
    "faceCount": 1,
    "reason": null,
    "model": {
      "provider": "mock",
      "name": "affect-demo",
      "version": "v0"
    },
    "inferenceMs": 140
  }
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 201 | 首次保存该派生观察。 | `AffectAcceptedData` |
| 200 | 同 observationId、同内容的重复提交。 | `AffectAcceptedData` |

`data: AffectAcceptedData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `observationId` | 是 | UUID | 接收记录 ID。 |
| `duplicate` | 是 | boolean | 是否是相同观察的重复提交。 |
| `nodeId` | 是 | UUID / null | 本接口不做讨论归因，通常为 null；后续 analysis 可绑定。 |

**业务约束：** 只存派生结果，不存 frame 原图。两个 observationId 必须相同，匹配 camera track 人员及 consentRevision。ok 必须单人脸且 intensity 非空，unavailable 必须 intensity/confidence=null。本接口不接受调用者自选 nodeId，也不直接写 participant_node_states.emotionIntensity。重复相同内容 200。

**主要写入 / 结果：** affect_observations（新增）。

**错误：** 当前 v0.2 固定为 `409 FEATURE_DISABLED`；认证失败仍返回 401/403。

**契约来源：** 原 OpenAPI 的 `post__api_internal_rooms__roomId__affect_observations`；原 API 规范 API-23。

<a id="api-24"></a>
### API-24 · 提交会议 Agent 的结构化图更新

`POST /api/internal/rooms/{roomId}/meeting-analysis`

**调用方向：** 会议 Agent 所在的有效 Worker → Next.js；交结构化图更新。

**认证：** Worker bearer + 有效 X-Worker-Run-Id。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| header | `X-Worker-Run-Id` | 是 | UUID | 必须等于此房间有效租约的 runId。 |

**请求体：** `application/json`；必须发送。类型 `MeetingAnalysisRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `analysisId` | 是 | UUID | 分析批次 UUID；重复提交不得重复增长 loop count／生成节点。 |
| `baseMapVersion` | 是 | integer<br>≥ 0 | 读取 WorkerContext 时看到的 mapVersion。 |
| `sourceTranscriptIds` | 是 | UUID[]<br>至少 1 项；至多 100 项；元素唯一 | 必须来自此房间未处理 final 集合，至少一个；本接口不处理私聊。 |
| `nodeUpserts` | 是 | [`NodeUpsert`](#dto-nodeupsert)[]<br>至少 0 项；至多 50 项 | 显式新增／更新的节点；没有图变化也可以 [] 并标记转写已处理。 |

请求示例：
```json
{
  "analysisId": "550e8400-e29b-41d4-a716-446655440006",
  "baseMapVersion": 5,
  "sourceTranscriptIds": [
    "550e8400-e29b-41d4-a716-446655440005"
  ],
  "nodeUpserts": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440003",
      "parentNodeId": null,
      "topic": "是否在 MVP 中保留 Feature X？",
      "summary": null,
      "contentionScore": 0.82,
      "discussionLoopCount": 2,
      "participantStates": [
        {
          "participantId": "550e8400-e29b-41d4-a716-446655440001",
          "position": null,
          "supportingReasons": [
            "保留简化版 Feature X"
          ],
          "underlyingConcerns": [
            "保留简化版 Feature X"
          ],
          "emotionIntensity": null,
          "viewOfOthers": [
            {
              "participantId": "550e8400-e29b-41d4-a716-446655440002",
              "interpretation": "Alex 主要担心开发截止时间。"
            }
          ],
          "acceptableCompromises": [
            "保留简化版 Feature X"
          ],
          "evidenceTranscriptIds": [
            "550e8400-e29b-41d4-a716-446655440005"
          ],
          "affectObservationIds": [
            "550e8400-e29b-41d4-a716-446655440006"
          ]
        }
      ]
    }
  ]
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `MeetingAnalysisData` |

`data: MeetingAnalysisData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `analysisId` | 是 | UUID | 接受的分析批次。 |
| `mapVersion` | 是 | integer<br>≥ 0 | 新共享图版本。 |
| `updatedNodeIds` | 是 | UUID[]<br>至少 0 项；至多 50 项；元素唯一 | 已更新节点列表。 |
| `processedTranscriptIds` | 是 | UUID[]<br>至少 0 项；至多 100 项；元素唯一 | 幂等标记完成的 transcript。 |
| `duplicate` | 是 | boolean | 相同 analysisId 是否已经处理。 |

**业务约束：** baseMapVersion 乐观锁，单事务写入并标记 sourceTranscriptIds 已消费。所有 node/parent/participant/evidence 必须同房间；不得更改 active 调解节点的结构化状态。状态只由服务层根据分数与近期证据决定 normal/heated；不允许 AI 写 private_mediation/ready_to_resume。viewOfOthers 仅记录本人说出的理解；折中须有本人证据。v0.2 不接收视觉观察。提交成功后，服务层按 v0.2 的 `contentionScore >= 0.72`、至少两名 active 参与者和至少三条 final 转写证据规则自动创建全员 pending 的提议；不替任何参与者接受。MVP 只 create/update，不开放节点删除/合并端点。

**主要写入 / 结果：** mind_map_nodes；participant_node_states；rooms.map_version；final processed 标记；affect.node_id。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`422 VALIDATION_ERROR / INVALID_EVIDENCE / TREE_CYCLE / CROSS_ROOM_REFERENCE`；`409 MAP_VERSION_CONFLICT / NODE_IN_MEDIATION`。

**契约来源：** 原 OpenAPI 的 `post__api_internal_rooms__roomId__meeting_analysis`；原 API 规范 API-24。

### 媒体隔离确认

<a id="api-25"></a>
### API-25 · 确认本轮媒体隔离结果

`POST /api/internal/rooms/{roomId}/mediation-isolation`

**调用方向：** 媒体隔离执行 Worker → Next.js；确认已执行的隔离结果。

**认证：** Worker bearer + 有效 X-Worker-Run-Id。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| header | `X-Worker-Run-Id` | 是 | UUID | 必须等于此房间有效租约的 runId。 |

**请求体：** `application/json`；必须发送。类型 `IsolationAckRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `sessionId` | 是 | UUID | 仍处于 starting 的轮次。 |
| `results` | 是 | [`IsolationAckItem`](#dto-isolationackitem)[]<br>至少 1 项；至多 12 项 | 只含计划名单目标，可分批提交。 |

请求示例：
```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440004",
  "results": [
    {
      "participantId": "550e8400-e29b-41d4-a716-446655440001",
      "revokeBeforeUnixSec": 1789221602,
      "succeeded": true,
      "errorCode": null
    }
  ]
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `IsolationAckData` |

`data: IsolationAckData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `session` | 是 | [`MediationSession`](#dto-mediationsession) | 一次节点级调解；proposed/starting/cancelled 是为了落实同意与失败恢复而提出的扩展。 |
| `node` | 是 | [`MindMapNode`](#dto-mindmapnode) | 共享讨论树节点。 |

**业务约束：** 仅接受仍在 starting 的目标、已保存 cutoff 和当前有效 Worker。逐个成功可记录；失败保持 starting 并显示错误，用户可取消。全部成功才开始私聊；不能接受仅 UI muted=true 的证明。服务端和 Worker 需验证 LiveKit 调用结果并核对媒体连接。

**主要写入 / 结果：** mediation_members.isolated_at；所有人成功后 session active/node private_mediation。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 SESSION_STATE_CONFLICT / ISOLATION_TARGET_MISMATCH`。

**契约来源：** 原 OpenAPI 的 `post__api_internal_rooms__roomId__mediation_isolation`；原 API 规范 API-25。

### LiveKit 事件入口

<a id="api-26"></a>
### API-26 · 接收并验签 LiveKit 官方事件

`POST /api/webhooks/livekit`

**调用方向：** LiveKit → Next.js webhook；事件通知，不是音视频传输。

**认证：** 官方 Authorization 签名 Header；验证 raw body，不用应用 JWT 代替。

**参数**

无额外 Path / Query / Header 参数；认证 Header 仍按上面的认证要求发送。

**请求体：** `application/webhook+json`；必须发送。类型 `LiveKitWebhookEvent`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | string | 官方事件 UUID；用于重复投递去重。 |
| `event` | 是 | string | 事件名，如 participant_joined、track_published；未知事件验签后忽略。 |
| `createdAt` | 是 | integer / string<br>非空分支：≥ 0；非空分支：正则 `^[0-9]+$` | 官方 protobuf int64：Unix 秒，SDK/JSON 可能为数值或十进制字符串。 |
| `room` | 否 | object | 官方 room 消费子集。 |
| `room.sid` | 否（父字段存在时） | string | 媒体房间会话 SID。 |
| `room.name` | 否（父字段存在时） | string | cm_<roomId>。 |
| `participant` | 否 | object | 官方 participant 消费子集。 |
| `participant.sid` | 否（父字段存在时） | string | 这次媒体连接 SID，不是业务身份。 |
| `participant.identity` | 否（父字段存在时） | string | 本项目参与者 UUID 或 Worker identity。 |
| `track` | 否 | object | 可选轨道描述；没有音视频字节，也没有下载 URL。 |
| `track.sid` | 否（父字段存在时） | string | 轨道 SID。 |
| `track.type` | 否（父字段存在时） | integer / string | 官方 AUDIO/VIDEO 枚举，经 SDK 规范化。 |
| `track.source` | 否（父字段存在时） | integer / string | 官方 CAMERA/MICROPHONE 等 source 枚举，经 SDK 规范化。 |

兼容规则：允许原规范明确放行的附加字段；只消费表中定义的字段。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 204 | 已接受，无响应体。 | 无响应体 |

**业务约束：** 读取 request.text() 原始 body，用 WebhookReceiver.receive(rawBody,Authorization) 验证后才解析使用。Content-Type 是 application/webhook+json，不使用应用成功 JSON 包装；快速返回 204。重复 id 也返回 204。room_finished 只代表媒体房间空闲关闭，不自动把业务 rooms.status 改 ended。不能从 webhook 获取音频样本或视频帧。

**主要写入 / 结果：** webhook 去重收据；媒体 presence/track 缓存；清理/重试任务。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`401 UNAUTHENTICATED / INVALID_WEBHOOK_SIGNATURE`。

**契约来源：** 原 OpenAPI 的 `post__api_webhooks_livekit`；原 API 规范 API-26。

### 独立视觉推理服务

<a id="api-27"></a>
### API-27 · 抽样 JPEG → 辅助 affect 分析

`POST /internal/v1/affect/frames`

**调用方向：** 视频处理 Worker → 独立推理服务；交 JPEG，取辅助视觉结果。

**认证：** Inference bearer。

**Host：** `INFERENCE_ORIGIN`，不是 `APP_ORIGIN`。

**v0.2 行为：** 本接口仅为兼容保留。完成调用方认证后立即返回
`409 FEATURE_DISABLED`，不解析 multipart、不保存 frame，也不调用模型。下列 v0.1
成功结构仅为历史契约，当前产品不可达。

**参数**

无额外 Path / Query / Header 参数；认证 Header 仍按上面的认证要求发送。

**请求体：** `multipart/form-data`；必须发送。类型 `FrameUpload`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `metadata` | 是 | [`FrameMetadata`](#dto-framemetadata) | 一个 application/json 类型的 part；不是逐字段 form 字符串。 |
| `frame` | 是 | binary | 一个 image/jpeg 二进制 part，最大 524288 字节；长边最大 640px；不接收任意 image URL。 |

multipart part 编码：`metadata: application/json`；`frame: image/jpeg`。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `VisualAffectResult` |

`data: VisualAffectResult`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `observationId` | 是 | UUID | 与输入 frame metadata 完全一致，用于幂等。 |
| `status` | 是 | `"ok"` / `"unavailable"` | ok 代表有可用辅助视觉信号，unavailable 代表不能判断。 |
| `intensity` | 是 | number / null<br>非空分支：≥ 0；≤ 1 | 视觉上激活／紧张程度的辅助估计；不等于真实愤怒，也不直接等于节点融合 emotionIntensity。 |
| `confidence` | 是 | number / null<br>非空分支：≥ 0；≤ 1 | 适配器输出的质量／可信度标尺，需按所选模型校准；没有可用值为 null。 |
| `faceCount` | 是 | integer<br>≥ 0 | 本次用于质量控制的检测人脸数量；不做身份识别。 |
| `reason` | 是 | `"no_face"` / `"multiple_faces"` / `"low_quality"` / `"model_unavailable"` / `"consent_revoked"` / null | unavailable 原因；ok 时必须为 null。 |
| `model` | 是 | [`InferenceModel`](#dto-inferencemodel) | 用于排查模型版本，不包含 API key。 |
| `inferenceMs` | 是 | integer<br>≥ 0 | 服务端处理耗时，毫秒。 |

条件约束：`status=ok` 时 `faceCount=1`、`intensity` 非空、`reason=null`；`status=unavailable` 时 `intensity=null`、`confidence=null`、`reason` 非空。

**业务约束：** 这是我们定义的推理服务接口，不是 LiveKit 官方 API，也不是 Next.js 页面服务。multipart 必须有 metadata(application/json) 与 frame(image/jpeg)。解码后长边<=640、字节<=524288、尺寸匹配并已校正 rotation。无脸/多脸/低质量返回 200+unavailable；模型不可用可返回 503。不承诺能识别真实心理状态，不返回身份、人格或诊断。实际模型尚未选定，模型适配由 inference 服务完成。

**主要写入 / 结果：** 默认不落盘原始 JPEG；只返回模型结果。

**错误：** 当前 v0.2 固定为 `409 FEATURE_DISABLED`；认证失败仍返回 401/403。

**契约来源：** 原 OpenAPI 的 `post__internal_v1_affect_frames`；原 API 规范 API-27。

## 4. 本文件用到的公共 DTO

以下只收录本文件接口递归引用到的类型；请求和返回中引用的每一个类型均在本文件内闭合。枚举、可空性及条件约束来自配套 OpenAPI。

<a id="dto-fieldissue"></a>
### `FieldIssue`

字段校验失败的具体位置。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `path` | 是 | string | JSON 路径、query 或 path 参数名。 |
| `reason` | 是 | string | 可读原因，不包含私聊内容。 |

<a id="dto-errordetail"></a>
### `ErrorDetail`

机器可读错误。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `code` | 是 | string | 稳定错误码；见错误处理章节。 |
| `message` | 是 | string | 安全、可展示的说明。 |
| `retryable` | 是 | boolean | 是否允许在条件未改变时重试。 |
| `issues` | 是 | [`FieldIssue`](#dto-fieldissue)[]<br>至少 0 项 | 字段错误；无具体字段时为 []。 |
| `userMessageId` | 是 | UUID / null | 已经入库的用户消息 ID；用于相同 clientMessageId 重试。 |
| `retryAfterMs` | 是 | integer / null<br>非空分支：≥ 0 | 建议等待毫秒数；不是必须有值。 |

<a id="dto-apierror"></a>
### `ApiError`

所有本项目 HTTP 错误的统一结构；不是 LiveKit 官方错误结构。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `error` | 是 | [`ErrorDetail`](#dto-errordetail) | 机器可读错误。 |
| `requestId` | 是 | UUID | 本次 HTTP 请求的追踪 ID；不得用作用户身份。 |

<a id="dto-consents"></a>
### `Consents`

本项目提出的同意记录；不是 LiveKit 的设备权限或 JWT grant。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `transcription` | 是 | boolean | 允许把本人公开会议的麦克风音频送入 STT 并保存转写。 |
| `visualAffect` | 是 | boolean | 允许抽取本人公开会议摄像头画面进行辅助 affect 分析；拒绝不影响视频通话。 |
| `structuredSharing` | 是 | boolean | 允许把从本人私聊提炼、适合共享的结构化观点用于本轮协作；不是公开私聊原文。 |

<a id="dto-observerstatus"></a>
### `ObserverStatus`

媒体 Worker 的业务健康投影；不是 LiveKit participant 信息。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `status` | 是 | `"idle"` / `"starting"` / `"ready"` / `"degraded"` / `"stopped"` | 未启动／启动中／就绪／部分异常／停止。 |
| `audio` | 是 | `"disabled"` / `"starting"` / `"ready"` / `"error"` | STT 分支状态。 |
| `video` | 是 | `"disabled"` / `"starting"` / `"ready"` / `"error"` | 视频抽帧与分析分支状态。 |
| `meetingAgent` | 是 | `"disabled"` / `"starting"` / `"ready"` / `"error"` | 会议结构分析分支状态。 |
| `lastHeartbeatAt` | 是 | UTC ISO8601 / null | 最后一次有效心跳时间。 |

<a id="dto-room"></a>
### `Room`

rooms 的安全 API 投影；补充字段在迁移附录中明确列出。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | UUID | rooms.id；URL 中的 roomId。 |
| `title` | 是 | string<br>最短 1 字符；最长 120 字符 | 会议名称。 |
| `status` | 是 | `"lobby"` / `"meeting"` / `"mediation"` / `"ended"` | 业务阶段。mediation 表示存在一个活动的局部调解，不代表所有人都进入私聊。 |
| `createdAt` | 是 | UTC ISO8601 | 会议创建时间，对应 created_at。 |
| `updatedAt` | 是 | UTC ISO8601 | 会议业务状态最近更新时间，对应 updated_at。 |
| `mediaEpochAt` | 是 | UTC ISO8601 / null | 【补充】房间媒体时间轴原点；第一次签发媒体连接信息时设定，之后不随重连重置。 |
| `activeMediationSessionId` | 是 | UUID / null | 【派生】唯一未关闭调解轮次；没有时为 null。 |
| `observer` | 是 | [`ObserverStatus`](#dto-observerstatus) | 【派生】Worker 健康状态。 |

<a id="dto-participant"></a>
### `Participant`

participants 的房间成员可见投影；不包含 auth_user_id。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | UUID | 参与者业务 ID，同时作为 LiveKit identity。 |
| `roomId` | 是 | UUID | 所属房间 ID。 |
| `displayName` | 是 | string<br>最短 1 字符；最长 40 字符 | 可重复的显示名，不是认证身份。 |
| `role` | 是 | `"host"` / `"participant"` | 由服务端根据房间创建者确定；用户不能提交 role。 |
| `status` | 是 | `"active"` / `"left"` | 业务成员是否已离会；不等于网络连接是否暂时断开。 |
| `livekitIdentity` | 是 | string / null | LiveKit 稳定 identity；本设计固定为 participants.id。 |
| `joinedAt` | 是 | UTC ISO8601 | 第一次业务加入时间。 |
| `leftAt` | 是 | UTC ISO8601 / null | 主动离会或结束会议的时间；短暂网络断开不改为 left。 |

<a id="dto-viewofother"></a>
### `ViewOfOther`

当前用户对另一位参与者的理解；不是对方已确认的真实意图。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `participantId` | 是 | UUID | 被理解的另一位参与者；必须属于同一个房间，不能是本人。 |
| `interpretation` | 是 | string<br>最短 1 字符；最长 1000 字符 | 本人如何理解此人的立场、原因或关注点。 |

<a id="dto-participantnodestate"></a>
### `ParticipantNodeState`

完整本人／授权 Agent 状态，沿用已讨论字段；没有 misunderstanding。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | UUID | participant_node_states.id。 |
| `nodeId` | 是 | UUID | 对应讨论节点。 |
| `participantId` | 是 | UUID | 这份结构化状态的所有者。 |
| `position` | 是 | string / null<br>非空分支：最长 1000 字符 | 目前主张怎么做；尚未表达时为 null。 |
| `supportingReasons` | 是 | string[]<br>至少 0 项；至多 20 项；每项：最短 1 字符；最长 1000 字符 | 支持立场的理由；未提取到时为 []。 |
| `underlyingConcerns` | 是 | string[]<br>至少 0 项；至多 20 项；每项：最短 1 字符；最长 1000 字符 | 底层关注、担忧或希望保护的事物；未提取到时为 []。 |
| `emotionIntensity` | 是 | number / null<br>非空分支：≥ 0；≤ 1 | 该人在该节点上的辅助情绪强度估计；不是心理诊断；未知为 null。 |
| `viewOfOthers` | 是 | [`ViewOfOther`](#dto-viewofother)[]<br>至少 0 项；至多 11 项 | 本人如何理解他人。每个 participantId 最多出现一次。 |
| `acceptableCompromises` | 是 | string[]<br>至少 0 项；至多 20 项；每项：最短 1 字符；最长 1000 字符 | 本人表达或确认可接受的折中方案；AI 猜测的候选方案不能写成已接受。 |
| `updatedAt` | 是 | UTC ISO8601 | 这份当前状态的最后更新时间。 |

<a id="dto-mindmapnode"></a>
### `MindMapNode`

共享讨论树节点。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | UUID | mind_map_nodes.id。 |
| `roomId` | 是 | UUID | 所属房间。 |
| `parentNodeId` | 是 | UUID / null | 父节点；必须同房间，不能成环；根节点为 null。 |
| `topic` | 是 | string<br>最短 1 字符；最长 200 字符 | 节点讨论主题。 |
| `summary` | 是 | string / null<br>非空分支：最长 4000 字符 | 截至当前的共享讨论摘要，只含可公开内容。 |
| `status` | 是 | `"normal"` / `"heated"` / `"private_mediation"` / `"ready_to_resume"` | 无 resolved；resume 后回到 normal。 |
| `contentionScore` | 是 | number<br>≥ 0；≤ 1 | 节点整体冲突／对抗程度，0～1；不是某个人的情绪。 |
| `readinessScore` | 是 | number / null<br>非空分支：≥ 0；≤ 1 | 当前轮次恢复讨论的辅助建议分数；非调解阶段为 null。 |
| `discussionLoopCount` | 是 | integer<br>≥ 0 | 自上次恢复后识别的无效重复讨论次数。 |
| `createdAt` | 是 | UTC ISO8601 | 节点创建时间。 |
| `updatedAt` | 是 | UTC ISO8601 | 节点最后更新时间。 |

<a id="dto-transcriptsegment"></a>
### `TranscriptSegment`

带说话人归属的公共会议转写；不接收任何私聊原文。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | UUID | 稳定 segment ID；同一句 interim→final 不更换 ID。 |
| `roomId` | 是 | UUID | 房间。 |
| `participantId` | 是 | UUID | 由 Worker 的可信 LiveKit identity 映射而来。 |
| `content` | 是 | string<br>最短 1 字符；最长 8000 字符 | 转写文本。 |
| `startedAtMs` | 是 | integer / null<br>非空分支：≥ 0 | 相对 room.mediaEpochAt 的开始毫秒；接收端估计，不是保证精确的采集时间。 |
| `endedAtMs` | 是 | integer / null<br>非空分支：≥ 0 | 同一时间轴的结束毫秒；非空时 >= startedAtMs。 |
| `isFinal` | 是 | boolean | true 表示最终转写；仅 final 进入持久的 Meeting Agent 分析。 |
| `revision` | 是 | integer<br>≥ 1 | 【补充】同一 segment 单调递增版本，从 1 开始。 |
| `streamId` | 是 | UUID | 【补充】连续音频处理流 ID；轨道重建、重新锚定时变化。 |
| `sourceTrackSid` | 是 | string | 【补充】音频 Track SID；不是下载地址。 |
| `language` | 是 | string / null | 【补充】识别语言，如 zh/en；供应商没有返回时为 null。 |
| `confidence` | 是 | number / null<br>非空分支：≥ 0；≤ 1 | 【补充】仅保留有明确含义的供应商置信度；不把 SDK 缺省 0 当真实置信度。 |
| `createdAt` | 是 | UTC ISO8601 | 首次入库时间。 |
| `updatedAt` | 是 | UTC ISO8601 | 最后一次接受该 segment 修订的时间。 |

<a id="dto-mediationmember"></a>
### `MediationMember`

【补充】本轮被冻结的受影响参与者及各自确认；不含私聊。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `participantId` | 是 | UUID | 受影响参与者 ID。 |
| `entryDecision` | 是 | `"pending"` / `"accept"` / `"decline"` | 本人对进入本轮调解的决定。 |
| `resumeDecision` | 是 | `"pending"` / `"accept"` / `"wait"` | 本人对当前 shared summary 对应恢复建议的决定。 |
| `acceptedSummaryVersion` | 是 | integer / null<br>非空分支：≥ 1 | 接受恢复时看到的 summaryVersion；无接受时为 null。 |
| `isolatedAt` | 是 | UTC ISO8601 / null | 【补充】媒体隔离操作成功并被服务端接受的时间；不是浏览器点击时间。 |
| `updatedAt` | 是 | UTC ISO8601 | 本人成员确认信息最近更新时间。 |

<a id="dto-mediationsession"></a>
### `MediationSession`

一次节点级调解；proposed/starting/cancelled 是为了落实同意与失败恢复而提出的扩展。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | UUID | 轮次 ID；同一个 node 可有多轮；私聊写入必须指定此 ID。 |
| `roomId` | 是 | UUID | 所属房间。 |
| `nodeId` | 是 | UUID | 本轮聚焦节点。 |
| `status` | 是 | `"proposed"` / `"starting"` / `"active"` / `"completed"` / `"cancelled"` | proposed 等确认；starting 等媒体隔离；active 私聊；completed 已恢复；cancelled 取消。 |
| `triggerReason` | 是 | string / null<br>非空分支：最长 1000 字符 | 对参与者可公开的发起原因。 |
| `sharedSummary` | 是 | string / null<br>非空分支：最长 4000 字符 | 当前经过公开信息生成的共同摘要；未准备好时为 null。 |
| `summaryVersion` | 是 | integer<br>≥ 0 | 【补充】0 表示尚无可接受摘要；有效摘要从 1 开始；更新摘要使旧确认失效。 |
| `createdAt` | 是 | UTC ISO8601 | 【补充】提议创建时间。 |
| `expiresAt` | 是 | UTC ISO8601 / null | 【补充】仅 proposed 需要的同意截止时间；默认创建后 120 秒。 |
| `startedAt` | 是 | UTC ISO8601 / null | 所有相关人接受且媒体隔离完成后的开始时间；proposed/starting 时为 null。 |
| `endedAt` | 是 | UTC ISO8601 / null | completed/cancelled 的关闭时间。 |
| `members` | 是 | [`MediationMember`](#dto-mediationmember)[]<br>至少 2 项；至多 12 项 | 本轮固定成员。不得根据当前在线列表隐式改动。 |
| `transitionError` | 是 | string / null | 【补充】安全错误码，例如 MEDIA_ISOLATION_FAILED；不放供应商密钥或原始堆栈。 |

<a id="dto-workerparticipant"></a>
### `WorkerParticipant`

媒体 Worker 允许使用的身份映射与同意信息。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `participant` | 是 | [`Participant`](#dto-participant) | participants 的房间成员可见投影；不包含 auth_user_id。 |
| `consents` | 是 | [`Consents`](#dto-consents) | 本项目提出的同意记录；不是 LiveKit 的设备权限或 JWT grant。 |
| `consentRevision` | 是 | integer<br>≥ 1 | 当前同意版本。 |
| `mediaAllowed` | 是 | boolean | false 表示该人正被隔离／已离会／会议结束；不得继续音视频分析。 |

<a id="dto-isolationtarget"></a>
### `IsolationTarget`

需要断开并撤销旧媒体令牌的目标。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `participantId` | 是 | UUID | 业务参与者。 |
| `participantIdentity` | 是 | string | 发送给 LiveKit RemoveParticipant 的 identity。 |
| `revokeBeforeUnixSec` | 是 | integer<br>≥ 0 | 【补充】服务器生成的明确撤销 cutoff，Unix 秒；调解期间禁止签发新媒体 token。 |

<a id="dto-isolationplan"></a>
### `IsolationPlan`

【补充】有持久依据的外部媒体隔离任务；不是 DB 与 LiveKit 原子事务。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `sessionId` | 是 | UUID | 对应 starting 轮次。 |
| `targets` | 是 | [`IsolationTarget`](#dto-isolationtarget)[]<br>至少 1 项；至多 12 项 | 尚未确认媒体隔离完成的人。 |

<a id="dto-inferencemodel"></a>
### `InferenceModel`

用于排查模型版本，不包含 API key。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `provider` | 是 | string | 实际接入供应商／自托管标识；mock 明确写 mock。 |
| `name` | 是 | string | 实际模型名称，不伪称 LiveKit 自带情绪模型。 |
| `version` | 是 | string / null | 可获得的固定模型版本；供应商未暴露则 null。 |

<a id="dto-visualaffectresult"></a>
### `VisualAffectResult`

本项目视觉分析适配器的归一化输出，不是 LiveKit 内置情绪字段。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `observationId` | 是 | UUID | 与输入 frame metadata 完全一致，用于幂等。 |
| `status` | 是 | `"ok"` / `"unavailable"` | ok 代表有可用辅助视觉信号，unavailable 代表不能判断。 |
| `intensity` | 是 | number / null<br>非空分支：≥ 0；≤ 1 | 视觉上激活／紧张程度的辅助估计；不等于真实愤怒，也不直接等于节点融合 emotionIntensity。 |
| `confidence` | 是 | number / null<br>非空分支：≥ 0；≤ 1 | 适配器输出的质量／可信度标尺，需按所选模型校准；没有可用值为 null。 |
| `faceCount` | 是 | integer<br>≥ 0 | 本次用于质量控制的检测人脸数量；不做身份识别。 |
| `reason` | 是 | `"no_face"` / `"multiple_faces"` / `"low_quality"` / `"model_unavailable"` / `"consent_revoked"` / null | unavailable 原因；ok 时必须为 null。 |
| `model` | 是 | [`InferenceModel`](#dto-inferencemodel) | 用于排查模型版本，不包含 API key。 |
| `inferenceMs` | 是 | integer<br>≥ 0 | 服务端处理耗时，毫秒。 |

条件约束：`status=ok` 时 `faceCount=1`、`intensity` 非空、`reason=null`；`status=unavailable` 时 `intensity=null`、`confidence=null`、`reason` 非空。

<a id="dto-framemetadata"></a>
### `FrameMetadata`

本项目逐帧视觉接口 metadata JSON part；所有身份来自服务端已订阅轨道。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `observationId` | 是 | UUID | 这一采样帧的唯一 ID。 |
| `roomId` | 是 | UUID | 业务房间。 |
| `participantIdentity` | 是 | string | 映射到 participants.id 的 LiveKit identity。 |
| `trackSid` | 是 | string | camera Track SID。 |
| `streamId` | 是 | UUID | 本次视频连续流 ID，轨道重连后重建。 |
| `sampledAtMs` | 是 | integer<br>≥ 0 | 按统一 room 时间轴记录的采样接收时间，毫秒；不是 SDK timestamp_us 直接除 1000。 |
| `sdkTimestampUs` | 是 | string / null<br>非空分支：正则 `^[0-9]+$` | 原始 SDK 视频时间戳，十进制字符串防止整数精度损失；仅用于追踪，不保证是 Unix 时间。 |
| `width` | 是 | integer<br>≥ 1；≤ 640 | 上传 JPEG 解码后的实际宽，像素。 |
| `height` | 是 | integer<br>≥ 1；≤ 640 | 上传 JPEG 解码后的实际高，像素。 |
| `rotationApplied` | 是 | `true` | 固定 true，适配器已经将 SDK rotation 作用到像素上。 |
| `consentRevision` | 是 | integer<br>≥ 1 | 采样时的同意版本；入库前必须再次与当前值比较。 |

<a id="dto-affectobservation"></a>
### `AffectObservation`

已通过身份、轨道和同意校验的视觉观察记录。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `metadata` | 是 | [`FrameMetadata`](#dto-framemetadata) | 本项目逐帧视觉接口 metadata JSON part；所有身份来自服务端已订阅轨道。 |
| `result` | 是 | [`VisualAffectResult`](#dto-visualaffectresult) | 本项目视觉分析适配器的归一化输出，不是 LiveKit 内置情绪字段。 |
| `participantId` | 是 | UUID | 由可信映射解析得到的业务参与者。 |
| `nodeId` | 是 | UUID / null | 只有有同时段讨论证据才能关联节点；不确定时必须 null。 |
| `receivedAt` | 是 | UTC ISO8601 | 业务后端接受观察的时间。 |

<a id="dto-participantstatedraft"></a>
### `ParticipantStateDraft`

Meeting Agent 只从公共会议信息产生的某人当前状态草案；完整数组替换语义。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `participantId` | 是 | UUID | 这份结构化状态的所有者。 |
| `position` | 是 | string / null<br>非空分支：最长 1000 字符 | 目前主张怎么做；尚未表达时为 null。 |
| `supportingReasons` | 是 | string[]<br>至少 0 项；至多 20 项；每项：最短 1 字符；最长 1000 字符 | 支持立场的理由；未提取到时为 []。 |
| `underlyingConcerns` | 是 | string[]<br>至少 0 项；至多 20 项；每项：最短 1 字符；最长 1000 字符 | 底层关注、担忧或希望保护的事物；未提取到时为 []。 |
| `emotionIntensity` | 是 | number / null<br>非空分支：≥ 0；≤ 1 | 该人在该节点上的辅助情绪强度估计；不是心理诊断；未知为 null。 |
| `viewOfOthers` | 是 | [`ViewOfOther`](#dto-viewofother)[]<br>至少 0 项；至多 11 项 | 本人如何理解他人。每个 participantId 最多出现一次。 |
| `acceptableCompromises` | 是 | string[]<br>至少 0 项；至多 20 项；每项：最短 1 字符；最长 1000 字符 | 本人表达或确认可接受的折中方案；AI 猜测的候选方案不能写成已接受。 |
| `evidenceTranscriptIds` | 是 | UUID[]<br>至少 1 项；至多 100 项；元素唯一 | 支撑本人的公开观点写入的最终转写 ID；需要与 participantId 匹配。 |
| `affectObservationIds` | 是 | UUID[]<br>至少 0 项；至多 30 项；元素唯一 | 用于融合本人情绪的观察；同人、同时间段、同意仍有效。可为空。 |

<a id="dto-nodeupsert"></a>
### `NodeUpsert`

创建或更新一个节点；不得直接提交 status/readinessScore。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | UUID | 已有节点 ID，或由可信 Worker 为新节点预分配 UUID。 |
| `parentNodeId` | 是 | UUID / null | 同房间父节点，支持引用同一批中新建节点；必须验证无环。 |
| `topic` | 是 | string<br>最短 1 字符；最长 200 字符 | 节点讨论主题。 |
| `summary` | 是 | string / null<br>非空分支：最长 4000 字符 | 截至当前的共享讨论摘要，只含可公开内容。 |
| `contentionScore` | 是 | number<br>≥ 0；≤ 1 | 节点整体冲突／对抗程度，0～1；不是某个人的情绪。 |
| `discussionLoopCount` | 是 | integer<br>≥ 0 | 自上次恢复后识别的无效重复讨论次数。 |
| `participantStates` | 是 | [`ParticipantStateDraft`](#dto-participantstatedraft)[]<br>至少 0 项；至多 12 项 | 本次确实需要变更的各人状态；不同成员不能互相覆盖。 |

<a id="dto-isolationackitem"></a>
### `IsolationAckItem`

Worker 执行 LiveKit RemoveParticipant 后的结果；不是用户自行声称已静音。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `participantId` | 是 | UUID | 计划中的目标。 |
| `revokeBeforeUnixSec` | 是 | integer<br>≥ 0 | 必须与计划保存的 cutoff 匹配。 |
| `succeeded` | 是 | boolean | 成功执行撤销、移除并检查目标不再发布公共音视频。 |
| `errorCode` | 是 | string / null<br>非空分支：最长 100 字符 | 失败时安全错误码；成功为 null。 |

## 5. 相关文件与依据

- [frontend-api.md](frontend-api.md)：19 个浏览器业务接口。
- [internal-api.md](internal-api.md)：8 个服务间接口。
- [interact-api.md](interact-api.md)：前端调用、后端处理、音视频作用与更新回到 UI 的顺序。

原依据：`conflict_mitigator_api_contract_compact.md`（编号与接口职责）；`conflict_mitigator_openapi_v0.1.yaml`（完整字段与分支）；`conflict_mitigator_api_v0.1.md` §2、§5、§8、§12～14（既有业务约束）。原协议未选定 STT / 视觉模型供应商，不在拆分时补造供应商 endpoint。
