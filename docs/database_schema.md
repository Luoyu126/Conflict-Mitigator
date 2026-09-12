# Conflict Mitigator 数据库设计文档（MVP）

> Version: 0.1\
> Scope: Hackathon / MVP\
> Purpose: 为后续 API Contract、Supabase Schema、Meeting Agent、Private Mediation Agent 的实现提供统一的数据模型。

---

## 1. 设计目标

Conflict Mitigator 的核心流程是：

```text
Live Meeting
    ↓
Shared Mind Map 持续更新
    ↓
某个 Node 进入 heated
    ↓
Private Mediation
    ↓
参与者分别与自己的 Agent 私聊
    ↓
结构化状态逐渐收敛
    ↓
Node ready_to_resume
    ↓
生成 Shared Summary
    ↓
Return to Meeting
    ↓
Node 回到 normal
```

数据库需要支持以下能力：

1. 管理一次多人会议及其参与者。
2. 保存 speaker-attributed transcript。
3. 维护实时 Shared Mind Map。
4. 维护每个参与者在每个 Node 上的结构化观点。
5. 支持节点级冲突状态与 mediation 状态切换。
6. 保存 Private Mediation 原始聊天，同时与共享状态严格隔离。
7. 支持 readiness 计算与 Return to Meeting。
8. 允许同一个 Node 多次进入 mediation。

---

# 2. 核心数据关系

MVP 建议使用以下 7 张核心表：

```text
rooms
│
├──────── participants
│
├──────── transcript_segments
│
└──────── mind_map_nodes
              │
              ├──────── participant_node_states
              │
              └──────── mediation_sessions
                             │
                             └──────── private_messages
```

各表职责：

| 表 | 核心职责 |
|---|---|
| `rooms` | 一次完整会议 |
| `participants` | 会议中的参与者 |
| `transcript_segments` | Live Meeting 的 speaker-attributed transcript |
| `mind_map_nodes` | Shared Mind Map 中的讨论节点 |
| `participant_node_states` | 某个参与者在某个 Node 上的结构化状态 |
| `mediation_sessions` | 针对某个 Node 的一次 Private Mediation |
| `private_messages` | 某位参与者与自己 Private Agent 的私聊原文 |

---

# 3. `rooms`

表示一次完整会议。

## 3.1 TypeScript 模型

```ts
type RoomStatus =
  | "lobby"
  | "meeting"
  | "mediation"
  | "ended"

type Room = {
  id: string
  title: string
  status: RoomStatus
  createdAt: string
  updatedAt: string
}
```

## 3.2 数据库字段

```text
rooms
--------------------------------
id              uuid primary key
title           text
status          text
created_at      timestamptz
updated_at      timestamptz
```

## 3.3 字段说明

### `id`

会议唯一 ID。

例如：

```text
room_123
```

主要用途：

- 页面路由：`/room/[roomId]`
- 关联 participants
- 关联 transcript
- 关联 mind map nodes
- 关联 mediation sessions

---

### `title`

会议标题。

例如：

```text
HackCMU Product Discussion
```

主要用于：

- Homepage / Lobby
- Meeting Header
- 会议列表或邀请信息

---

### `status`

表示整个 Room 当前所处阶段：

```text
lobby
  ↓
meeting
  ↓
mediation
  ↓
meeting
  ↓
ended
```

含义：

- `lobby`：会议尚未正式开始或用户处于会前准备阶段
- `meeting`：正常多人会议阶段
- `mediation`：当前有节点处于 Private Mediation 阶段
- `ended`：会议已结束

注意：

```text
Room.status
```

描述的是**整个会议当前处于哪个阶段**。

它与：

```text
MindMapNode.status
```

不是同一个概念。

---

# 4. `participants`

表示某个 Room 中的一名参与者。

## 4.1 TypeScript 模型

```ts
type ParticipantRole =
  | "host"
  | "participant"

type ParticipantStatus =
  | "active"
  | "left"

type Participant = {
  id: string
  roomId: string

  displayName: string

  role: ParticipantRole
  status: ParticipantStatus

  livekitIdentity: string | null

  joinedAt: string
  leftAt: string | null
}
```

## 4.2 数据库字段

```text
participants
--------------------------------
id                  uuid primary key
room_id             uuid references rooms(id)

display_name        text
role                text
status              text

livekit_identity    text

joined_at           timestamptz
left_at             timestamptz nullable
```

