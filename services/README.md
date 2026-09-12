# 后端业务层

业务调用链：Route Handler → service → repository / integration。
Server Component 在验证身份后也可以直接调用 service，无需向自身发送 HTTP 请求。

| 模块 | 职责 |
|---|---|
| rooms | 创建、读取、结束会议 |
| participants | 加入、退出、同意设置和本人参与记录 |
| transcripts | 公共转写读取与 Worker 提交处理 |
| mind-map | 图快照、节点、安全公开观点和分析更新 |
| mediation | 提议、逐人确认、隔离状态、摘要版本、恢复与取消 |
| private-chat | 本人本轮消息、Agent 调用和本人结构化状态更新 |
| media | token、Worker 生命周期、控制状态、隔离与清理编排、webhook 处理 |

服务负责业务授权、状态转换、幂等规则与事务边界，不依赖 HTTP Request/Response。
跨表操作共用事务；外部媒体调用不能假定与数据库事务原子完成。
私聊必须按当前认证主体与轮次过滤，公开输出使用契约允许的投影。

各模块 `index.ts` 目前仅建立服务端入口，没有业务实现。新增实现文件也必须导入 `server-only`，防止通过直接路径绕过入口边界。
