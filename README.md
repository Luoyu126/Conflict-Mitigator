# Conflict Mitigator

多人会议与私密调解应用。前端设计、文案和布局以 `feature/frontend` 为主，后端来自开发快照的分批迁移；摄像头与 Face++、语音与 Hume 通过同一个 LiveKit 媒体连接接入。

已实现创建/加入/退出会议、公共转写和讨论图、逐人同意、私密调解聊天、版本化共识确认，以及本人情绪面板。真实会议使用 UUID 路由；`/room/demo` 保留设计演示数据。

摄像头、麦克风默认关闭。转写、结构化分析、视觉情绪、语音情绪分别征求同意。个人情绪结果仅本人和授权后端分析可见，不通过共享房间状态、Realtime 或讨论图向他人公开。视觉和语音分别展示，缺失或过期结果显示不可用；VAD 映射属于实验性估计。

## 本地运行

需要 Node.js 22.18+、PostgreSQL，以及 Supabase 匿名登录、LiveKit 和所需推理服务配置。浏览器设备权限需要 localhost 或 HTTPS。

```bash
npm ci
cp .env.example .env.local
```

填写 `.env.local`，不要提交密钥。开启 Supabase anonymous sign-in；浏览器只使用 `NEXT_PUBLIC_SUPABASE_*`。`DATABASE_URL` 必须指向同一业务数据库。按 [数据库说明](lib/db/README.md) 依次应用 001、002、003 迁移；应用启动不会自动修改数据库。

在两个终端分别启动：

```bash
npm run dev -- --webpack
```

```bash
npm run worker:check
npm run worker
```

Next.js 提供页面、业务 API 和受服务凭证保护的 API-27 图像推理入口。常驻 Worker 负责会议发现、租约、LiveKit 订阅、转写、情绪分析、媒体隔离及过期清理；必须单独运行，不能依赖短生命周期 HTTP 请求。`worker:check` 仅检查配置与原生模块加载，不连接数据库或供应商，也不验证密钥有效性。

`APP_ORIGIN` 指向 Next.js；`INFERENCE_ORIGIN` 默认相同。Worker 和 Next.js 必须使用一致的内部服务令牌、LiveKit 配置和数据库。生产环境请由进程管理器同时托管 web 与 Worker，并配置 LiveKit webhook 指向 `/api/webhooks/livekit`。

缺少 Hume、Face++ 或 Gemini 配置时，相应分析不可用。Gemini 在首次调用时验证所配置模型是否存在并支持生成，不会静默换模型。浏览器转写依赖支持对既有音轨进行识别的 Web Speech API；不支持时页面提示不可用，不创建额外麦克风或伪造转写。

## 验证

```bash
npm run lint
npm run typecheck
npm run test:media
npm run test:worker
npm run test:server
npm run test:http
npm run build -- --webpack
```

数据库测试必须设置指向已应用全部迁移的**独立测试数据库**的 `DATABASE_URL`；部分测试会在未设置时跳过。HTTP 测试启动本地 Next.js 和假身份服务，详见 [HTTP 测试说明](tests/http/README.md)。单元测试和浏览器模拟验收不代表真实供应商或双人音视频已经联调通过。

## 代码与契约

- `app/`、`hooks/`、`components/`：页面、浏览器生命周期与展示。
- `contracts/`、`services/`、`lib/db/`：数据契约、业务授权、事务与迁移。
- `lib/integrations/`、`worker/`：供应商适配及常驻媒体处理。
- [前端 API](docs/api/frontend-api.md)、[内部 API](docs/api/internal-api.md)、[交互流程](docs/api/interact-api.md)：业务基线。
- [多模态 v0.3](docs/api/multimodal-v0.3.md)：本次已确认的同意、数据访问、媒体隔离和情绪接口增量，覆盖旧文档中禁用摄像头等相关规定。
- [迁移计划与进度](docs/developer-snapshot-migration.md)：来源、分工和阶段记录。