## 4.3 字段说明

### `room_id`

表示该参与者属于哪个会议。

---

### `display_name`

用户在 Lobby 输入的显示名称。

例如：

```text
Yunyi
Alex
```

---

### `role`

当前 MVP 可以简单区分：

```text
host
participant
```

后续可用于：

- 是否允许结束会议
- 是否允许某些全局操作

---

### `status`

当前参与者是否仍在会议内。

```text
active
left
```

---

### `livekit_identity`

用于将数据库 participant 与 LiveKit participant 对齐。

推荐尽量保持：

```text
livekit_identity ≈ participant.id
```

或使用一个稳定、唯一的映射。

它的关键用途：

```text
LiveKit speaker
        ↓
participant
        ↓
transcript attribution
        ↓
Meeting Agent 知道是谁在说话
```

---

# 5. `transcript_segments`

存储 Live Meeting 中持续产生的 speaker-attributed transcript。

## 5.1 TypeScript 模型

```ts
type TranscriptSegment = {
  id: string
  roomId: string

  participantId: string

  content: string

  startedAtMs: number | null
  endedAtMs: number | null

  isFinal: boolean

  createdAt: string
}
```

## 5.2 数据库字段

```text
transcript_segments
--------------------------------
id                  uuid primary key
room_id             uuid references rooms(id)
participant_id      uuid references participants(id)

content             text

started_at_ms       bigint nullable
ended_at_ms         bigint nullable

is_final            boolean

created_at          timestamptz
```

## 5.3 业务用途

例如 STT 得到：

```text
Alex:
"I don't think we can finish this feature by Sunday."
```

数据库保存：

```json
{
  "participantId": "alex_id",
  "content": "I don't think we can finish this feature by Sunday."
}
```

然后进入核心链路：

```text
TranscriptSegment
      ↓
Meeting Agent
      ↓
判断当前在讨论哪个 Node
      ↓
更新 ParticipantNodeState
      ↓
更新 Node.summary
      ↓
更新 Node.contentionScore
```

因此：

> `transcript_segments` 是 Meeting Agent 理解实时会议的原始文本输入。

---

# 6. `mind_map_nodes`

这是系统最核心的表。

一个 record 表示 Shared Mind Map 中的一个 discussion topic / issue。

## 6.1 TypeScript 模型

```ts
type NodeStatus =
  | "normal"
  | "heated"
  | "private_mediation"
  | "ready_to_resume"

type MindMapNode = {
  id: string
  roomId: string

  parentNodeId: string | null

  topic: string
  summary: string | null

  status: NodeStatus

  contentionScore: number

  readinessScore: number | null

  discussionLoopCount: number

  createdAt: string
  updatedAt: string
}
```

## 6.2 数据库字段

```text
mind_map_nodes
--------------------------------
id                      uuid primary key
room_id                 uuid references rooms(id)

parent_node_id          uuid references mind_map_nodes(id)
                        nullable

topic                   text
summary                 text nullable

status                  text

contention_score        float
readiness_score         float nullable

discussion_loop_count   integer

created_at              timestamptz
updated_at              timestamptz
```

---

## 6.3 `parent_node_id`

用于构建 Mind Map 的树结构。

例如：

```text
HackCMU Project
├── Feature X
│   ├── Scope
│   └── Deadline
└── Database
```

可表示为：

```text
Feature X.parent_node_id = HackCMU Project.id

Scope.parent_node_id = Feature X.id
Deadline.parent_node_id = Feature X.id
```

MVP 阶段不需要额外设计 `edges` 表。

---

## 6.4 `topic`

表示这个 Node 当前在讨论什么。

例如：

```text
Should Feature X be included in the MVP?
```

它通常用于：

- Mind Map 节点标题
- Private Mediation Header
- Meeting Agent 的讨论定位

---

## 6.5 `summary`

表示当前 Node 的讨论摘要。

例如：

```text
Yunyi wants to retain Feature X for product differentiation,
while Alex is concerned about implementation time.
```

由 Meeting Agent 根据新 transcript 持续更新。

---

## 6.6 `status`

节点状态统一为：

```text
normal
  ↓
heated
  ↓
private_mediation
  ↓
ready_to_resume
  ↓
normal
```

### `normal`

当前节点处于正常讨论状态。

---

### `heated`

系统认为该节点的冲突程度已经显著上升。

