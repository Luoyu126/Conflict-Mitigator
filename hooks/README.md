# 前端 Hooks

放置轮询、设备和页面交互逻辑，按实际功能需要添加。
遵循 `docs/api/interact-api.md` 的轮询顺序、取消清理及逻辑 ID 重试规则。
浏览器通过业务 HTTP 接口取数据，不导入后端 services，不新增推送协议。

已实现 `use-meeting-audio.ts`：在 `MeetingAudio` 内读取 SDK 状态、开关麦克风、选择输入设备与断开媒体。
业务离会与媒体断开分别处理，详见 [语音接入说明](../docs/audio-integration.md)。

`use-room-realtime.ts` 订阅仅含失效通知的 `room_events` 与临时 Presence；收到事件后由页面重取已授权 HTTP API，不在广播中携带业务或私聊正文。

`use-speech-recognition.ts` 只暴露 Web Speech 的 final 结果；`use-transcript-publisher.ts`
把 final 文本作为可靠数据包发布到 `cm.transcript.final.v1`（数据包不带参与者身份）。
