# Conflict Mitigator

AI 多人冲突调解会议系统，使用 Next.js App Router。

已确认的实现覆盖规则见
[`docs/api/decision-overrides-v0.2.md`](docs/api/decision-overrides-v0.2.md)；它与
`docs/api/` 的 v0.1 契约冲突时优先。`docs/requirements.pdf` 保留为历史 PRD。
本地和部署变量说明见 [`docs/configuration.md`](docs/configuration.md)；真实凭证只放在
被忽略的项目根目录 `.env.local` 或部署平台的 secret manager 中。

## 项目框架

```text
app/                         页面与 HTTP 入口
  _components/               首页专属组件
  room/[roomId]/             会议、Lobby、调解页面，各自带 _components/
  api/rooms/                 前端业务接口 API-01～19
  api/internal/rooms/        Worker 接口 API-20～25
  api/webhooks/livekit/      LiveKit webhook API-26
components/ui/               共享基础 UI
components/shared/           跨页面业务组件
services/                    仅服务端使用的业务逻辑
  rooms/                     会议
  participants/              参与者与同意设置
  transcripts/               公共转写
  mind-map/                  讨论图与节点
  mediation/                 调解生命周期
  private-chat/              本人私聊与 Agent 编排
  media/                     媒体控制与 Worker 生命周期
contracts/                   共享 DTO 与后续请求校验
hooks/                       前端轮询、设备和交互逻辑
lib/api/client.ts            浏览器请求封装入口（待实现）
lib/server/                  鉴权、响应、错误、幂等基础设施
lib/integrations/            服务端外部服务适配
lib/db/migrations/           SQL 迁移
lib/db/repositories/         数据访问与事务参与
```

浏览器通过 HTTP 调用 `app/api/**/route.ts`；路由直接导入 services，
services 调用 repositories 与 integrations。Server Component 也可在验证身份后直接调用 service。
服务端实现文件使用 `server-only`，浏览器请求入口使用 `client-only`；共享契约不依赖任一运行环境。

### 各层职责

| 目录 / 文件 | 负责什么 | 使用边界 |
|---|---|---|
| `app/` | 页面、布局与 URL 路由 | 保留首页、Lobby、会议、私密调解四个页面入口 |
| `app/**/_components/` | 对应页面专属组件 | 跨页面复用后再移入 `components/` |
| `app/api/` | 解析请求、校验输入、验证凭证、转换 HTTP 响应 | 按文档路径实现，业务权限与流程交给 services |
| `components/ui/` | 按钮、输入框、弹窗等基础展示 | 不包含后端业务逻辑 |
| `components/shared/` | 跨页面共享的业务展示组件 | 负责展示和交互，不直接访问数据库 |
| `services/` | 业务授权、状态转换、流程编排、幂等规则与事务边界 | 仅服务端运行；同进程直接 import 调用，无需内部 HTTP |
| `contracts/` | 前后端共享的请求、响应 DTO 与运行时校验 | 严格对应 API 文档，不直接公开数据库行；类型不替代运行时校验 |
| `hooks/` | 前端可复用的状态、副作用与生命周期逻辑 | 如会议轮询、设备预览、聊天状态；普通工具函数不必写成 Hook |
| `lib/api/client.ts` | 浏览器 HTTP 请求封装 | 后续处理 access token、响应和错误；不含服务端凭证 |
| `lib/server/` | 鉴权、响应、错误、requestId 与幂等公共机制 | 为路由与 services 提供服务端基础设施 |
| `lib/integrations/` | LiveKit、身份验证、模型等服务端外部服务适配 | 隔离供应商 SDK 与协议细节，业务决策留在 services |
| `lib/db/repositories/` | SQL 查询、数据库行映射与数据访问 | 接受 service 传入的连接或事务，跨表操作共用事务 |
| `lib/db/migrations/` | 数据库结构的版本化变更 | 后续使用新迁移，保留已有初始化迁移与数据 |
| `docs/` | 产品需求、数据库设计、API 契约和交互说明 | 实现前查阅；未解决的设计分歧需讨论 |
| `public/` | 静态图片等公开资源 | 文件可公开访问，不放私密数据 |

例如，会议状态轮询的预期调用链为：

```text
页面组件 → hooks/useRoomPolling → lib/api/client.ts
                                     ↓ HTTP GET /api/rooms/{roomId}
                               app/api/.../route.ts
                                     ↓ import 调用
                               services/rooms
                                     ↓
                               lib/db/repositories
```

`useRoomPolling` 是后续实现示例，当前尚未创建。Hook 负责轮询状态及卸载时清理，
client 负责发送 HTTP 请求，service 负责成员权限与业务数据处理，组件负责显示结果。

### 当前实现范围

当前是目录骨架：四个页面仍为占位页面；API 目录尚无 `route.ts`，不会提供业务接口。
已迁入经过 debug 通话验证的 LiveKit 语音基础能力：服务端 token 适配、`LiveKitConnection` DTO、
`MeetingAudio` 连接 / 播放组件和 `useMeetingAudio` 麦克风控制 Hook，详见 [语音接入说明](docs/audio-integration.md)。
正式入会 / 重连接口、业务鉴权、数据库连接与页面装配仍待实现；测试页面和无登录 token 接口不属于正式应用。
常驻媒体 Worker 和 API-27 推理服务独立运行，不在 Next.js 请求内启动。

开发前阅读 [前端 API](docs/api/frontend-api.md)、[内部 API](docs/api/internal-api.md)
和 [交互流程](docs/api/interact-api.md)。各目录 README 说明职责与边界。
数据库初始化与尚未落地的访问控制见 [数据库说明](lib/db/README.md)；
现有七表迁移尚未覆盖完整 API 所需的身份、逐人确认、版本和幂等增量。

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