前端可以表现为：

```text
Feature X 🔥
```

并出现：

```text
AI suggests private mediation
```

---

### `private_mediation`

当前节点已经进入小黑屋阶段。

相关参与者分别与自己的 Private Agent 进行文本交流。

---

### `ready_to_resume`

系统认为当前节点已经具备恢复公开讨论的条件。

前端可以显示：

```text
Ready to return to meeting
```

并展示 Shared Summary。

---

### Resume 后

Resume 之后：

```text
ready_to_resume
      ↓
normal
```

不设计 `resolved` 状态。

原因：

> AI 的职责是帮助参与者恢复到可以继续正常交流的状态，而不是替用户宣布问题已经被“解决”。

---

# 7. `contention_score`

## 7.1 定义

```ts
contentionScore: number // 0 ~ 1
```

表示：

> 当前这个 Node 整体的冲突 / 对抗程度。

它是 **Node-level** 指标，而不是某一个参与者的状态。

---

## 7.2 示例

```text
0.15
→ 普通讨论

0.50
→ 明显分歧

0.82
→ 高冲突

0.95
→ 极强对抗
```

---

## 7.3 可能输入

MVP 中可以综合：

```text
participant disagreement
+
emotion intensity
+
discussion repetition
+
language intensity
```

后续具体公式可以再定义。

---

## 7.4 和 `emotionIntensity` 的区别

例如：

```text
emotionIntensity = 0.2
contentionScore = 0.8
```

也是合理的。

含义是：

> 大家虽然语气很冷静，但立场高度冲突。

因此：

```text
emotionIntensity
= 某个人在该议题上的情绪激烈程度

contentionScore
= 整个议题当前的冲突程度
```

---

## 7.5 业务逻辑

```text
contentionScore 上升
        ↓
超过 threshold
        ↓
node.status = heated
        ↓
Meeting UI 显示 🔥
        ↓
系统建议 Private Mediation
```

---

# 8. `discussion_loop_count`

## 8.1 定义

```ts
discussionLoopCount: number
```

表示：

> 参与者是否围绕同一个问题反复争论，但没有产生新的有效信息。

例如：

```text
A: We do not have enough time.
B: But this feature is important.
A: We still do not have enough time.
B: But it is the key feature.
...
```

Meeting Agent 可以判断出现无效重复，并增加：

```text
discussion_loop_count
```

它可以作为：

```text
contentionScore
```

的输入之一。

---

# 9. `readiness_score`

## 9.1 定义

```ts
readinessScore: number | null // 0 ~ 1
```

表示：

> 当前 Node 是否已经适合返回多人公开会议继续讨论。

正常阶段可以：

```text
readiness_score = null
```

进入 mediation 后开始计算。

---

## 9.2 可能输入

MVP 中建议考虑：

```text
emotion stability
mutual understanding
clarity of concerns
compromise space
```

其中很多信息来自：

```text
participant_node_states
```

---

## 9.3 业务逻辑

```text
Private Mediation
      ↓
Private Agent 持续更新 ParticipantNodeState
      ↓
readinessScore 逐渐变化
      ↓
readinessScore > threshold
      ↓
node.status = ready_to_resume
      ↓
生成 shared summary
      ↓
显示 Return to Meeting
```

---

# 10. `participant_node_states`

这是整个系统中第二核心的数据表。

它回答：

> 某一个参与者在某一个 Node 上，目前到底是怎么想的？

## 10.1 TypeScript 模型

```ts
type ViewOfOther = {
  participantId: string
  interpretation: string
}

type ParticipantNodeState = {
  id: string

  nodeId: string
  participantId: string

  position: string | null

  supportingReasons: string[]

  underlyingConcerns: string[]

  emotionIntensity: number | null

  viewOfOthers: ViewOfOther[]

  acceptableCompromises: string[]

  updatedAt: string
}
```

## 10.2 数据库字段

```text
participant_node_states
--------------------------------
id                      uuid primary key

node_id                 uuid references mind_map_nodes(id)
participant_id          uuid references participants(id)

position                text nullable

supporting_reasons      jsonb
underlying_concerns     jsonb

emotion_intensity       float nullable

view_of_others          jsonb

acceptable_compromises  jsonb

updated_at              timestamptz
```

建议增加：

```text
UNIQUE(node_id, participant_id)
```

因为：

> 一个参与者在一个 Node 上只有一份“当前结构化状态”。

