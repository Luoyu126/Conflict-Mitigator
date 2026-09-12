# LiveKit 语音基础能力

从已完成双人实时通话验证的 debug 应用中提取，供正式业务层和页面使用。
此阶段迁移 SDK 适配与 React 媒体能力，不增加 HTTP 接口，不实现登录、数据库业务或 AI Worker。

## 服务端

`lib/integrations/livekit.ts` 使用 `server-only`，提供：

- `readLiveKitConfig()`：读取 `LIVEKIT_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`。
- `createLiveKitAudioConnection(input, config?)`：返回 `contracts/media.ts` 的 `LiveKitConnection`。

调用示意（在已完成业务校验的 service 中）：

```ts
import { createLiveKitAudioConnection } from "@/lib/integrations/livekit";

const livekit = await createLiveKitAudioConnection({
  roomId: room.id,
  participantId: participant.id,
  displayName: participant.displayName,
});
```

服务端必须先验证认证 subject 与本人参与记录、房间状态、调解隔离和 token cutoff，
并在首次签发时持久化 `mediaEpochAt`。这里验证 UUID 格式不等于验证身份或授权。
不能把浏览器提交的 participantId 直接交给签发函数。

房间名固定为 `cm_<roomId>`，identity 固定为已有的 `participant.id`，不会生成 debug 随机身份。
token 允许发布麦克风、订阅媒体，并仅在预留 topic `cm.transcript.final.v1` 上发送浏览器 final 转写数据包；不授予摄像头、屏幕分享、其他数据用途、管理或自行修改 metadata 的权限。
当前复用测试过的 600 秒 token 有效期，可由服务端调用方通过 `ttlSeconds` 配置；
DTO 的 `expiresAt` 从本次实际签发的 JWT exp 读取。有效期不是通话断开计时器。
签发过程不连接 LiveKit，也不会创建业务会议或参与记录。

## 浏览器

`components/shared/meeting-audio.tsx` 中的 `MeetingAudio` 封装官方
`LiveKitRoom`、`RoomAudioRenderer` 和 `StartAudio`，接收正式的 `LiveKitConnection`：

```tsx
<MeetingAudio
  connection={livekit}
  enabled={mediaAllowed}
  onError={handleMediaError}
  onMediaDeviceFailure={handleDeviceError}
>
  <YourMeetingControls />
</MeetingAudio>
```

页面根据正式入会 / 重连响应传入连接信息，根据业务阶段决定 `enabled`。
组件提供音频播放和浏览器播放许可按钮，进入房间时不会自动开启麦克风或摄像头。
默认使用单声道、回声消除、降噪、自动增益及官方 speech 编码预设。
`enabled=false`、清空连接信息或卸载组件会断开媒体并停止本地轨道；这不替代服务端媒体撤销。
更换房间或参与者会重新创建连接。token 只在内存中传递，不记录到日志或持久存储。
建议页面使用稳定的回调，避免频繁变化的 SDK 事件订阅。

浏览器 final 转写（v0.2）：

- `hooks/use-speech-recognition.ts` 使用 Web Speech API，`interimResults=false`，
  只对外暴露 final 结果；不支持或空结果被忽略，不提供预设/手写转写后备。
- `hooks/use-transcript-publisher.ts` 在 `MeetingAudio` 子组件内使用
  `useRoomContext()`，把 final 文本封装为 `contracts/transcript-packet.ts` 的
  数据包，通过可靠 `publishData` 发送到 `cm.transcript.final.v1`。数据包不携带
  参与者身份，由 Worker 信任 LiveKit sender identity（等于 `participants.id`）。

在其子组件内调用 `hooks/use-meeting-audio.ts` 的 `useMeetingAudio()`：

| 返回值 | 用途 |
|---|---|
| `connectionState` | SDK 当前连接状态，包括重连过程 |
| `isMicrophoneEnabled` / `microphoneTrack` | 当前麦克风开关与轨道 |
| `lastMicrophoneError` | SDK 报告的麦克风错误 |
| `setMicrophoneEnabled(boolean)` | 用户操作后开麦 / 静音 |
| `selectMicrophone(deviceId)` | 切换输入设备 |
| `startAudioPlayback()` | 用户点击后解锁声音播放 |
| `disconnectMedia()` | 断开媒体并停止本地轨道 |

异步操作保留 SDK 的失败结果，UI 需要 catch 并向用户提示。
`disconnectMedia()` 不会代替 API-07 离会或 API-08 结束会议，也不会更改数据库。

## 后续业务接入

正式 API-04 Join 和 API-05 livekit-token 仍待实现，继续遵循 `docs/api/`。
API-04 返回的 `data.livekit`、API-05 返回的 `data.livekit` 均使用这里的 DTO；
重连仍需服务端验证，不允许使用 debug 的无登录 `/api/token`。
API-04 的 Worker dispatch、同意记录及首次媒体时间轴等逻辑仍由业务服务实现。
当前四个页面保持原有状态，尚未装配这些底层模块。

## 验证

```bash
npm ci
npm run test:media
npm run lint
npm run build
```

媒体单元测试使用 Node.js 22.18+ 或 24 的原生 TypeScript 支持及 `react-server` 条件，
验证签发 token 的签名、身份、权限、有效期与配置错误，不使用真实密钥或连接外部媒体。
正式页面端到端验证需在完成业务接入后进行；debug 的实测成功不表示业务鉴权已完成。

官方参考：[React 连接组件](https://docs.livekit.io/reference/components/react/component/livekitroom/)、
[服务端 SDK](https://docs.livekit.io/reference/server-sdk-js/)。
