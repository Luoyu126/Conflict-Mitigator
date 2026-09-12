# frontend-api.md · 前端业务接口

> 契约版本：v0.1-proposed · 按业务拆分版 · 共 19 个 HTTP 操作（API-01～19）

> **已确认覆盖规则：** 实现时必须同时遵循
> [decision-overrides-v0.2.md](decision-overrides-v0.2.md)。发生冲突时 v0.2 优先。

只列页面需要调用的接口，以及渲染 / 表态 / 重试需要的字段。**包括初始化、自动轮询和历史查询，不限于用户点击。所有接口都由 Next.js 后端接收并实现。**

本文件不要求前端调用 Worker、推理或 webhook 接口；这些接口见 [internal-api.md](internal-api.md)。后端如何处理与媒体如何流动见 [interact-api.md](interact-api.md)。

**来源与边界：** 本次拆分沿用 `conflict_mitigator_api_contract_compact.md` 的 27 个操作；用配套 `conflict_mitigator_openapi_v0.1.yaml` 展开字段、嵌套类型、约束及所有成功状态，并用原完整 API 文档补充已有处理说明。未增加接口、未修改原文件、未执行服务联调。原规范中的身份 / 逐人确认 / 幂等 / 派生观察等数据库增量仍是设计前提，不代表迁移已完成。

**精简表格中的省略已按原 OpenAPI 展开：** API-14 的 200/202，API-17 的 200/201/202，API-23 的 200/201 均保留；不是本次新增的返回行为。

## 1. 通用 HTTP 约定

| 项目 | 约定 |
|---|---|
| 服务地址 | 本文件均使用 `APP_ORIGIN`。 |
| 路径 | `{roomId}` 等是替换参数；对应 Next.js 目录中的 `[roomId]`。 |
| JSON | 请求 / 响应使用 camelCase；DB 的 snake_case 不直接暴露。未标明允许额外字段的对象不接受任意附加字段。 |
| ID / 时间 | 业务 ID 是 UUID；绝对时间是 UTC ISO8601；`*AtMs` 的媒体时间相对 `room.mediaEpochAt`，不是 Unix 毫秒。 |
| 必填 / null | 必填表示字段必须存在；可空按类型中的 `null` 判断。`[]`、省略和 `null` 不能混用。 |
| 成功包装 | `{"data": <本接口 DTO>, "requestId": <UUID>}`；下文返回表只展开 `data`。204 无响应体。 |
| requestId | 每次 HTTP 请求的追踪 UUID；不作为用户身份、幂等 ID 或消息 ID。 |
| 缓存 | 业务数据、token、私聊响应使用 `Cache-Control: no-store`。 |
| 重试 | 原请求被重试时保持相同逻辑 ID；状态 / 版本冲突先读当前状态，不无限重复旧请求。 |

认证统一使用 `Authorization: Bearer <Supabase access_token>`；原设计允许匿名登录建立认证会话，不额外增加登录页面。`displayName / participantId / roomId` 都不是认证凭证。本人身份由服务端验证后的 subject 确定。

标有 `Idempotency-Key` 的命令必须发送 UUID Header，同一逻辑命令重试沿用；相同 key + 不同 body 返回 409。私聊发送改用 `clientMessageId`，不另加该 Header。普通媒体重连使用 API-05，不重复创建成员。