---

# 11. `position`

表示：

> 这个参与者当前主张什么。

例如：

```text
Keep Feature X
```

或者：

```text
Remove Feature X from MVP
```

它是：

```text
结论 / 立场
```

---

# 12. `supporting_reasons`

表示：

> 为什么这个参与者支持自己的 position。

例如：

```json
[
  "Feature X differentiates the product",
  "It is central to the demo concept"
]
```

它更接近：

```text
论据 / rationale
```

---

# 13. `underlying_concerns`

表示：

> 这个参与者底层真正关心、担心或想保护的东西。

例如：

```json
[
  "The demo may become too generic",
  "The product may lose differentiation"
]
```

区别：

```text
Position
= 我主张怎么做

Supporting Reason
= 为什么我认为应该这么做

Underlying Concern
= 我真正想保护 / 害怕失去的东西
```

这对 Private Mediation 很重要。

例如：

```text
A.position
= Keep Feature X

B.position
= Remove Feature X
```

表面上冲突。

但：

```text
A.concern
= Product differentiation

B.concern
= Delivery deadline
```

Agent 就可能找到：

```text
Keep a simplified version
```

这样的 common ground。

---

# 14. `emotion_intensity`

## 14.1 定义

```ts
emotionIntensity: number | null // 0 ~ 1
```

表示：

> 某一个参与者在讨论某一个具体 Node 时的情绪强度。

不是：

```text
Yunyi is angry
```

而是：

```text
Yunyi 在讨论 Feature X 时
emotionIntensity = 0.79
```

---

## 14.2 业务用途

它可以影响：

```text
Node.contentionScore
```

以及：

```text
Node.readinessScore
```

例如：

```text
emotionIntensity 持续下降
       ↓
emotion stability 提升
       ↓
readinessScore 上升
```

---

# 15. `view_of_others`

## 15.1 定义

```ts
viewOfOthers: {
  participantId: string
  interpretation: string
}[]
```

表示：

> 当前参与者是怎么理解其他参与者的。

例如 Yunyi 对 Alex：

```json
[
  {
    "participantId": "alex_id",
    "interpretation":
      "Alex mainly wants to remove Feature X because he is worried about the implementation deadline."
  }
]
```

---

## 15.2 与对方真实状态的区别

Alex 自己真实表达出来的内容存在：

```text
Alex.participant_node_state
```

例如：

```text
Alex.underlyingConcerns
```

而：

```text
Yunyi.viewOfOthers[Alex]
```

表示：

```text
Yunyi 当前如何理解 Alex
```

因此两者可以不同。

Private Agent 的一个关键目标就是让：

```text
viewOfOthers
```

逐渐更准确。

---

# 16. `acceptable_compromises`

## 16.1 定义

```ts
acceptableCompromises: string[]
```

表示：

> 当前参与者愿意接受哪些折中方案 / 退让空间。

例如：

```json
[
  "Keep a simplified version for the demo",
  "Move the complete implementation to post-MVP"
]
```

---

## 16.2 与 `position` 的区别

例如：

```text
position
= I want to keep the full Feature X.
```

但：

```text
acceptableCompromises
= I can accept a simplified MVP version.
```

这两个信息必须分开。

---

## 16.3 业务用途

Return to Meeting 前，Agent 可以比较不同参与者的：

```text
acceptableCompromises
```

寻找：

```text
common ground
```

例如：

```text
A accepts:
Simplified Feature X

B accepts:
Feature X if implementation is limited

           ↓

possible common ground
```

---

# 17. `mediation_sessions`

表示：

> 针对某一个 Node 发起的一次 Private Mediation。

必须单独建表，因为同一个 Node 可能：

```text
第一次 heated
↓
mediation
↓
resume

过一段时间

再次 heated
↓
第二次 mediation
```

## 17.1 TypeScript 模型

```ts
type MediationSessionStatus =
  | "active"
  | "completed"

type MediationSession = {
  id: string

  roomId: string
  nodeId: string

  status: MediationSessionStatus

  triggerReason: string | null

  sharedSummary: string | null

  startedAt: string
  endedAt: string | null
}
```

## 17.2 数据库字段

```text
mediation_sessions
--------------------------------
id                  uuid primary key

room_id             uuid references rooms(id)
node_id             uuid references mind_map_nodes(id)

status              text

trigger_reason      text nullable

shared_summary      text nullable

started_at          timestamptz
ended_at            timestamptz nullable
```

