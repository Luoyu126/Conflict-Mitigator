# 服务端外部服务适配

后续放置 LiveKit 管理 SDK、Supabase 身份验证、模型调用等服务端适配。
已实现 `livekit.ts` 的语音 token 签发适配与服务端配置读取，使用方式和调用前提见 [语音接入说明](../../docs/audio-integration.md)。
业务决策由 services 负责，供应商 SDK、凭证和协议转换留在本层，每个实现文件导入 `server-only`。
常驻媒体 Worker 与 API-27 推理服务独立运行，不在这里启动长驻进程。
尚未选择的模型供应商和评分策略需要讨论后接入。