应用 JSON 请求上限沿用原规范建议：64KiB。

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
| 首页与会前准备 | [API-01](#api-01) | `POST /api/rooms` | 创建会议 |
| 首页与会前准备 | [API-02](#api-02) | `GET /api/rooms/{roomId}/lobby` | 读取会前最小信息 |
| 首页与会前准备 | [API-04](#api-04) | `POST /api/rooms/{roomId}/join` | 创建／恢复本人参与记录并签发媒体 token |
| 会议状态、设备连接与退出 | [API-03](#api-03) | `GET /api/rooms/{roomId}` | 读取会议页基础状态 |
| 会议状态、设备连接与退出 | [API-05](#api-05) | `POST /api/rooms/{roomId}/livekit-token` | 为本人媒体重连签发新 token |
| 会议状态、设备连接与退出 | [API-06](#api-06) | `PATCH /api/rooms/{roomId}/me/consents` | 更新本人分析同意 |
| 会议状态、设备连接与退出 | [API-07](#api-07) | `POST /api/rooms/{roomId}/leave` | 本人离开会议 |
| 会议状态、设备连接与退出 | [API-08](#api-08) | `POST /api/rooms/{roomId}/end` | 主持人结束整个会议 |
| 转写与共享讨论图 | [API-09](#api-09) | `GET /api/rooms/{roomId}/transcripts` | 获取公共会议转写窗口 |
| 转写与共享讨论图 | [API-10](#api-10) | `GET /api/rooms/{roomId}/mind-map` | 获取共享讨论图快照 |
| 转写与共享讨论图 | [API-11](#api-11) | `GET /api/rooms/{roomId}/nodes/{nodeId}` | 获取单一议题详情 |
| 发起调解与进入确认 | [API-12](#api-12) | `GET /api/rooms/{roomId}/nodes/{nodeId}/mediation` | 从节点解析当前／最近调解轮次 |
| 发起调解与进入确认 | [API-13](#api-13) | `POST /api/rooms/{roomId}/nodes/{nodeId}/mediation` | 提出节点级调解并冻结名单 |
| 发起调解与进入确认 | [API-14](#api-14) | `POST /api/rooms/{roomId}/mediations/{sessionId}/acceptance` | 本人接受／拒绝进入本轮 |
| 本人私聊与恢复会议 | [API-15](#api-15) | `GET /api/rooms/{roomId}/mediations/{sessionId}/me` | 初始化本人的私密调解页面 |
| 本人私聊与恢复会议 | [API-16](#api-16) | `GET /api/rooms/{roomId}/mediations/{sessionId}/me/messages` | 读取本人本轮私聊历史 |
| 本人私聊与恢复会议 | [API-17](#api-17) | `POST /api/rooms/{roomId}/mediations/{sessionId}/me/messages` | 本人向私密 Agent 发消息 |
| 本人私聊与恢复会议 | [API-18](#api-18) | `POST /api/rooms/{roomId}/mediations/{sessionId}/resume` | 本人针对当前摘要确认恢复会议 |
| 本人私聊与恢复会议 | [API-19](#api-19) | `POST /api/rooms/{roomId}/mediations/{sessionId}/cancel` | 成员退出或主持人取消本轮调解 |

## 3. 接口字段与行为

### 首页与会前准备

<a id="api-01"></a>
### API-01 · 创建会议

`POST /api/rooms`

**何时调用：** 首页：用户点击创建会议。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| header | `Idempotency-Key` | 是 | UUID | 一次逻辑命令的 UUID；同请求重试保持一致，作用域为用户+方法+路径。 |

**请求体：** `application/json`；必须发送。类型 `CreateRoomRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `title` | 是 | string<br>最短 1 字符；最长 120 字符 | 会议名称；trim 后非空。 |

请求示例：
```json
{
  "title": "HackCMU Product Discussion"
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 201 | 创建成功。 | `CreateRoomData` |

`data: CreateRoomData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `room` | 是 | [`Room`](#dto-room) | rooms 的安全 API 投影；补充字段在迁移附录中明确列出。 |
| `lobbyPath` | 是 | string | 本应用会前准备页面相对路径。 |

**业务约束：** 记录 created_by=认证 subject，status=lobby。此时不创建虚假 participant，不连接摄像头，也不调用模型。创建者后续 join 时获得 host。创建后的 UI 前往 lobby。

**前端处理：** 读取 `data.room.id`，导航到 `data.lobbyPath`；此时尚未加入媒体房间。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 IDEMPOTENCY_CONFLICT`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms`；原 API 规范 API-01。

<a id="api-02"></a>
### API-02 · 读取会前最小信息

`GET /api/rooms/{roomId}/lobby`

**何时调用：** Lobby：页面初始化、读取标题和加入许可。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |

**请求体：** 无。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `LobbyData` |

`data: LobbyData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `roomId` | 是 | UUID | 目标房间。 |
| `title` | 是 | string | 会议标题。 |
| `status` | 是 | `"lobby"` / `"meeting"` / `"mediation"` / `"ended"` | 房间业务阶段。 |
| `participantCount` | 是 | integer<br>≥ 0 | active 业务成员数，不是精确网络在线数。 |
| `canJoin` | 是 | boolean | 根据会议是否结束、人数及本人是否被隔离推导的加入许可；最终以 join 校验为准。 |
| `myParticipantId` | 是 | UUID / null | 已有当前认证用户的参与记录则返回 ID。 |
| `consentNoticeVersion` | 是 | `"cm-privacy-v1"` | Lobby 要显示的同意告知版本。 |

**业务约束：** 本 MVP 将随机 UUID 邀请链接视为邀请凭证；已认证的持链者仅可看标题和人数。它不是生产级邀请 ACL。不能返回成员姓名、转写、图或私聊。

**前端处理：** 显示最小会议信息；记录 `consentNoticeVersion`。`canJoin` 只用于提示，最终以 API-04 校验为准。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`404 NOT_FOUND / ROOM_NOT_FOUND`。

**契约来源：** 原 OpenAPI 的 `get__api_rooms__roomId__lobby`；原 API 规范 API-02。

<a id="api-04"></a>
### API-04 · 创建／恢复本人参与记录并签发媒体 token

`POST /api/rooms/{roomId}/join`

**何时调用：** Lobby：用户确认姓名、同意设置并点击 Join。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| header | `Idempotency-Key` | 是 | UUID | 一次逻辑命令的 UUID；同请求重试保持一致，作用域为用户+方法+路径。 |

**请求体：** `application/json`；必须发送。类型 `JoinRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `displayName` | 是 | string<br>最短 1 字符；最长 40 字符 | 显示名称；不作为登录凭证。 |
| `consents` | 是 | [`Consents`](#dto-consents) | 本项目提出的同意记录；不是 LiveKit 的设备权限或 JWT grant。 |
| `consentNoticeVersion` | 是 | `"cm-privacy-v1"` | 用户看到并作出选择的告知版本。 |

请求示例：
```json
{
  "displayName": "Yunyi",
  "consents": {
    "transcription": true,
    "visualAffect": false,
    "structuredSharing": true
  },
  "consentNoticeVersion": "cm-privacy-v1"
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `JoinData` |

`data: JoinData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `room` | 是 | [`Room`](#dto-room) | rooms 的安全 API 投影；补充字段在迁移附录中明确列出。 |
| `me` | 是 | [`MyParticipant`](#dto-myparticipant) | 本人参与者信息与同意状态。 |
| `livekit` | 是 | [`LiveKitConnection`](#dto-livekitconnection) | 本项目签发的连接信息；字段包装是自定义的，不是 LiveKit HTTP 标准响应。 |
| `navigationPath` | 是 | string | 正式会议页面；并不自动开启麦克风。 |

**业务约束：** 以 (room_id,auth_user_id) 唯一键 upsert；服务端决定角色和 identity。房间初次 join 后置 meeting，不能把正在 mediation 的房间改回 meeting。若本人处于 starting/active 调解，本接口返回 MEDIA_ISOLATED。拒绝分析同意仍允许普通通话；部分 AI 能力相应缺失。ensureObserver 对房间只 dispatch 一次。返回凭证后由浏览器 room.connect，不自动启用麦克风。

**前端处理：** 使用 `livekit.serverUrl` 和 `livekit.participantToken` 连接 LiveKit，导航到 `navigationPath`；用户自行启用设备。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 IDEMPOTENCY_CONFLICT / ROOM_ENDED / ROOM_FULL / MEDIA_ISOLATED / CONSENT_NOTICE_OUTDATED`；`503 LIVEKIT_UNAVAILABLE`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms__roomId__join`；原 API 规范 API-04。

### 会议状态、设备连接与退出

<a id="api-03"></a>
### API-03 · 读取会议页基础状态

`GET /api/rooms/{roomId}`

**何时调用：** 会议页：初始化及状态轮询；不是只在点击时调用。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |

**请求体：** 无。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `RoomData` |

`data: RoomData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `room` | 是 | [`Room`](#dto-room) | rooms 的安全 API 投影；补充字段在迁移附录中明确列出。 |
| `participants` | 是 | [`Participant`](#dto-participant)[]<br>至少 0 项；至多 12 项 | 全部房间成员，包括 left，用于显示历史署名。 |
| `me` | 是 | [`MyParticipant`](#dto-myparticipant) | 本人参与者信息与同意状态。 |

**业务约束：** 必须存在本人房间成员记录；包括本人已离会后读取结束状态。网络 online/offline 由 LiveKit 客户端事件展示，不从 participants.status 推断实时在线。

**前端处理：** 更新参与者和 `room.observer`；`room.status` 是业务状态，媒体在线状态由 LiveKit 客户端事件提供。

**错误：** 通用错误表中的状态均适用。

**契约来源：** 原 OpenAPI 的 `get__api_rooms__roomId`；原 API 规范 API-03。

<a id="api-05"></a>
### API-05 · 为本人媒体重连签发新 token

`POST /api/rooms/{roomId}/livekit-token`

**何时调用：** 会议页：媒体重连，或结束调解后重新连接。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |

**请求体：** `application/json`；必须发送。类型 `EmptyBody`。

**空对象 `{}`**；本接口明确要求 JSON body，不是省略 body。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `TokenData` |

`data: TokenData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `livekit` | 是 | [`LiveKitConnection`](#dto-livekitconnection) | 本项目签发的连接信息；字段包装是自定义的，不是 LiveKit HTTP 标准响应。 |

**业务约束：** 仅 active 业务成员；拒绝 arbitrary participantId/roomName/grants。调解隔离期间返回 MEDIA_ISOLATED；显式撤销 cutoff 尚未过去时返回 TOKEN_NOT_YET_VALID。重新连接不新增 participant。

**前端处理：** 以返回的 `livekit` 重连；`MEDIA_ISOLATED` 时不重连，`TOKEN_NOT_YET_VALID` 时等待撤销截止条件消失再试。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 ROOM_ENDED / MEDIA_ISOLATED / TOKEN_NOT_YET_VALID`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms__roomId__livekit_token`；原 API 规范 API-05。

<a id="api-06"></a>
### API-06 · 更新本人分析同意

`PATCH /api/rooms/{roomId}/me/consents`

**何时调用：** 会议 / 调解界面：用户修改分析同意。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| header | `Idempotency-Key` | 是 | UUID | 一次逻辑命令的 UUID；同请求重试保持一致，作用域为用户+方法+路径。 |

**请求体：** `application/json`；必须发送。类型 `ConsentPatch`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `transcription` | 否 | boolean | 未来是否继续处理本人公共音频。 |
| `visualAffect` | 否 | boolean | v0.2 兼容字段，只允许 false；true 返回 409 FEATURE_DISABLED。 |
| `structuredSharing` | 否 | boolean | 未来是否继续从本人私聊提炼可共享信息；本轮为 false 会退出／取消本轮。 |

对象约束：至少提交 1 个字段。

请求示例：
```json
{
  "visualAffect": false
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `ConsentData` |

`data: ConsentData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `me` | 是 | [`MyParticipant`](#dto-myparticipant) | 本人参与者信息与同意状态。 |

**业务约束：** 至少一个字段。每次实际变化 revision+1。停止相应未来采样、STT 输入及结果入库；旧 consentRevision 的晚到结果丢弃。撤回不等于自动删除既有数据。structuredSharing=false 时取消本人所在轮次，不能继续私聊提取共享状态；不强制关闭普通视频通话。

**前端处理：** 用返回的 `me.consents / consentRevision` 更新 UI；撤回共享可能关闭本轮，重新读取调解状态。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 IDEMPOTENCY_CONFLICT / SESSION_STATE_CONFLICT`。

**契约来源：** 原 OpenAPI 的 `patch__api_rooms__roomId__me_consents`；原 API 规范 API-06。

<a id="api-07"></a>
### API-07 · 本人离开会议

`POST /api/rooms/{roomId}/leave`

**何时调用：** 会议 / 调解界面：用户主动离会。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| header | `Idempotency-Key` | 是 | UUID | 一次逻辑命令的 UUID；同请求重试保持一致，作用域为用户+方法+路径。 |

**请求体：** `application/json`；必须发送。类型 `EmptyBody`。

**空对象 `{}`**；本接口明确要求 JSON body，不是省略 body。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 202 | 业务请求已受理，文档指出的后续步骤尚未完成。 | `ExitData` |

`data: ExitData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `roomId` | 是 | UUID | 房间 ID。 |
| `roomStatus` | 是 | `"lobby"` / `"meeting"` / `"mediation"` / `"ended"` | 更新后的房间阶段。 |
| `participantStatus` | 是 | `"active"` / `"left"` | 当前请求者的业务成员状态。 |
| `mediaCleanup` | 是 | `"completed"` / `"pending"` | 服务端撤销媒体连接是否完成；pending 时须后台重试。 |
| `navigationPath` | 是 | `"/"` | 离开后的页面。 |

**业务约束：** 主动 leave 与 LiveKit 网络断开不同。立即禁止新媒体 token，然后服务端 RemoveParticipant 并撤销旧 token。前端停止本地 tracks 并断开；pending 由 Worker/服务端维护任务重试。一个人 leave 不等于 room ended。

**前端处理：** 停止本地轨道并断开媒体，导航到 `navigationPath`；`202` 或 `mediaCleanup=pending` 不表示外部清理已完成。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 IDEMPOTENCY_CONFLICT`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms__roomId__leave`；原 API 规范 API-07。

<a id="api-08"></a>
### API-08 · 主持人结束整个会议

`POST /api/rooms/{roomId}/end`

**何时调用：** 会议页：主持人点击结束整个会议。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| header | `Idempotency-Key` | 是 | UUID | 一次逻辑命令的 UUID；同请求重试保持一致，作用域为用户+方法+路径。 |

**请求体：** `application/json`；必须发送。类型 `EmptyBody`。

**空对象 `{}`**；本接口明确要求 JSON body，不是省略 body。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 202 | 业务请求已受理，文档指出的后续步骤尚未完成。 | `ExitData` |

`data: ExitData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `roomId` | 是 | UUID | 房间 ID。 |
| `roomStatus` | 是 | `"lobby"` / `"meeting"` / `"mediation"` / `"ended"` | 更新后的房间阶段。 |
| `participantStatus` | 是 | `"active"` / `"left"` | 当前请求者的业务成员状态。 |
| `mediaCleanup` | 是 | `"completed"` / `"pending"` | 服务端撤销媒体连接是否完成；pending 时须后台重试。 |
| `navigationPath` | 是 | `"/"` | 离开后的页面。 |

**业务约束：** 先提交业务终态并禁止一切新 join/token/写入，再撤销所有人 token、DeleteRoom、停止 dispatch。LiveKit 删除失败则保留待清理标记并重试。host 权限不授予读取他人 private_messages。

**前端处理：** 显示会议已结束并停止媒体；其余成员通过状态读取看到 `ended` 后退出。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`403 FORBIDDEN / HOST_REQUIRED`；`409 IDEMPOTENCY_CONFLICT`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms__roomId__end`；原 API 规范 API-08。

### 转写与共享讨论图

<a id="api-09"></a>
### API-09 · 获取公共会议转写窗口

`GET /api/rooms/{roomId}/transcripts`

**何时调用：** 会议页：初始化、自动刷新转写及向前翻页。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| query | `limit` | 否 | integer<br>≥ 1；≤ 200；缺省 100 | 一次最多返回数量；缺省 100。 |
| query | `before` | 否 | string | 上次 pageInfo.nextBeforeCursor；缺省查询最新窗口。 |

**请求体：** 无。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `TranscriptPage` |

`data: TranscriptPage`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `items` | 是 | [`TranscriptSegment`](#dto-transcriptsegment)[]<br>至少 0 项；至多 200 项 | 最新或指定历史窗口。 |
| `pageInfo` | 是 | [`PageInfo`](#dto-pageinfo) | 聊天／转写历史的反向翻页信息。 |

**业务约束：** 按照 created_at,id 选择最新／历史窗口，再按升序返回供渲染。同一 id 使用较高 revision 替换。MVP 每 1 秒重取最新窗口；若窗口超出一页，沿 before 补齐到本地最早已知 ID，不能只看最新一页而丢段。只有 final 用于共享图分析。

**前端处理：** 以 `id` 定位、较高 `revision` 替换；不要把 interim / final 当成两条新消息。`before` 用于补齐旧窗口。

**错误：** 通用错误表中的状态均适用。

**契约来源：** 原 OpenAPI 的 `get__api_rooms__roomId__transcripts`；原 API 规范 API-09。

<a id="api-10"></a>
### API-10 · 获取共享讨论图快照

`GET /api/rooms/{roomId}/mind-map`

**何时调用：** 会议页：初始化与共享图轮询。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |

**请求体：** 无。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `MindMapData` |

`data: MindMapData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `roomId` | 是 | UUID | 房间。 |
| `mapVersion` | 是 | integer<br>≥ 0 | 【补充】共享图版本，用于并发控制，不随每帧视频递增。 |
| `nodes` | 是 | [`MindMapNode`](#dto-mindmapnode)[]<br>至少 0 项；至多 500 项 | 所有当前节点。 |
| `participantStates` | 是 | [`PublicParticipantNodeState`](#dto-publicparticipantnodestate)[]<br>至少 0 项；至多 6000 项 | 已做公开安全投影的成员观点。 |

**业务约束：** 按 parentNodeId 绘图，不另建 edges。返回快照读的一致 mapVersion；最多 500 节点。无 private_messages、个人情绪评分、他人的 viewOfOthers。MVP 每 1 秒轮询，版本不变无需重绘。

**前端处理：** 按 `parentNodeId` 渲染树；`mapVersion` 不变无需重绘；heated 只显示建议，不自动让所有人进入私聊。

**错误：** 通用错误表中的状态均适用。

**契约来源：** 原 OpenAPI 的 `get__api_rooms__roomId__mind_map`；原 API 规范 API-10。

<a id="api-11"></a>
### API-11 · 获取单一议题详情

`GET /api/rooms/{roomId}/nodes/{nodeId}`

**何时调用：** 会议页：点击节点展开详情。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| path | `nodeId` | 是 | UUID | 此房间的讨论节点 UUID。 |

**请求体：** 无。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `NodeData` |

`data: NodeData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `node` | 是 | [`MindMapNode`](#dto-mindmapnode) | 共享讨论树节点。 |
| `participantStates` | 是 | [`PublicParticipantNodeState`](#dto-publicparticipantnodestate)[]<br>至少 0 项；至多 12 项 | 该节点其他参与者可见的结构化状态。 |
| `selfState` | 是 | [`ParticipantNodeState`](#dto-participantnodestate) / null | 当前用户在该节点的完整自身状态；未形成状态时为 null。 |
| `activeMediationSessionId` | 是 | UUID / null | 节点当前未关闭轮次；没有则为 null。 |

**业务约束：** nodeId 必须属于 path roomId。自我完整状态与他人的公开投影分开；不能通过换 participantId 读取他人私有内容。

**前端处理：** 公开观点与 `selfState` 分开展示；不对他人显示本人完整私有状态。

**错误：** 通用错误表中的状态均适用。

**契约来源：** 原 OpenAPI 的 `get__api_rooms__roomId__nodes__nodeId`；原 API 规范 API-11。

### 发起调解与进入确认

<a id="api-12"></a>
### API-12 · 从节点解析当前／最近调解轮次

`GET /api/rooms/{roomId}/nodes/{nodeId}/mediation`

**何时调用：** 节点详情 / 调解页：根据 nodeId 解析当前或最近 sessionId。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| path | `nodeId` | 是 | UUID | 此房间的讨论节点 UUID。 |

**请求体：** 无。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `MediationResolution` |

`data: MediationResolution`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `session` | 是 | [`MediationSession`](#dto-mediationsession) / null | 优先未关闭轮次，否则最近关闭轮次；从未调解为 null。 |
| `isMember` | 是 | boolean | 当前认证用户是否在该轮成员名单内。 |

**业务约束：** 页面 URL 仍使用 nodeId；所有消息、接受、恢复命令必须使用返回的 session.id，以免第二轮读写第一轮消息。没有轮次时 session=null。普通房间成员只能拿到公共状态，非本轮成员不能调用 /me。

**前端处理：** 从 `session.id` 得到后续命令使用的 sessionId；`session=null` 不发私聊请求，`isMember=false` 不访问本人调解接口。

**错误：** 通用错误表中的状态均适用。

**契约来源：** 原 OpenAPI 的 `get__api_rooms__roomId__nodes__nodeId__mediation`；原 API 规范 API-12。

<a id="api-13"></a>
### API-13 · 提出节点级调解并冻结名单

`POST /api/rooms/{roomId}/nodes/{nodeId}/mediation`

**何时调用：** 节点详情：本人发起一轮调解建议。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| path | `nodeId` | 是 | UUID | 此房间的讨论节点 UUID。 |
| header | `Idempotency-Key` | 是 | UUID | 一次逻辑命令的 UUID；同请求重试保持一致，作用域为用户+方法+路径。 |

**请求体：** `application/json`；必须发送。类型 `ProposeMediationRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `participantIds` | 是 | UUID[]<br>至少 2 项；至多 12 项；元素唯一 | 至少 2 人；必须包含本人，所有人属于此房间，不能重复。 |
| `reason` | 否 | string<br>最短 1 字符；最长 1000 字符 | 可选的公开发起理由；缺省时服务端从 heated 节点摘要生成。 |

请求示例：
```json
{
  "participantIds": [
    "550e8400-e29b-41d4-a716-446655440001",
    "550e8400-e29b-41d4-a716-446655440002"
  ],
  "reason": "围绕 Feature X 的讨论反复打转。"
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 201 | 创建成功。 | `SessionData` |

`data: SessionData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `session` | 是 | [`MediationSession`](#dto-mediationsession) | 一次节点级调解；proposed/starting/cancelled 是为了落实同意与失败恢复而提出的扩展。 |
| `node` | 是 | [`MindMapNode`](#dto-mindmapnode) | 共享讨论树节点。 |
| `roomStatus` | 是 | `"lobby"` / `"meeting"` / `"mediation"` / `"ended"` | 本次动作提交后房间状态。 |

**业务约束：** 要求 node=heated、至少 2 个本节点参与者且含调用者。本 MVP 同房间至多一个未关闭轮次。调用者此次发起只代表自己 accept，其余 pending；node 仍 heated、room 仍 meeting。提议 120 秒过期，维护任务取消；所有人接受之前不能强制导航进入可聊天状态。

**前端处理：** 展示 proposed 等待状态；发起成功仅表示本人 accept，不是所有人已经进入调解。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`403 FORBIDDEN / SHARING_CONSENT_REQUIRED`；`422 VALIDATION_ERROR / PARTICIPANT_NOT_ELIGIBLE`；`409 IDEMPOTENCY_CONFLICT / NODE_NOT_HEATED / MEDIATION_ALREADY_OPEN`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms__roomId__nodes__nodeId__mediation`；原 API 规范 API-13。

<a id="api-14"></a>
### API-14 · 本人接受／拒绝进入本轮

`POST /api/rooms/{roomId}/mediations/{sessionId}/acceptance`

**何时调用：** 相关成员：接受或拒绝进入这一轮调解。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| path | `sessionId` | 是 | UUID | 此房间的一次 mediation_sessions.id；不是 nodeId。 |
| header | `Idempotency-Key` | 是 | UUID | 一次逻辑命令的 UUID；同请求重试保持一致，作用域为用户+方法+路径。 |

**请求体：** `application/json`；必须发送。类型 `EntryDecisionRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `decision` | 是 | `"accept"` / `"decline"` | 接受或拒绝进入这一轮。 |

请求示例：
```json
{
  "decision": "accept"
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 已记录决定，未在此请求触发全员隔离；或既有成功结果。 | `SessionData` |
| 202 | 最后一名成员接受，进入 starting；媒体隔离仍待完成。 | `SessionData` |

`data: SessionData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `session` | 是 | [`MediationSession`](#dto-mediationsession) | 一次节点级调解；proposed/starting/cancelled 是为了落实同意与失败恢复而提出的扩展。 |
| `node` | 是 | [`MindMapNode`](#dto-mindmapnode) | 共享讨论树节点。 |
| `roomStatus` | 是 | `"lobby"` / `"meeting"` / `"mediation"` / `"ended"` | 本次动作提交后房间状态。 |

**业务约束：** 只能修改本人。任一 decline 则取消提议。全员 accept 后进入 starting，房间标记 mediation，媒体管理服务持久化隔离目标；此时 node 仍 heated、私聊禁止。全部媒体隔离确认后才 active + node.private_mediation。最后一个 accept 返回 202，其余 200；重复不会再次发起隔离。

**前端处理：** 检查返回的 `session.status`。`starting` 时停止本地公共媒体并显示隔离等待；只有后续 `active / chatAllowed=true` 才开放聊天。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 IDEMPOTENCY_CONFLICT / SESSION_STATE_CONFLICT / PROPOSAL_EXPIRED`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms__roomId__mediations__sessionId__acceptance`；原 API 规范 API-14。

### 本人私聊与恢复会议

<a id="api-15"></a>
### API-15 · 初始化本人的私密调解页面

`GET /api/rooms/{roomId}/mediations/{sessionId}/me`

**何时调用：** 调解页：初始化及刷新本人上下文、readiness 和轮次状态。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| path | `sessionId` | 是 | UUID | 此房间的一次 mediation_sessions.id；不是 nodeId。 |

**请求体：** 无。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `MediationMeData` |

`data: MediationMeData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `session` | 是 | [`MediationSession`](#dto-mediationsession) | 一次节点级调解；proposed/starting/cancelled 是为了落实同意与失败恢复而提出的扩展。 |
| `node` | 是 | [`MindMapNode`](#dto-mindmapnode) | 共享讨论树节点。 |
| `selfState` | 是 | [`ParticipantNodeState`](#dto-participantnodestate) / null | 本人结构化状态。 |
| `others` | 是 | [`PublicParticipantNodeState`](#dto-publicparticipantnodestate)[]<br>至少 0 项；至多 11 项 | 其他人的公开结构化观点，不返回其原始私聊／完整私有状态。 |
| `chatAllowed` | 是 | boolean | 仅 active 且本人仍同意 structuredSharing 时为 true。 |
| `canAcceptResume` | 是 | boolean | 节点 ready_to_resume 且存在有效 sharedSummary 时可接受恢复建议。 |
| `navigationPath` | 是 | string | 服务端建议的当前页面；关闭轮次则为 /room/{roomId}。 |
| `consensusTree` | 是 | [`ConsensusTree`](decision-overrides-v0.2.md#6-shared-consensus-tree) / null | 共享、带版本的隐私过滤共识树；生成前为 null。 |

**业务约束：** 不返回 private_messages，聊天另分页。非本轮成员即使是 host 也不可访问。completed/cancelled 返回 chatAllowed=false、navigationPath=/room/{roomId}，便于刷新/返回按钮处理。

**前端处理：** 以 `chatAllowed / canAcceptResume / navigationPath` 控制输入、恢复按钮和关闭轮次后的导航。

**错误：** 通用错误表中的状态均适用。

**契约来源：** 原 OpenAPI 的 `get__api_rooms__roomId__mediations__sessionId__me`；原 API 规范 API-15。

<a id="api-16"></a>
### API-16 · 读取本人本轮私聊历史

`GET /api/rooms/{roomId}/mediations/{sessionId}/me/messages`

**何时调用：** 调解页：加载历史、翻页、等待回复 / 同步消息。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| path | `sessionId` | 是 | UUID | 此房间的一次 mediation_sessions.id；不是 nodeId。 |
| query | `limit` | 否 | integer<br>≥ 1；≤ 200；缺省 100 | 一次最多返回数量；缺省 100。 |
| query | `before` | 否 | string | 上次 pageInfo.nextBeforeCursor；缺省查询最新窗口。 |

**请求体：** 无。

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `PrivateMessagePage` |

`data: PrivateMessagePage`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `items` | 是 | [`PrivateMessage`](#dto-privatemessage)[]<br>至少 0 项；至多 200 项 | 当前本人消息窗口；按 createdAt,id 升序。 |
| `pageInfo` | 是 | [`PageInfo`](#dto-pageinfo) | 聊天／转写历史的反向翻页信息。 |

**业务约束：** 强制 session_id 与 participant_id 双条件。已关闭轮次可由本人读取历史。该接口不能只用 room/node 过滤；不允许读取别人原文。

**前端处理：** 仅渲染自己的 messages；以消息 ID 合并，结合 `replyToMessageId / replyStatus` 关联回复与等待状态。

**错误：** 通用错误表中的状态均适用。

**契约来源：** 原 OpenAPI 的 `get__api_rooms__roomId__mediations__sessionId__me_messages`；原 API 规范 API-16。

<a id="api-17"></a>
### API-17 · 本人向私密 Agent 发消息

`POST /api/rooms/{roomId}/mediations/{sessionId}/me/messages`

**何时调用：** 调解页：本人发送一条私密消息或重试同一条消息。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| path | `sessionId` | 是 | UUID | 此房间的一次 mediation_sessions.id；不是 nodeId。 |

**请求体：** `application/json`；必须发送。类型 `SendMessageRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `clientMessageId` | 是 | UUID | 客户端为一次发送生成的 UUID；重试沿用同一个。 |
| `content` | 是 | string<br>最短 1 字符；最长 4000 字符 | 本人输入；trim 后 1～4000 字符。 |

请求示例：
```json
{
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440006",
  "content": "我最担心的是失去产品差异化。"
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 201 | 首次生成并保存 user + assistant，处理完成。 | `ChatCompletedData` |
| 200 | 同一 clientMessageId 的既有完成结果。 | `ChatCompletedData` |
| 202 | 同一 clientMessageId 已有请求正在执行；本请求不另启模型调用。 | `ChatPendingData` |

`data: ChatCompletedData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `userMessage` | 是 | [`PrivateMessage`](#dto-privatemessage) | 仅当前会话所有者与其 Agent 可见的聊天；participantId 对 assistant 消息也是用户所有者。 |
| `assistantMessage` | 是 | [`PrivateMessage`](#dto-privatemessage) | 仅当前会话所有者与其 Agent 可见的聊天；participantId 对 assistant 消息也是用户所有者。 |
| `selfState` | 是 | [`ParticipantNodeState`](#dto-participantnodestate) | 完整本人／授权 Agent 状态，沿用已讨论字段；没有 misunderstanding。 |
| `node` | 是 | [`MindMapNode`](#dto-mindmapnode) | 共享讨论树节点。 |
| `session` | 是 | [`MediationSession`](#dto-mediationsession) | 一次节点级调解；proposed/starting/cancelled 是为了落实同意与失败恢复而提出的扩展。 |
| `consensusTreeVersion` | 是 | integer<br>≥ 0 | API-17 完成时的最新共识树版本；生成前为 0。 |

`data: ChatPendingData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `userMessage` | 是 | [`PrivateMessage`](#dto-privatemessage) | 仅当前会话所有者与其 Agent 可见的聊天；participantId 对 assistant 消息也是用户所有者。 |
| `retryAfterMs` | 是 | integer<br>≥ 100 | 轮询本人 messages 或按相同 key 重试的间隔。 |
| `consensusTreeVersion` | 是 | integer<br>≥ 0 | 当前最新共识树版本；收到更高 Realtime 版本后重新读取 API-15。 |

**业务约束：** 仅 active 且本人同意共享。先按 clientMessageId 保存 user/pending，服务端只把本人私聊+节点上下文+他人可共享结构化观点送入模型。响应由模型生成，但写库必须结构校验与权限过滤；不能写他人状态。成功保存唯一 assistant 并置 completed 后返回 201；已完成重试返回 200；同 key 正在处理返回 202。服务端最长等待 25 秒，超时中止生成、user 标 failed 并返回 504（error.userMessageId）；不在请求结束后偷偷启动无持久队列的任务。修改结构化状态使旧 summary/确认失效；readiness/summary 可同步重新生成，版本冲突时在时限内重取最新状态再算；仍失败则保留聊天、维持未准备好状态，下一条有效消息再触发评估，不在请求结束后声称有任务继续运行。

**前端处理：** 首次完成为 201，完成请求的重试为 200；202 表示同一发送已有请求执行中，按 `retryAfterMs` 读 API-16；失败后同一消息重试保留 `clientMessageId`。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`403 FORBIDDEN / SHARING_CONSENT_REQUIRED`；`409 SESSION_NOT_ACTIVE / IDEMPOTENCY_CONFLICT / CHAT_BUSY`；`504 MODEL_TIMEOUT`；`503 MODEL_UNAVAILABLE`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms__roomId__mediations__sessionId__me_messages`；原 API 规范 API-17。

<a id="api-18"></a>
### API-18 · 本人针对当前摘要确认恢复会议

`POST /api/rooms/{roomId}/mediations/{sessionId}/resume`

**何时调用：** 调解页：本人接受当前版本的共同摘要，或选择继续等待。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| path | `sessionId` | 是 | UUID | 此房间的一次 mediation_sessions.id；不是 nodeId。 |
| header | `Idempotency-Key` | 是 | UUID | 一次逻辑命令的 UUID；同请求重试保持一致，作用域为用户+方法+路径。 |

**请求体：** `application/json`；必须发送。类型 `ResumeRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `decision` | 是 | `"accept"` / `"wait"` | accept 表示本人同意恢复；wait 表示还想继续沟通。 |
| `summaryVersion` | 是 | integer<br>≥ 1 | 本人实际看到的摘要版本；必须等于 session.summaryVersion。 |

请求示例：
```json
{
  "decision": "accept",
  "summaryVersion": 1
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `SessionData` |

`data: SessionData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `session` | 是 | [`MediationSession`](#dto-mediationsession) | 一次节点级调解；proposed/starting/cancelled 是为了落实同意与失败恢复而提出的扩展。 |
| `node` | 是 | [`MindMapNode`](#dto-mindmapnode) | 共享讨论树节点。 |
| `roomStatus` | 是 | `"lobby"` / `"meeting"` / `"mediation"` / `"ended"` | 本次动作提交后房间状态。 |

**业务约束：** 要求有效 sharedSummary、summaryVersion 匹配、node=ready_to_resume。accept 仅代表本人；wait 保持 active，不强迫恢复。全部成员接受同版本时在事务内关闭本轮：node.status=normal、readinessScore=null、loopCount=0，保留内容与最近 contentionScore 并设置重新检测冷却。前端回到 /room/{roomId}，再请求 /livekit-token 重连；摄像头/麦克风由本人重新启用。AI 分数只产生建议，不能替代确认。

**前端处理：** 只有 `session.status=completed` 才返回会议并调用 API-05；只是本人 accept 不代表所有人同意。摘要版本冲突时先重新读取 API-15。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 IDEMPOTENCY_CONFLICT / NOT_READY / SUMMARY_VERSION_CONFLICT / SESSION_STATE_CONFLICT`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms__roomId__mediations__sessionId__resume`；原 API 规范 API-18。

<a id="api-19"></a>
### API-19 · 成员退出或主持人取消本轮调解

`POST /api/rooms/{roomId}/mediations/{sessionId}/cancel`

**何时调用：** 调解页：本轮成员退出本轮，或主持人取消本轮。
**接收服务：** Next.js。所有这些入口仍由后端实现。
**认证：** `Authorization: Bearer <Supabase access_token>`。

**参数**

| 位置 | 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|---|
| path | `roomId` | 是 | UUID | 业务房间 UUID；不是 LiveKit Room SID。 |
| path | `sessionId` | 是 | UUID | 此房间的一次 mediation_sessions.id；不是 nodeId。 |
| header | `Idempotency-Key` | 是 | UUID | 一次逻辑命令的 UUID；同请求重试保持一致，作用域为用户+方法+路径。 |

**请求体：** `application/json`；必须发送。类型 `CancelRequest`。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `reason` | 否 | string<br>最短 1 字符；最长 500 字符 | 可选、安全的取消理由；不提交私聊原文。 |

请求示例：
```json
{
  "reason": "暂时不希望继续调解。"
}
```

**成功响应**

| HTTP | 含义 | `data` 类型 |
|---|---|---|
| 200 | 成功；重复幂等请求也可返回既有成功结果。 | `SessionData` |

`data: SessionData`（外层仍为 `{ data, requestId }`）：

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `session` | 是 | [`MediationSession`](#dto-mediationsession) | 一次节点级调解；proposed/starting/cancelled 是为了落实同意与失败恢复而提出的扩展。 |
| `node` | 是 | [`MindMapNode`](#dto-mindmapnode) | 共享讨论树节点。 |
| `roomStatus` | 是 | `"lobby"` / `"meeting"` / `"mediation"` / `"ended"` | 本次动作提交后房间状态。 |

**业务约束：** 不要求 readiness 达标，避免把人锁在小黑屋。取消不表示冲突解决。房间已 ended 时保持 ended。已开始的撤销操作可能仍完成，重连须使用新的 token 并遵守 cutoff；晚到 isolation ack 不得把 cancelled 变 active。

**前端处理：** 关闭本轮后依服务端状态返回会议；已经隔离的成员使用 API-05 取得新 token，不因分数不足被困住。

**错误：** 通用错误表中的状态均适用；另有 / 细化为：`409 IDEMPOTENCY_CONFLICT / SESSION_STATE_CONFLICT`。

**契约来源：** 原 OpenAPI 的 `post__api_rooms__roomId__mediations__sessionId__cancel`；原 API 规范 API-19。

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
| `visualAffect` | 是 | boolean | v0.2 兼容字段，固定为 false；当前产品不采集或分析摄像头画面。 |
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
| `activeMediationNodeId` | 是 | UUID / null | 【v0.2 派生】唯一未关闭调解关联节点；与 sessionId 原子变化。 |
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

<a id="dto-myparticipant"></a>
### `MyParticipant`

本人参与者信息与同意状态。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `participant` | 是 | [`Participant`](#dto-participant) | participants 的房间成员可见投影；不包含 auth_user_id。 |
| `consents` | 是 | [`Consents`](#dto-consents) | 本项目提出的同意记录；不是 LiveKit 的设备权限或 JWT grant。 |
| `consentRevision` | 是 | integer<br>≥ 1 | 【补充】同意设置单调版本；用于丢弃撤回后到达的旧媒体结果。 |
| `consentNoticeVersion` | 是 | `"cm-privacy-v1"` | 接受的告知文本版本；v0.1 固定 cm-privacy-v1。 |

<a id="dto-livekitconnection"></a>
### `LiveKitConnection`

本项目签发的连接信息；字段包装是自定义的，不是 LiveKit HTTP 标准响应。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `serverUrl` | 是 | string<br>正则 `^wss://` | LiveKit WSS 信令连接地址，传给 room.connect；不是音频或视频 URL。 |
| `participantToken` | 是 | string<br>最短 1 字符 | 服务端签发的 LiveKit JWT；仅供当前参与者连接，禁止记录到日志。 |
| `roomName` | 是 | string | LiveKit 房间名，本项目采用 cm_<rooms.id>。 |
| `participantIdentity` | 是 | string | JWT identity，与 participants.id 完全相同。 |
| `expiresAt` | 是 | UTC ISO8601 | 本次签发 token 的 exp 时间；不表示媒体连接到此时必然断开。 |

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

<a id="dto-publicparticipantnodestate"></a>
### `PublicParticipantNodeState`

【建议投影】其他参与者可见的安全结构化观点；不公开 viewOfOthers 和个人情绪评分。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | UUID | participant_node_states.id。 |
| `nodeId` | 是 | UUID | 对应讨论节点。 |
| `participantId` | 是 | UUID | 这份结构化状态的所有者。 |
| `position` | 是 | string / null<br>非空分支：最长 1000 字符 | 目前主张怎么做；尚未表达时为 null。 |
| `supportingReasons` | 是 | string[]<br>至少 0 项；至多 20 项；每项：最短 1 字符；最长 1000 字符 | 支持立场的理由；未提取到时为 []。 |
| `underlyingConcerns` | 是 | string[]<br>至少 0 项；至多 20 项；每项：最短 1 字符；最长 1000 字符 | 底层关注、担忧或希望保护的事物；未提取到时为 []。 |
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

<a id="dto-pageinfo"></a>
### `PageInfo`

聊天／转写历史的反向翻页信息。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `nextBeforeCursor` | 是 | string / null | 不透明游标；再次请求 before=<此值>，不能自行拼接。 |
| `hasMore` | 是 | boolean | 当前窗口之前是否还有更旧记录。 |

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

<a id="dto-privatemessage"></a>
### `PrivateMessage`

仅当前会话所有者与其 Agent 可见的聊天；participantId 对 assistant 消息也是用户所有者。

| 字段 | 必填 | 类型 / 约束 | 含义 |
|---|---|---|---|
| `id` | 是 | UUID | 消息 ID。 |
| `mediationSessionId` | 是 | UUID | 所属轮次。 |
| `participantId` | 是 | UUID | 私聊所有者，不代表 assistant 自己的身份。 |
| `role` | 是 | `"user"` / `"assistant"` | 只接受这两类已存消息；客户端不能自定义 assistant/system 角色。 |
| `content` | 是 | string<br>最短 1 字符；最长 12000 字符 | 聊天正文；禁止进入公共 transcript、房间 metadata 或共享实时广播。 |
| `clientMessageId` | 是 | UUID / null | 【补充】用户发送的幂等 ID；assistant 消息为 null。 |
| `replyToMessageId` | 是 | UUID / null | 【补充】assistant 回复的用户消息 ID；user 消息为 null。 |
| `replyStatus` | 是 | `"pending"` / `"completed"` / `"failed"` / null | 【补充】只对 user 消息有意义；assistant 为 null。 |
| `createdAt` | 是 | UTC ISO8601 | 服务端保存时间。 |

条件约束：`role=user` 时 `clientMessageId` 非空、`replyToMessageId=null`、`replyStatus` 非空；`role=assistant` 时 `clientMessageId=null`、`replyToMessageId` 非空、`replyStatus=null`。

## 5. 相关文件与依据

- [frontend-api.md](frontend-api.md)：19 个浏览器业务接口。
- [internal-api.md](internal-api.md)：8 个服务间接口。
- [interact-api.md](interact-api.md)：前端调用、后端处理、音视频作用与更新回到 UI 的顺序。

原依据：`conflict_mitigator_api_contract_compact.md`（编号与接口职责）；`conflict_mitigator_openapi_v0.1.yaml`（完整字段与分支）；`conflict_mitigator_api_v0.1.md` §2、§5、§8、§12～14（既有业务约束）。原协议未选定 STT / 视觉模型供应商，不在拆分时补造供应商 endpoint。