---

# 18. `trigger_reason`

表示：

> 为什么系统认为这个 Node 值得进入 Private Mediation。

例如：

```text
High contention and repeated disagreement around implementation scope.
```

主要用途：

- UI 提示
- debug
- demo explanation
- 日后分析触发机制

---

# 19. `shared_summary`

表示：

> Return to Meeting 时可以公开给所有参与者看的简短 summary。

例如：

```text
Yunyi primarily wants to preserve product differentiation.
Alex is mainly concerned about the deadline.
Both are open to keeping a simplified MVP version.
```

它必须来自：

```text
结构化 ParticipantNodeState
```

而不是直接复制 PrivateMessage。

---

# 20. `private_messages`

表示：

> 某位参与者在某一次 Mediation Session 中，与自己的 Private Agent 之间的原始聊天。

## 20.1 TypeScript 模型

```ts
type PrivateMessageRole =
  | "user"
  | "assistant"

type PrivateMessage = {
  id: string

  mediationSessionId: string
  participantId: string

  role: PrivateMessageRole

  content: string

  createdAt: string
}
```

## 20.2 数据库字段

```text
private_messages
--------------------------------
id                      uuid primary key

mediation_session_id    uuid references mediation_sessions(id)
participant_id          uuid references participants(id)

role                    text
content                 text

created_at              timestamptz
```

---

# 21. PrivateMessage 的呈现方式

在 UI 上，它就是普通的私密聊天：

```text
┌────────────────────────────┐
│ Private Mediation          │
│ Feature X                  │
│                            │
│ You                        │
│ I think Alex doesn't care  │
│ about product quality.     │
│                            │
│ AI Agent                   │
│ It sounds like your main   │
│ concern is losing product  │
│ differentiation.           │
│                            │
│ [_______________________]  │
│                 [ Send ]   │
└────────────────────────────┘
```

---

# 22. PrivateMessage 与 Shared State 的关系

PrivateMessage 是：

```text
raw private data
```

例如：

```text
“I think Alex just doesn't care about quality.”
```

只有该 participant 自己能读取。

然后 Private Agent 从私聊中提取：

```text
position
supportingReasons
underlyingConcerns
viewOfOthers
acceptableCompromises
emotionIntensity
```

并更新：

```text
participant_node_states
```

数据流：

```text
PrivateMessage
      ↓
Private Agent 理解
      ↓
ParticipantNodeState
      ↓
结构化共享状态
      ↓
Shared Mind Map / Other Agents
```

绝对不能：

```text
PrivateMessage
      ↓
直接共享给其他参与者 ❌
```

---

# 23. 隐私边界

系统必须严格区分：

```text
Private raw conversation
```

与：

```text
Shared structured state
```

## Private

以下数据默认只属于：

```text
participant + 自己的 Private Agent
```

包括：

```text
private_messages.content
```

---

## Shared

可以被 Meeting Agent / 其他 Private Agents 用于理解讨论的，是结构化信息，例如：

```text
position
supportingReasons
underlyingConcerns
viewOfOthers
acceptableCompromises
emotionIntensity
```

但未来仍可进一步为每个字段设计：

```text
private
agent-shared
user-visible shared
```

更细的权限级别。

MVP 暂时先保持简单。

---

# 24. 完整业务交互逻辑

下面按用户真实使用过程说明各表如何参与。

---

## Step 1：创建会议

创建：

```text
rooms
```

例如：

```text
id = room_123
status = lobby
```

---

## Step 2：用户加入会议

创建：

```text
participants
```

Lobby 中输入：

```text
Yunyi
```

Join 后：

```text
participant.id
↓
livekit_identity
↓
加入 LiveKit
```

---

## Step 3：进入正式 Meeting

更新：

```text
room.status = meeting
```

LiveKit 开始承载多人音视频。

---

## Step 4：产生 Transcript

STT 持续写：

```text
transcript_segments
```

例如：

```text
Yunyi:
"We should keep Feature X."

Alex:
"We cannot finish it on time."
```

---

## Step 5：Meeting Agent 理解讨论

Meeting Agent 读取：

```text
recent transcript
+
existing mind map
+
participant state
```

然后：

```text
创建 / 更新 mind_map_nodes
```

以及：

```text
创建 / 更新 participant_node_states
```

例如：

```text
Node:
Feature X

Yunyi:
position = Keep Feature X

Alex:
position = Remove Feature X
```

---

## Step 6：持续更新冲突状态

Meeting Agent 持续更新：

```text
emotion_intensity
discussion_loop_count
contention_score
```

如果：

```text
contention_score > threshold
```

则：

```text
node.status
normal
↓
heated
```

Meeting 页面显示：

```text
Feature X 🔥
```

---

## Step 7：建议进入 Private Mediation

AI 提示：

```text
This discussion seems stuck.
Would you like to enter private mediation?
```

用户确认后：

创建：

```text
mediation_sessions
```

更新：

```text
room.status
meeting → mediation
```

以及：

```text
node.status
heated → private_mediation
```

然后前端进入：

```text
/room/[roomId]/mediation/[nodeId]
```

---

## Step 8：Private Agent Chat

每个参与者分别和自己的 Agent 私聊。

持续新增：

```text
private_messages
```

例如：

```text
Yunyi:
"I feel like Alex doesn't care about product quality."
```

---

## Step 9：Private Agent 更新结构化状态

Agent 从 PrivateMessage 中不断更新：

```text
participant_node_states
```

包括：

```text
position
supportingReasons
underlyingConcerns
emotionIntensity
viewOfOthers
acceptableCompromises
```

例如：

```text
Yunyi.position
= Keep Feature X

Yunyi.underlyingConcerns
= Preserve product differentiation

Yunyi.viewOfOthers[Alex]
= Alex is mainly worried about deadline

Yunyi.acceptableCompromises
= Keep a simplified version
```

---

## Step 10：计算 Readiness

系统基于最新的：

```text
ParticipantNodeStates
```

计算：

```text
node.readiness_score
```

例如：

```text
0.30
→ 继续 mediation

0.55
→ 有进展

0.82
→ 可以考虑恢复会议
```

---

## Step 11：Node Ready

如果：

```text
readinessScore > threshold
```

更新：

```text
node.status
private_mediation
↓
ready_to_resume
```

---

## Step 12：生成 Shared Summary

Agent 根据：

```text
participant_node_states
```

生成：

```text
mediation_sessions.shared_summary
```

例如：

```text
Yunyi is mainly concerned about preserving product differentiation.
Alex is mainly concerned about implementation time.
Both are open to a simplified MVP version.
```

注意：

```text
shared_summary
```

不能直接包含用户 PrivateMessage 原文。

---

## Step 13：Return to Meeting

用户确认 Return 后：

```text
room.status = meeting
```

```text
node.status = normal
```

```text
mediation_session.status = completed
```

```text
mediation_session.ended_at = now()
```

然后页面：

```text
/room/123/mediation/node456
        ↓
/room/123
```

继续正常多人会议。

---

# 25. 最终 MVP Schema 总览

```text
rooms
- id
- title
- status
- created_at
- updated_at


participants
- id
- room_id
- display_name
- role
- status
- livekit_identity
- joined_at
- left_at


transcript_segments
- id
- room_id
- participant_id
- content
- started_at_ms
- ended_at_ms
- is_final
- created_at


mind_map_nodes
- id
- room_id
- parent_node_id
- topic
- summary
- status
- contention_score
- readiness_score
- discussion_loop_count
- created_at
- updated_at


participant_node_states
- id
- node_id
- participant_id
- position
- supporting_reasons
- underlying_concerns
- emotion_intensity
- view_of_others
- acceptable_compromises
- updated_at


mediation_sessions
- id
- room_id
- node_id
- status
- trigger_reason
- shared_summary
- started_at
- ended_at


private_messages
- id
- mediation_session_id
- participant_id
- role
- content
- created_at
```

---

# 26. 推荐的下一步

在这套 Domain / Database Model 基本稳定后，下一步定义 API Contract。

每个 API 需要明确：

```text
Route
HTTP Method
Purpose

Request Params
Request Body

Response Body

Reads Which Tables
Writes Which Tables

Public / Private Fields
Authorization Rules
```

典型例子：

```text
GET /api/rooms/[roomId]/mind-map
```

需要决定：

```text
返回哪些 MindMapNode 字段
返回哪些 ParticipantNodeState 字段
哪些字段前端可见
哪些只允许 Agent 使用
```

因此后续 API 设计应该基于本数据库模型，而不是直接将数据库 row 原样暴露给前端。
